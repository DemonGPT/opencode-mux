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
   * parent (a session's directory does not change mid-run). Lookups that fail
   * are not cached, so a transient error does not permanently hide a parent.
   */
  const ownedParents = new Map<string, boolean>();

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
      ownedParents.set(parentID, owned);
      return owned;
    } catch (error) {
      log(`scope lookup failed: ${parentID} — ${String(error)}`);
      return false;
    }
  };

  const openPane = async (sessionID: string, title: string): Promise<string | null> => {
    const argv = paneArgv(sessionID);
    const result = await deps.tmux.splitPane({ targetPane, layout: deps.layout, mainPaneSize: deps.mainPaneSize, argv });
    if (!result.ok || result.paneId === null) {
      log(`action failed: split-window ${argv.join(" ")} — ${result.error ?? "unknown error"}`);
      return null;
    }
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
  };

  const applyAction = async (action: TrackerAction): Promise<void> => {
    if (action.kind !== "close") return;
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
      const timer = setInterval(() => void watcher.tick(now()), deps.tickEveryMs);
      timer.unref();
      signal.addEventListener("abort", () => clearInterval(timer), { once: true });
      try {
        await watcher.adopt();
        const stream = await events(deps.client, signal);
        for await (const event of stream) {
          await watcher.dispatch(event);
          await watcher.tick(now());
        }
      } catch (error) {
        if (!signal.aborted) log(`watcher error: ${String(error)}`);
      } finally {
        clearInterval(timer);
      }
    },
  };
  return watcher;
}
