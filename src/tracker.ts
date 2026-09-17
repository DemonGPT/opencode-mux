import type { ClosePanes } from "./config.js";

export type PaneState =
  | { phase: "pending"; terminal: boolean }
  | { phase: "open"; paneId: string; closeAt: number | null }
  | { phase: "closing"; paneId: string; closeAt: number }
  | { phase: "kept"; paneId: string };

export type TrackerAction =
  | { kind: "open"; sessionID: string; paneId: string }
  | { kind: "close"; sessionID: string; paneId: string };

export interface PaneTrackerOptions {
  graceMs: number;
  closePanes: ClosePanes;
}

/** Pure session→pane state machine; time is injected. */
export class PaneTracker {
  private readonly states = new Map<string, PaneState>();

  constructor(private readonly opts: PaneTrackerOptions) {}

  /** Copy of the current states (read-only view for tests and the watcher). */
  snapshot(): ReadonlyMap<string, PaneState> {
    return new Map(this.states);
  }

  /** Creates a pending entry for a session whose pane does not exist yet. */
  reserve(sessionID: string): boolean {
    if (this.states.has(sessionID)) return false;
    this.states.set(sessionID, { phase: "pending", terminal: false });
    return true;
  }

  /** Drops any state, e.g. when the pane could not be opened. */
  remove(sessionID: string): void {
    this.states.delete(sessionID);
  }

  /** Resolves a pending session into an open pane. Returns the open action. */
  open(sessionID: string, paneId: string, now: number): TrackerAction | null {
    const st = this.states.get(sessionID);
    if (st === undefined || st.phase !== "pending") return null;
    if (st.terminal) {
      this.states.set(sessionID, { phase: "closing", paneId, closeAt: now });
    } else {
      this.states.set(sessionID, { phase: "open", paneId, closeAt: null });
    }
    return { kind: "open", sessionID, paneId };
  }

  /** Marks a session terminal (idle or deleted). Never returns an action. */
  markTerminal(sessionID: string, now: number): TrackerAction | null {
    const st = this.states.get(sessionID);
    if (st === undefined) return null;
    if (st.phase === "pending") {
      this.states.set(sessionID, { phase: "pending", terminal: true });
      return null;
    }
    if (st.phase === "open") {
      if (this.opts.closePanes === "auto") {
        this.states.set(sessionID, { phase: "closing", paneId: st.paneId, closeAt: now + this.opts.graceMs });
      } else {
        this.states.set(sessionID, { phase: "kept", paneId: st.paneId });
      }
    }
    return null;
  }

  /** Cancels a pending close when the session comes back busy. Never returns an action. */
  markBusy(sessionID: string): TrackerAction | null {
    const st = this.states.get(sessionID);
    if (st !== undefined && st.phase === "closing") {
      this.states.set(sessionID, { phase: "open", paneId: st.paneId, closeAt: null });
    }
    return null;
  }

  /** Emits due close actions and forgets those sessions. */
  tick(now: number): TrackerAction[] {
    const actions: TrackerAction[] = [];
    for (const [sessionID, st] of this.states) {
      if (st.phase === "closing" && st.closeAt <= now) {
        this.states.delete(sessionID);
        actions.push({ kind: "close", sessionID, paneId: st.paneId });
      }
    }
    return actions;
  }
}
