import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client";
import type { Layout } from "./config.js";
import { childTitle, classifyEvent } from "./session.js";
import { childSessions, events } from "./server.js";
import type { PaneTracker, TrackerAction } from "./tracker.js";
import type { Tmux } from "./tmux.js";
import { currentPane } from "./tmux.js";

export interface WatchDeps {
  client: OpenCodeClient;
  tmux: Tmux;
  tracker: PaneTracker;
  log: (line: string) => void;
  targetPane?: string;
  layout: Layout;
  parentID: string | null;
  paneArgv?: (sessionID: string) => string[];
  tickEveryMs: number;
  now?: () => number;
}

export interface Watcher {
  adopt(): Promise<void>;
  dispatch(event: OpenCodeEvent): Promise<void>;
  tick(now: number): Promise<void>;
  start(signal: AbortSignal): Promise<void>;
}

/** Pane command: attach the child session in the new pane. */
export function defaultPaneArgv(sessionID: string): string[] {
  return ["opencode", "-s", sessionID];
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

  const openPane = async (sessionID: string, title: string): Promise<string | null> => {
    const argv = paneArgv(sessionID);
    const result = await deps.tmux.splitPane({ targetPane, layout: deps.layout, argv });
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
  };

  const applyTick = async (nowMs: number): Promise<void> => {
    for (const action of deps.tracker.tick(nowMs)) {
      await applyAction(action);
    }
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
        if (deps.parentID !== null && cls.parentID !== deps.parentID) return;
        await openTracked(cls.sessionID, childTitle(cls.title, cls.slug));
        return;
      }
      if (cls.kind === "terminal") {
        deps.tracker.markTerminal(cls.sessionID, now());
        return;
      }
      if (cls.kind === "busy") {
        deps.tracker.markBusy(cls.sessionID);
      }
    },

    async tick(nowMs) {
      await applyTick(nowMs);
    },

    async start(signal) {
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
