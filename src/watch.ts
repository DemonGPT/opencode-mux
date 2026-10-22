import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client";
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Layout, PaneCommand } from "./config.js";
import { childTitle, classifyEvent } from "./session.js";
import { childSessions, events } from "./server.js";
import type { PaneTracker, TrackerAction } from "./tracker.js";
import type { BorderStyles, Tmux } from "./tmux.js";
import { currentPane } from "./tmux.js";

export interface WatchDeps {
  client: OpenCodeClient;
  tmux: Tmux;
  tracker: PaneTracker;
  log: (line: string) => void;
  targetPane?: string;
  layout: Layout;
  mainPaneSize?: number;
  /**
   * Resolves the active theme's border styles. Applied at start and re-applied
   * on tick whenever the resolved styles change; null clears the styles.
   */
  themeStyles?: { current(): BorderStyles | null };
  parentID: string | null;
  /**
   * Directories this instance's TUI may run in. Only used when no explicit
   * parent is configured: a subagent is paned only when its parent session
   * belongs to one of these directories, so concurrent opencode-mux instances
   * on different projects never pane each other's subagents. Absent → watch
   * every child session (single-instance behaviour).
   */
  projectDirectories?: string[];
  paneArgv?: (sessionID: string) => string[];
  tickEveryMs: number;
  now?: () => number;
}

/** Resolves symlinks when possible so cwd and daemon-reported paths compare. */
function normalizeDirectory(path: string): string {
  let out: string;
  try {
    out = realpathSync(path);
  } catch {
    out = resolve(path);
  }
  return out.length > 1 && out.endsWith(sep) ? out.slice(0, -1) : out;
}

/**
 * True when both paths name the same project: equal, or one contains the other.
 * Containment covers opencode reporting the project root while the wrapper runs
 * in a subdirectory (and vice versa); component-aware so "/a/proj" and
 * "/a/proj-2" stay distinct.
 */
export function isSameProject(left: string, right: string): boolean {
  const a = normalizeDirectory(left);
  const b = normalizeDirectory(right);
  return a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
}

export interface Watcher {
  adopt(): Promise<void>;
  dispatch(event: OpenCodeEvent): Promise<void>;
  tick(now: number): Promise<void>;
  start(signal: AbortSignal): Promise<void>;
}

/**
 * Upstream workaround for opencode issue #50135: `opencode mini` keeps a
 * long-lived `session.wait` request open, but its client uses Bun's default
 * fetch idle timeout (300s), which aborts the request during long-running tool
 * calls — the pane then freezes/dies. Disabling the idle timeout is exactly
 * what the pending upstream fix (PR #50248) does, so this is harmless once it
 * ships. See https://github.com/anomalyco/opencode/issues/50135
 */
const MINI_IDLE_TIMEOUT_ENV = "BUN_CONFIG_HTTP_IDLE_TIMEOUT=0";

/**
 * Pane command: attach the child session in the new pane.
 *
 * `mini` is a real subcommand (`opencode mini -s <id>`, no tab bar / agent
 * switcher), launched through `env` to carry the idle-timeout workaround above.
 * The full TUI has **no** `tui` subcommand — `opencode tui -s <id>` makes
 * opencode parse `tui` as the optional directory argument and exit with
 * `ENOENT: chdir … -> 'tui'`, closing the pane instantly. The full TUI is
 * launched bare instead: `opencode -s <id>`.
 */
export function defaultPaneArgv(sessionID: string, paneCommand: PaneCommand = "mini"): string[] {
  const head = paneCommand === "mini" ? ["env", MINI_IDLE_TIMEOUT_ENV, "opencode", "mini"] : ["opencode"];
  return [...head, "-s", sessionID];
}

/**
 * Delay before the watcher subscribes again after the event stream ended or
 * failed. Fixed on purpose: a stream that fails instantly means the daemon is
 * gone, so a hot loop is what must be avoided — not a slow retry. The daemon
 * is reachable again within a second of a restart, so exponential backoff
 * would only delay the recovery that matters.
 */
const RECONNECT_DELAY_MS = 1000;

/** Resolves after `ms`, or right away when `signal` aborts (listener removed). */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref();
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Wires server events → tracker state machine → tmux actions. */
export function createWatcher(deps: WatchDeps): Watcher {
  const targetPane = deps.targetPane ?? currentPane(process.env);
  if (targetPane === null) {
    throw new Error("opencode-mux: watcher requires TMUX_PANE (run inside tmux)");
  }
  const paneArgv = deps.paneArgv ?? defaultPaneArgv;
  const now = deps.now ?? Date.now;
  const log = deps.log;

  /**
   * parent session id → does it belong to this instance's project? Cached per
   * parent (a session's directory rarely changes; `session.moved` invalidates
   * the entry). Lookups that fail are not cached, so a transient error does not
   * permanently hide a parent. Capped so a long-lived watcher cannot grow it
   * without bound.
   */
  const ownedParents = new Map<string, boolean>();
  const MAX_OWNED_PARENTS = 256;

  /**
   * Whether a subagent's parent session belongs to this instance. Always true
   * with an explicit parent (the id match already pins it) or without a scope.
   */
  const ownsParent = async (parentID: string): Promise<boolean> => {
    if (deps.parentID !== null || deps.projectDirectories === undefined) return true;
    const cached = ownedParents.get(parentID);
    if (cached !== undefined) return cached;
    try {
      const info = await deps.client.session.get({ sessionID: parentID });
      const owned = deps.projectDirectories.some((dir) => isSameProject(info.location.directory, dir));
      // Evict the oldest entry (Map insertion order) before inserting.
      while (ownedParents.size >= MAX_OWNED_PARENTS) {
        const oldest = ownedParents.keys().next();
        if (oldest.done === true) break;
        ownedParents.delete(oldest.value);
      }
      ownedParents.set(parentID, owned);
      return owned;
    } catch (error) {
      log(`scope lookup failed: ${parentID} — ${String(error)}`);
      return false;
    }
  };

  /**
   * Shared-window skips already logged, so a split storm in a window that
   * another instance owns does not spam the log. A skip is not a failure: the
   * pane exists, only the window geometry was left to the first instance.
   */
  const loggedSkips = new Set<string>();
  const logLayoutSkip = (reason: string): void => {
    if (loggedSkips.has(reason)) return;
    loggedSkips.add(reason);
    log(`layout skipped: ${reason}`);
  };

  const openPane = async (sessionID: string, title: string): Promise<string | null> => {
    const argv = paneArgv(sessionID);
    const result = await deps.tmux.splitPane({ targetPane, layout: deps.layout, mainPaneSize: deps.mainPaneSize, argv });
    if (!result.ok || result.paneId === null) {
      log(`action failed: split-window ${argv.join(" ")} — ${result.error ?? "unknown error"}`);
      return null;
    }
    if (result.layoutError !== undefined) {
      // The pane exists, only the window could not be shaped: appearance
      // failures are non-fatal, so log and keep the pane.
      log(`action failed: layout ${deps.layout} — ${result.layoutError}`);
    }
    const skipped = result.layoutSkipped;
    // A shared window (another opencode-mux instance owns panes here) skips the
    // window-wide layout deliberately — worth a line, not a failure.
    if (skipped !== undefined) logLayoutSkip(skipped);
    log(`opened pane ${result.paneId} for session ${sessionID} (${title})`);
    return result.paneId;
  };

  /** Reserve and split a new pane for the session, then record the open phase. */
  const openTracked = async (sessionID: string, title: string): Promise<void> => {
    if (!deps.tracker.reserve(sessionID)) return;
    const paneId = await openPane(sessionID, title);
    if (paneId === null) {
      deps.tracker.remove(sessionID);
      return;
    }
    deps.tracker.open(sessionID, paneId, now());
    // Opening a pane is a lifecycle moment: a border clear that tmux skipped
    // earlier (shared window) gets another chance instead of waiting for the
    // next theme change.
    await retryPendingClear();
  };

  const applyAction = async (action: TrackerAction): Promise<void> => {
    if (action.kind !== "close") return;
    // A delayed or duplicated terminal event (e.g. the previous turn's
    // session.execution.succeeded landing after the next execution.started)
    // can arm a close while the session is mid-turn again. Never kill a pane
    // whose session is actually running: cancel the close and keep the pane.
    let active = false;
    try {
      const running = await deps.client.session.active();
      active = action.sessionID in running;
    } catch (error) {
      // Fail open: an unreachable lookup must never leak a pane forever.
      log(`close check failed: ${String(error)}`);
    }
    if (active) {
      deps.tracker.markBusy(action.sessionID);
      return;
    }
    // The lookup above is asynchronous and the tick interval is not serialized
    // with the dispatch loop, so a real busy event can land while it is in
    // flight: markBusy then turned the state back to open and this close is
    // stale. Kill only a state that is still closing, with this exact pane.
    const state = deps.tracker.snapshot().get(action.sessionID);
    if (state === undefined || state.phase !== "closing" || !state.emitted || state.paneId !== action.paneId) return;
    try {
      const result = await deps.tmux.killPane(action.paneId);
      if (!result.ok) {
        log(`action failed: kill-pane ${action.paneId} — ${result.error ?? "unknown error"}`);
      }
      // tmux hands the freed cells to a single neighbouring pane, so the remaining
      // subagent panes end up with uneven sizes (one grows, the others keep their
      // old size). Re-applying the configured layout re-tiles them equally, and
      // restores the configured main pane size for main-* layouts. Runs even when
      // the kill failed: the pane may have exited on its own, and the uneven
      // window still needs re-tiling. Appearance failures are non-fatal.
      const relayout = await deps.tmux.relayout({ targetPane, layout: deps.layout, mainPaneSize: deps.mainPaneSize });
      if (!relayout.ok) {
        log(`action failed: relayout ${deps.layout} — ${relayout.error ?? "unknown error"}`);
      }
      // A shared window skips the relayout deliberately: log it once, not as a failure.
      if (relayout.skipped !== undefined) logLayoutSkip(relayout.skipped);
      await retryPendingClear();
    } finally {
      // The close is done either way: drop the emitted state so the session can
      // be re-opened (and reopened panes get a fresh close cycle). In a finally
      // so an adapter that throws on kill-pane/relayout cannot leave a stale
      // entry behind that blocks the session's next close cycle.
      deps.tracker.forget(action.sessionID);
    }
  };

  const applyTick = async (nowMs: number): Promise<void> => {
    for (const action of deps.tracker.tick(nowMs)) {
      await applyAction(action);
    }
  };

  /**
   * Re-opens a pane for a session that was previously closed (removed from
   * the tracker) but has become busy again — so active subagents always
   * stay visible, regardless of whether they finished before.
   */
  const reopenBusyPane = async (sessionID: string): Promise<void> => {
    try {
      const children = await childSessions(deps.client, deps.parentID);
      const info = children.find((c) => c.id === sessionID);
      if (info === undefined) return;
      if (deps.parentID !== null && info.parentID !== deps.parentID) return;
      if (info.parentID === undefined || !(await ownsParent(info.parentID))) return;
      await openTracked(info.id, childTitle(info.title, info.id));
    } catch {
      // best-effort: cannot reopen without session info
    }
  };

  /** JSON of the styles last applied to the window (null when none/cleared). */
  let appliedThemeSig: string | null = null;
  /**
   * A border clear that tmux skipped because another opencode-mux instance
   * shares the window. Recorded instead of retried per tick (the "zero tmux
   * calls when nothing changed" invariant), retried from the pane lifecycle
   * paths — otherwise the old colours would persist forever.
   */
  let pendingClear = false;

  /**
   * Retries a skipped border clear. Called from the pane lifecycle paths only
   * (after a split, after a close): a shared window can end at any moment, but
   * polling it every tick would mean tmux calls on every tick even when nothing
   * changed. Re-resolves the theme, so a retry never clears borders the current
   * theme wants.
   */
  const retryPendingClear = async (): Promise<void> => {
    if (!pendingClear || deps.themeStyles === undefined) return;
    let styles: BorderStyles | null;
    try {
      styles = deps.themeStyles.current();
    } catch (error) {
      log(`styling failed: ${String(error)}`);
      return; // keep pending: try again on the next lifecycle event
    }
    if (styles !== null) {
      // The theme came back: drop the pending clear and let syncTheme apply it
      // on the next tick instead of stripping the colours the user just chose.
      pendingClear = false;
      return;
    }
    const result = await deps.tmux.clearBorderStyles(targetPane);
    if (!result.ok) {
      log(`styling failed: clear — ${result.error ?? "unknown error"}`);
      return;
    }
    pendingClear = result.skipped !== undefined;
  };

  /**
   * Applies the resolved theme's border styles, or clears them when the theme
   * became null. No tmux calls when the provider is absent or unchanged;
   * failures are logged at most once per change and never fail the watcher.
   */
  const syncTheme = async (): Promise<void> => {
    if (deps.themeStyles === undefined) return;
    let styles: BorderStyles | null;
    let sig: string;
    try {
      styles = deps.themeStyles.current();
      sig = JSON.stringify(styles);
    } catch (error) {
      log(`styling failed: ${String(error)}`);
      appliedThemeSig = "error";
      return;
    }
    if (sig === appliedThemeSig) return;
    appliedThemeSig = sig;
    if (styles === null) {
      const result = await deps.tmux.clearBorderStyles(targetPane);
      if (!result.ok) log(`styling failed: clear — ${result.error ?? "unknown error"}`);
      // A skipped clear did not happen (shared window): remember it for the
      // lifecycle paths instead of memoizing it as applied.
      else pendingClear = result.skipped !== undefined;
      return;
    }
    const result = await deps.tmux.applyBorderStyles(targetPane, styles);
    if (!result.ok) log(`styling failed: ${result.error ?? "unknown error"}`);
  };

  const watcher: Watcher = {
    async adopt() {
      try {
        const active = await deps.client.session.active();
        const children = await childSessions(deps.client, deps.parentID);
        for (const info of children) {
          // Only currently-executing children need a pane. Finished children
          // from previous runs are skipped outright: opening one just to close
          // it again flashed panes at startup (their panes were already closed
          // when they completed).
          if (!(info.id in active)) continue;
          if (info.parentID === undefined || !(await ownsParent(info.parentID))) continue;
          await openTracked(info.id, childTitle(info.title, info.id));
        }
        await applyTick(now());
      } catch (error) {
        log(`adopt failed: ${String(error)}`);
      }
    },

    async dispatch(event) {
      const cls = classifyEvent(event);
      if (cls.kind === "connected") {
        // The event stream can reconnect (daemon restart); sessions created
        // during the disconnect are invisible unless we adopt again.
        log("server connected: re-adopting");
        await watcher.adopt();
        return;
      }
      if (cls.kind === "moved") {
        ownedParents.delete(cls.sessionID);
        return;
      }
      if (cls.kind === "created") {
        if (cls.parentID === undefined) return;
        if (deps.parentID !== null) {
          if (cls.parentID !== deps.parentID) return;
        } else if (!(await ownsParent(cls.parentID))) {
          return;
        }
        await openTracked(cls.sessionID, childTitle(cls.title, cls.slug));
        return;
      }
      if (cls.kind === "terminal") {
        deps.tracker.markTerminal(cls.sessionID, now());
        return;
      }
      if (cls.kind === "busy") {
        if (deps.tracker.snapshot().has(cls.sessionID)) {
          deps.tracker.markBusy(cls.sessionID);
        } else {
          await reopenBusyPane(cls.sessionID);
        }
      }
    },

    async tick(nowMs) {
      await applyTick(nowMs);
      await syncTheme();
    },

    async start(signal) {
      if (deps.themeStyles !== undefined) {
        // Apply the initial value once, before the polling loop starts.
        try {
          const initial = deps.themeStyles.current();
          appliedThemeSig = JSON.stringify(initial);
          if (initial !== null) {
            const result = await deps.tmux.applyBorderStyles(targetPane, initial);
            if (!result.ok) log(`styling failed: ${result.error ?? "unknown error"}`);
          }
        } catch (error) {
          log(`styling failed: ${String(error)}`);
          appliedThemeSig = "error";
        }
      }
      // One tick interval for the whole watcher lifetime: it must stay alive
      // across reconnects and is cleared only when the loop below is done.
      const timer = setInterval(() => void watcher.tick(now()), deps.tickEveryMs);
      timer.unref();
      try {
        // Startup adopt guarantees panes for already-running children even if
        // the first subscribe fails, and is idempotent (the tracker reserve
        // guard blocks duplicates when the connect event adopts again).
        await watcher.adopt();
        // Both SDK generations wrap subscribe in SharedEvents.make, which
        // finishes its subscribers when the stream ends or errors — it does not
        // reconnect. Without this loop the watcher would exit on the first
        // daemon restart and stay blind for the rest of the TUI's life.
        while (!signal.aborted) {
          let failure = "event stream ended";
          try {
            const stream = await events(deps.client, signal);
            for await (const event of stream) {
              await watcher.dispatch(event);
              await watcher.tick(now());
            }
          } catch (error) {
            failure = String(error);
          }
          if (signal.aborted) break;
          log(`watcher error: ${failure}`);
          // Exactly one subscription is active at a time: the previous one has
          // finished before the delay, and the next one starts after it.
          await sleep(RECONNECT_DELAY_MS, signal);
        }
      } finally {
        clearInterval(timer);
      }
    },
  };
  return watcher;
}
