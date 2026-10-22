import { describe, expect, it, vi } from "vitest";
import type { OpenCodeClient, OpenCodeEvent, SessionInfo } from "@opencode/client";
import { PaneTracker } from "../src/tracker.ts";
import type { BorderStyles, Tmux, TmuxApplyResult } from "../src/tmux.ts";
import { createWatcher, defaultPaneArgv, isSameProject } from "../src/watch.ts";

const created = (sessionID: string, parentID: string, slug = "coder"): OpenCodeEvent =>
  ({ type: "session.created", data: { sessionID, parentID, slug } }) as unknown as OpenCodeEvent;
const parentless = (sessionID: string): OpenCodeEvent =>
  ({ type: "session.created", data: { sessionID, slug: "top" } }) as unknown as OpenCodeEvent;
const idle = (sessionID: string): OpenCodeEvent =>
  ({ type: "session.idle", data: { sessionID } }) as unknown as OpenCodeEvent;
const busy = (sessionID: string): OpenCodeEvent =>
  ({ type: "session.status", data: { sessionID, status: { type: "busy" } } }) as unknown as OpenCodeEvent;
const execStarted = (sessionID: string): OpenCodeEvent =>
  ({ type: "session.execution.started", data: { sessionID } }) as unknown as OpenCodeEvent;
const execSucceeded = (sessionID: string): OpenCodeEvent =>
  ({ type: "session.execution.succeeded", data: { sessionID } }) as unknown as OpenCodeEvent;
const connected = (): OpenCodeEvent => ({ type: "server.connected", data: {} }) as unknown as OpenCodeEvent;
const moved = (sessionID: string): OpenCodeEvent =>
  ({ type: "session.moved", data: { sessionID } }) as unknown as OpenCodeEvent;

const sessionInfo = (id: string, parentID: string, directory = "/x"): SessionInfo =>
  ({ id, parentID, projectID: "p", cost: {}, tokens: {}, time: { created: 1, updated: 1 }, location: { kind: "local", directory, project: "p" } }) as unknown as SessionInfo;

function makeClient(over: { active?: Record<string, { type: "running" }>; activeImpl?: () => Promise<Record<string, { type: "running" }>>; children?: SessionInfo[]; parents?: Record<string, SessionInfo>; getError?: string; stream?: (opts: { signal?: AbortSignal }) => AsyncIterable<OpenCodeEvent> }) {
  const subscribe = (opts: { signal?: AbortSignal }) =>
    over.stream ? over.stream(opts) : (async function* () {})();
  return {
    session: {
      async list() {
        return { data: over.children ?? [], cursor: { next: null, previous: null } };
      },
      async active() {
        if (over.activeImpl !== undefined) return over.activeImpl();
        return over.active ?? {};
      },
      async get(input: { sessionID: string }) {
        if (over.getError !== undefined) throw new Error(over.getError);
        const info = over.parents?.[input.sessionID];
        if (info === undefined) throw new Error(`session not found: ${input.sessionID}`);
        return info;
      },
    },
    event: { subscribe },
  } as unknown as OpenCodeClient;
}

function makeTmux(over: { paneIds?: string[]; splits?: Array<{ targetPane: string; layout: string; argv: string[] }>; kills?: string[]; relayouts?: Array<{ targetPane: string; layout: string; mainPaneSize?: number }>; borderStyles?: Array<{ targetPane: string; styles: BorderStyles }>; clears?: string[]; borderResult?: TmuxApplyResult; clearResult?: TmuxApplyResult; relayoutResult?: TmuxApplyResult; killResult?: { ok: boolean; error: string | null }; layoutError?: string; layoutSkipped?: string } = {}): Tmux & { splits: Array<{ targetPane: string; layout: string; argv: string[] }>; kills: string[]; relayouts: Array<{ targetPane: string; layout: string; mainPaneSize?: number }>; borderStyles: Array<{ targetPane: string; styles: BorderStyles }>; clears: string[] } {
  const splits = over.splits ?? [];
  const kills = over.kills ?? [];
  const relayouts = over.relayouts ?? [];
  const borderStyles = over.borderStyles ?? [];
  const clears = over.clears ?? [];
  let next = 0;
  return {
    splits,
    kills,
    relayouts,
    borderStyles,
    clears,
    async splitPane(input) {
      splits.push(input);
      const paneId = over.paneIds?.[next++];
      if (paneId === undefined) return { ok: false, error: "no pane", paneId: null };
      if (over.layoutError !== undefined) return { ok: true, error: null, paneId, layoutError: over.layoutError };
      return over.layoutSkipped === undefined
        ? { ok: true, error: null, paneId }
        : { ok: true, error: null, paneId, layoutSkipped: over.layoutSkipped };
    },
    async killPane(paneId) {
      kills.push(paneId);
      return over.killResult ?? { ok: true, error: null };
    },
    async relayout(input) {
      relayouts.push(input);
      return over.relayoutResult ?? { ok: true, error: null };
    },
    async applyBorderStyles(targetPane, styles) {
      borderStyles.push({ targetPane, styles });
      return over.borderResult ?? { ok: true, error: null };
    },
    async clearBorderStyles(targetPane) {
      clears.push(targetPane);
      return over.clearResult ?? { ok: true, error: null };
    },
  };
}

/** Mutable adapter overrides (tests flip them mid-scenario). */
type TmuxOver = NonNullable<Parameters<typeof makeTmux>[0]>;

const deps = (over: Partial<Parameters<typeof createWatcher>[0]> = {}) => ({
  client: makeClient({}),
  tmux: makeTmux({ paneIds: ["%1"] }),
  tracker: new PaneTracker({ graceMs: 1_000, closePanes: "auto" }),
  log: () => {},
  layout: "main-vertical" as const,
  parentID: "ses_p",
  targetPane: "%0",
  tickEveryMs: 60_000,
  now: () => 1_000,
  ...over,
});

describe("createWatcher", () => {
  it("defaultPaneArgv builds the opencode mini attach command", () => {
    expect(defaultPaneArgv("ses_c")).toEqual(["env", "BUN_CONFIG_HTTP_IDLE_TIMEOUT=0", "opencode", "mini", "-s", "ses_c"]);
  });

  it("defaultPaneArgv builds the bare full-TUI attach command (no 'tui' subcommand)", () => {
    expect(defaultPaneArgv("ses_c", "tui")).toEqual(["opencode", "-s", "ses_c"]);
  });

  it("opens a pane for a matching created event and records the open phase", async () => {
    const tmux = makeTmux({ paneIds: ["%7"] });
    const tracker = new PaneTracker({ graceMs: 1_000, closePanes: "auto" });
    const w = createWatcher(deps({ tmux, tracker }));
    await w.dispatch(created("ses_c", "ses_p"));
    expect(tmux.splits).toEqual([{ targetPane: "%0", layout: "main-vertical", argv: ["env", "BUN_CONFIG_HTTP_IDLE_TIMEOUT=0", "opencode", "mini", "-s", "ses_c"] }]);
    expect(tracker.snapshot().get("ses_c")).toEqual({ phase: "open", paneId: "%7", closeAt: null });
  });

  it("ignores parentless and foreign-parent created events", async () => {
    const tmux = makeTmux({ paneIds: ["%7"] });
    const w = createWatcher(deps({ tmux }));
    await w.dispatch(parentless("ses_top"));
    await w.dispatch(created("ses_other", "ses_notmine"));
    expect(tmux.splits).toEqual([]);
  });

  it("closes the pane when the grace deadline passes", async () => {
    const tmux = makeTmux({ paneIds: ["%8"] });
    const perWatcher = { now: () => 2_000 };
    const w = createWatcher(deps({ tmux, ...perWatcher }));
    await w.dispatch(created("ses_c", "ses_p"));
    await w.dispatch(idle("ses_c"));
    await w.tick(2_999);
    expect(tmux.kills).toEqual([]);
    await w.tick(3_000);
    expect(tmux.kills).toEqual(["%8"]);
    await w.tick(4_000);
    expect(tmux.kills).toEqual(["%8"]);
  });

  it("re-layouts the remaining panes after closing one", async () => {
    const tmux = makeTmux({ paneIds: ["%1", "%2", "%3"] });
    const tracker = new PaneTracker({ graceMs: 1_000, closePanes: "auto" });
    const w = createWatcher(deps({ tmux, tracker, mainPaneSize: 55, now: () => 2_000 }));
    await w.dispatch(created("ses_a", "ses_p"));
    await w.dispatch(created("ses_b", "ses_p"));
    await w.dispatch(created("ses_c", "ses_p"));
    expect(tmux.relayouts).toEqual([]); // opening panes already shapes the layout
    await w.dispatch(execSucceeded("ses_b"));
    await w.tick(3_000);
    expect(tmux.kills).toEqual(["%2"]);
    expect(tmux.relayouts).toEqual([{ targetPane: "%0", layout: "main-vertical", mainPaneSize: 55 }]);
  });

  it("re-layouts even when the pane was already gone, and logs a relayout failure without failing", async () => {
    const tmux = makeTmux({
      paneIds: ["%8"],
      killResult: { ok: false, error: "can't find pane: %8" },
      relayoutResult: { ok: false, error: "no such window" },
    });
    const logs: string[] = [];
    const w = createWatcher(deps({ tmux, now: () => 2_000, log: (l) => logs.push(l) }));
    await w.dispatch(created("ses_c", "ses_p"));
    await w.dispatch(idle("ses_c"));
    await w.tick(3_000);
    expect(tmux.kills).toEqual(["%8"]);
    expect(tmux.relayouts).toHaveLength(1);
    expect(logs.join("\n")).toMatch(/action failed: kill-pane %8 — can't find pane/);
    expect(logs.join("\n")).toMatch(/action failed: relayout main-vertical — no such window/);
  });

  it("does not re-layout when panes are kept", async () => {
    const tmux = makeTmux({ paneIds: ["%8"] });
    const tracker = new PaneTracker({ graceMs: 1_000, closePanes: "keep" });
    const w = createWatcher(deps({ tmux, tracker, now: () => 2_000 }));
    await w.dispatch(created("ses_c", "ses_p"));
    await w.dispatch(execSucceeded("ses_c"));
    await w.tick(1e9);
    expect(tmux.kills).toEqual([]);
    expect(tmux.relayouts).toEqual([]);
  });

  it("busy revival cancels the pending close", async () => {
    const tmux = makeTmux({ paneIds: ["%8"] });
    const w = createWatcher(deps({ tmux }));
    await w.dispatch(created("ses_c", "ses_p"));
    await w.dispatch(idle("ses_c"));
    await w.dispatch(busy("ses_c"));
    await w.tick(1e9);
    expect(tmux.kills).toEqual([]);
    await w.dispatch(idle("ses_c"));
    await w.tick(2_000);
    expect(tmux.kills).toEqual(["%8"]);
  });

  it("closes the pane when the session execution succeeds (the daemon's real completion signal)", async () => {
    const tmux = makeTmux({ paneIds: ["%8"] });
    const w = createWatcher(deps({ tmux }));
    await w.dispatch(created("ses_c", "ses_p"));
    await w.dispatch(execStarted("ses_c"));
    await w.dispatch(execSucceeded("ses_c"));
    await w.tick(1_999);
    expect(tmux.kills).toEqual([]);
    await w.tick(2_000);
    expect(tmux.kills).toEqual(["%8"]);
  });

  it("a new execution after completion cancels the pending close (agent resumed)", async () => {
    const tmux = makeTmux({ paneIds: ["%8"] });
    const w = createWatcher(deps({ tmux }));
    await w.dispatch(created("ses_c", "ses_p"));
    await w.dispatch(execSucceeded("ses_c"));
    await w.dispatch(execStarted("ses_c"));
    await w.tick(1e9);
    expect(tmux.kills).toEqual([]);
    await w.dispatch(execSucceeded("ses_c"));
    await w.tick(2_000);
    expect(tmux.kills).toEqual(["%8"]);
  });

  it("cancels a due close when session.active() reports the session as running", async () => {
    const tmux = makeTmux({ paneIds: ["%8"] });
    const tracker = new PaneTracker({ graceMs: 1_000, closePanes: "auto" });
    const client = makeClient({ active: { ses_c: { type: "running" } } });
    const w = createWatcher(deps({ tmux, tracker, client }));
    await w.dispatch(created("ses_c", "ses_p"));
    await w.dispatch(execSucceeded("ses_c"));
    await w.tick(2_000);
    expect(tmux.kills).toEqual([]);
    expect(tmux.relayouts).toEqual([]);
    expect(tracker.snapshot().get("ses_c")).toEqual({ phase: "open", paneId: "%8", closeAt: null });
  });

  it("does not kill the pane when a stale terminal lands while the session is working again", async () => {
    // Previous turn's completion event arrives after the next execution.started:
    // a close is armed while the session is mid-turn, and tick must not kill it.
    const tmux = makeTmux({ paneIds: ["%8"] });
    const tracker = new PaneTracker({ graceMs: 1_000, closePanes: "auto" });
    const over: { active: Record<string, { type: "running" }> } = { active: { ses_c: { type: "running" } } };
    const client = makeClient(over);
    const w = createWatcher(deps({ tmux, tracker, client }));
    await w.dispatch(created("ses_c", "ses_p"));
    await w.dispatch(execStarted("ses_c"));
    await w.dispatch(execSucceeded("ses_c")); // stale: belongs to the previous turn
    await w.tick(2_000);
    expect(tmux.kills).toEqual([]);
    expect(tracker.snapshot().get("ses_c")).toEqual({ phase: "open", paneId: "%8", closeAt: null });
    // Once the session really finishes, the same pane closes normally.
    over.active = {};
    await w.dispatch(execSucceeded("ses_c"));
    await w.tick(3_000);
    expect(tmux.kills).toEqual(["%8"]);
    expect(tracker.snapshot().get("ses_c")).toBeUndefined();
  });

  it("proceeds with the close and logs when the active lookup fails (fail-open)", async () => {
    const tmux = makeTmux({ paneIds: ["%8"] });
    const tracker = new PaneTracker({ graceMs: 1_000, closePanes: "auto" });
    const client = makeClient({});
    vi.spyOn(client.session, "active").mockRejectedValue(new Error("daemon gone"));
    const logs: string[] = [];
    const w = createWatcher(deps({ tmux, tracker, client, log: (l) => logs.push(l) }));
    await w.dispatch(created("ses_c", "ses_p"));
    await w.dispatch(execSucceeded("ses_c"));
    await w.tick(2_000);
    expect(logs.join("\n")).toMatch(/close check failed: Error: daemon gone/);
    expect(tmux.kills).toEqual(["%8"]);
    expect(tracker.snapshot().get("ses_c")).toBeUndefined();
  });


  it("re-opens the pane when a closed session becomes busy again", async () => {
    const tmux = makeTmux({ paneIds: ["%1", "%2"] });
    const tracker = new PaneTracker({ graceMs: 1_000, closePanes: "auto" });
    const w = createWatcher(
      deps({
        tmux,
        tracker,
        now: () => 1_000,
        client: makeClient({
          children: [sessionInfo("ses_c", "ses_p")],
          active: {},
        }),
      }),
    );
    await w.dispatch(created("ses_c", "ses_p"));
    expect(tmux.splits).toHaveLength(1);
    expect(tracker.snapshot().get("ses_c")).toEqual({ phase: "open", paneId: "%1", closeAt: null });

    // Session finishes → pane closes after grace → tracker entry removed
    await w.dispatch(execSucceeded("ses_c"));
    await w.tick(2_000);
    expect(tmux.kills).toEqual(["%1"]);
    expect(tracker.snapshot().get("ses_c")).toBeUndefined();

    // Session is busy again (reused) → pane re-opens even though tracker entry is gone
    await w.dispatch(busy("ses_c"));
    expect(tmux.splits).toHaveLength(2);
    expect(tmux.splits[1]).toEqual({
      targetPane: "%0",
      layout: "main-vertical",
      argv: ["env", "BUN_CONFIG_HTTP_IDLE_TIMEOUT=0", "opencode", "mini", "-s", "ses_c"],
    });
    expect(tracker.snapshot().get("ses_c")).toEqual({ phase: "open", paneId: "%2", closeAt: null });
  });

  it("does not reopen when a closed session becomes busy but is not a child", async () => {
    const tmux = makeTmux({ paneIds: ["%1", "%2"] });
    const tracker = new PaneTracker({ graceMs: 1_000, closePanes: "auto" });
    const w = createWatcher(
      deps({
        tmux,
        tracker,
        now: () => 1_000,
        client: makeClient({
          children: [sessionInfo("ses_other", "ses_p")],
          active: {},
        }),
      }),
    );
    await w.dispatch(created("ses_c", "ses_p"));
    await w.dispatch(execSucceeded("ses_c"));
    await w.tick(2_000);
    expect(tracker.snapshot().get("ses_c")).toBeUndefined();

    await w.dispatch(busy("ses_c"));
    expect(tmux.splits).toHaveLength(1); // no second split
    expect(tracker.snapshot().get("ses_c")).toBeUndefined();
  });

  it("adopts only currently-running children, skipping finished ones", async () => {
    const tmux = makeTmux({ paneIds: ["%1"] });
    const tracker = new PaneTracker({ graceMs: 1_000, closePanes: "auto" });
    const w = createWatcher(
      deps({
        tmux,
        tracker,
        client: makeClient({
          children: [sessionInfo("ses_running", "ses_p"), sessionInfo("ses_done", "ses_p")],
          active: { ses_running: { type: "running" } },
        }),
      }),
    );
    await w.adopt();
    expect(tmux.splits.map((s) => s.argv[s.argv.indexOf("-s") + 1])).toEqual(["ses_running"]);
    expect(tracker.snapshot().get("ses_running")).toEqual({ phase: "open", paneId: "%1", closeAt: null });
    expect(tracker.snapshot().get("ses_done")).toBeUndefined();
    expect(tmux.kills).toEqual([]);
  });

  it("adopts nothing when no child sessions are running (no startup flash)", async () => {
    const tmux = makeTmux({ paneIds: ["%1"] });
    const w = createWatcher(
      deps({
        tmux,
        client: makeClient({
          children: [sessionInfo("ses_done_a", "ses_p"), sessionInfo("ses_done_b", "ses_p")],
          active: {},
        }),
      }),
    );
    await w.adopt();
    expect(tmux.splits).toEqual([]);
    expect(tmux.kills).toEqual([]);
  });

  it("re-adopts on server.connected so sessions created during a disconnect appear", async () => {
    const tmux = makeTmux({ paneIds: ["%1"] });
    const tracker = new PaneTracker({ graceMs: 1_000, closePanes: "auto" });
    const over: { children: SessionInfo[]; active: Record<string, { type: "running" }> } = {
      children: [],
      active: {},
    };
    const client = makeClient(over);
    const list = vi.spyOn(client.session, "list");
    const logs: string[] = [];
    const w = createWatcher(deps({ tmux, tracker, client, log: (l) => logs.push(l) }));
    await w.adopt();
    expect(list).toHaveBeenCalledTimes(1);
    expect(tmux.splits).toEqual([]);

    // Created while the watcher was disconnected: only re-adopting finds it.
    over.children = [sessionInfo("ses_new", "ses_p")];
    over.active = { ses_new: { type: "running" } };
    await w.dispatch(connected());
    expect(logs.join("\n")).toMatch(/server connected: re-adopting/);
    expect(list).toHaveBeenCalledTimes(2);
    expect(tmux.splits).toHaveLength(1);
    expect(tmux.splits[0]!.argv).toContain("ses_new");
    expect(tracker.snapshot().get("ses_new")).toEqual({ phase: "open", paneId: "%1", closeAt: null });
  });


  it("logs and drops the state when the split fails", async () => {
    const tmux = makeTmux({ paneIds: [] });
    const tracker = new PaneTracker({ graceMs: 1_000, closePanes: "auto" });
    const logs: string[] = [];
    const w = createWatcher(deps({ tmux, tracker, log: (l) => logs.push(l) }));
    await w.dispatch(created("ses_c", "ses_p"));
    expect(logs.join("\n")).toMatch(/action failed: split-window/);
    expect(tracker.snapshot().get("ses_c")).toBeUndefined();
  });

  it("logs a layout failure after a successful split and still opens/tracks the pane", async () => {
    const tmux = makeTmux({ paneIds: ["%7"], layoutError: "no such window: %0" });
    const tracker = new PaneTracker({ graceMs: 1_000, closePanes: "auto" });
    const logs: string[] = [];
    const w = createWatcher(deps({ tmux, tracker, log: (l) => logs.push(l) }));
    await w.dispatch(created("ses_c", "ses_p"));
    expect(logs.join("\n")).toMatch(/action failed: layout main-vertical — no such window: %0/);
    expect(tmux.splits).toHaveLength(1);
    expect(tracker.snapshot().get("ses_c")).toEqual({ phase: "open", paneId: "%7", closeAt: null });
  });

  it("defaults targetPane from the process environment and throws without it", async () => {
    vi.stubEnv("TMUX_PANE", "%9");
    try {
      const tmux = makeTmux({ paneIds: ["%1"] });
      const w = createWatcher(deps({ tmux, targetPane: undefined }));
      await w.dispatch(created("ses_c", "ses_p"));
      expect(tmux.splits[0]!.targetPane).toBe("%9");
    } finally {
      vi.unstubAllEnvs();
    }
    vi.stubEnv("TMUX_PANE", "");
    const tmux = makeTmux({ paneIds: ["%1"] });
    expect(() => createWatcher(deps({ tmux, targetPane: undefined }))).toThrow(/TMUX_PANE/);
  });

  it("start subscribes to the event stream, dispatches events and stops on abort", async () => {
    const tmux = makeTmux({ paneIds: ["%8"] });
    const tracker = new PaneTracker({ graceMs: 1_000, closePanes: "auto" });
    const controller = new AbortController();
    let subscribeOpts: { signal?: AbortSignal } = {};
    let abortedAtSubscribe: boolean | null = null;
    const client = makeClient({
      stream: async function* (opts) {
        subscribeOpts = opts;
        abortedAtSubscribe = opts.signal?.aborted ?? null;
        yield created("ses_c", "ses_p");
        yield idle("ses_c");
        // The real signal aborts when the TUI (and thus the watcher) exits.
        controller.abort();
        return;
      },
    });
    const w = createWatcher(deps({ client, tmux, tracker, tickEveryMs: 10_000 }));
    await w.start(controller.signal);
    expect(subscribeOpts.signal).toBe(controller.signal);
    expect(abortedAtSubscribe).toBe(false);
    expect(tmux.splits).toHaveLength(1);
    expect(tracker.snapshot().get("ses_c")).toEqual({ phase: "closing", paneId: "%8", closeAt: 2_000, emitted: false });
    await w.tick(2_000);
    expect(tmux.kills).toEqual(["%8"]);
  });

  it("resubscribes and re-adopts when the event stream ends (daemon restart)", async () => {
    // Both SDK generations wrap subscribe in SharedEvents.make, which finishes
    // its subscribers when the stream ends instead of reconnecting: without a
    // resubscribe loop the watcher would be blind for the rest of the TUI's life.
    const tmux = makeTmux({ paneIds: ["%1", "%2"] });
    const tracker = new PaneTracker({ graceMs: 1_000, closePanes: "auto" });
    const controller = new AbortController();
    let subscriptions = 0;
    const over = {
      children: [sessionInfo("ses_c", "ses_p")],
      active: { ses_c: { type: "running" } } as Record<string, { type: "running" }>,
      stream: async function* () {
        subscriptions += 1;
        if (subscriptions === 1) {
          yield created("ses_c", "ses_p");
          return; // stream ends: the daemon went away
        }
        // A reconnect announces itself, so the watcher adopts what it missed.
        yield connected();
        controller.abort();
        return;
      },
    };
    const client = makeClient(over);
    const list = vi.spyOn(client.session, "list");
    const logs: string[] = [];
    const w = createWatcher(deps({ client, tmux, tracker, log: (l) => logs.push(l), tickEveryMs: 600_000 }));
    await w.start(controller.signal);
    expect(subscriptions).toBe(2);
    expect(logs.join("\n")).toMatch(/watcher error: event stream ended/);
    expect(logs.join("\n")).toMatch(/server connected: re-adopting/);
    // Startup adopt + the re-adopt on reconnect.
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(2);
    // The tracker's reserve guard keeps the re-adopt from paning twice.
    expect(tmux.splits).toHaveLength(1);
    expect(tracker.snapshot().get("ses_c")).toEqual({ phase: "open", paneId: "%1", closeAt: null });
  });

  it("logs a watcher error and retries when the event stream fails", async () => {
    const tmux = makeTmux({ paneIds: ["%1"] });
    const controller = new AbortController();
    let subscriptions = 0;
    const logs: string[] = [];
    const over = {
      stream: async function* () {
        subscriptions += 1;
        if (subscriptions === 1) throw new Error("daemon gone");
        controller.abort();
        return;
      },
    };
    const client = makeClient(over);
    const w = createWatcher(deps({ client, tmux, log: (l) => logs.push(l), tickEveryMs: 600_000 }));
    await w.start(controller.signal);
    expect(subscriptions).toBe(2);
    expect(logs.filter((l) => /watcher error: Error: daemon gone/.test(l))).toHaveLength(1);
  });

  it("aborts promptly during the reconnect delay without resubscribing", async () => {
    const tmux = makeTmux({ paneIds: ["%1"] });
    const controller = new AbortController();
    let subscriptions = 0;
    const over = {
      stream: async function* () {
        subscriptions += 1;
        return;
      },
    };
    const client = makeClient(over);
    const w = createWatcher(deps({ client, tmux, tickEveryMs: 600_000 }));
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    try {
      const running = w.start(controller.signal);
      // Let the loop reach the retry delay, then abort while it waits.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(subscriptions).toBe(1);
      controller.abort();
      const timedOut = new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 500));
      expect(await Promise.race([running.then(() => "done"), timedOut])).toBe("done");
      expect(subscriptions).toBe(1); // no subscribe after the abort
      // The tick interval is cleared by the outer finally (one pending timer less).
      expect(clearIntervalSpy).toHaveBeenCalledWith(setIntervalSpy.mock.results[0]!.value);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it("applies theme styles once at start when provided", async () => {
    const tmux = makeTmux({ paneIds: ["%1"] });
    const styles = { inactive: "fg=#737aa2", active: "fg=#9099b2" };
    const themeStyles = { current: () => styles };
    const w = createWatcher(deps({ tmux, themeStyles, tickEveryMs: 10_000 }));
    const controller = new AbortController();
    // start() keeps resubscribing until the signal aborts; the styling itself
    // is driven by tick(), so abort before starting.
    controller.abort();
    await w.start(controller.signal);
    expect(tmux.borderStyles).toEqual([{ targetPane: "%0", styles }]);
    expect(tmux.clears).toEqual([]);
    expect(tmux.splits).toEqual([]);
  });

  it("makes zero styling calls when themeStyles is absent", async () => {
    const tmux = makeTmux({ paneIds: ["%1"] });
    const w = createWatcher(deps({ tmux, tickEveryMs: 10_000 }));
    const controller = new AbortController();
    // start() keeps resubscribing until the signal aborts; the styling itself
    // is driven by tick(), so abort before starting.
    controller.abort();
    await w.start(controller.signal);
    expect(tmux.borderStyles).toEqual([]);
    expect(tmux.clears).toEqual([]);
  });

  it("re-applies styles only when the theme changes", async () => {
    const tmux = makeTmux({ paneIds: ["%1"] });
    const a = { inactive: "fg=#111111", active: "fg=#222222" };
    const b = { inactive: "fg=#333333", active: "fg=#444444" };
    let current = a;
    const themeStyles = { current: () => current };
    const w = createWatcher(deps({ tmux, themeStyles, tickEveryMs: 10_000 }));
    const controller = new AbortController();
    // start() keeps resubscribing until the signal aborts; the styling itself
    // is driven by tick(), so abort before starting.
    controller.abort();
    await w.start(controller.signal);
    expect(tmux.borderStyles).toEqual([{ targetPane: "%0", styles: a }]);
    await w.tick(1_000);
    expect(tmux.borderStyles).toEqual([{ targetPane: "%0", styles: a }]); // unchanged → no call
    current = b;
    await w.tick(2_000);
    expect(tmux.borderStyles).toEqual([
      { targetPane: "%0", styles: a },
      { targetPane: "%0", styles: b },
    ]);
    await w.tick(3_000); // unchanged again → no further calls
    expect(tmux.borderStyles).toHaveLength(2);
    expect(tmux.clears).toEqual([]);
  });

  it("clears the border styles when the theme becomes null and re-applies on return", async () => {
    const tmux = makeTmux({ paneIds: ["%1"] });
    const a = { inactive: "fg=#111111", active: "fg=#222222" };
    let current: BorderStyles | null = a;
    const themeStyles = { current: () => current };
    const w = createWatcher(deps({ tmux, themeStyles, tickEveryMs: 10_000 }));
    const controller = new AbortController();
    // start() keeps resubscribing until the signal aborts; the styling itself
    // is driven by tick(), so abort before starting.
    controller.abort();
    await w.start(controller.signal);
    expect(tmux.borderStyles).toEqual([{ targetPane: "%0", styles: a }]);
    current = null;
    await w.tick(2_000);
    expect(tmux.clears).toEqual(["%0"]);
    await w.tick(3_000);
    expect(tmux.clears).toEqual(["%0"]); // still null → no repeat
    current = a;
    await w.tick(4_000);
    expect(tmux.borderStyles).toEqual([
      { targetPane: "%0", styles: a },
      { targetPane: "%0", styles: a },
    ]);
  });

  it("logs a styling failure without failing the watcher, at most once per change", async () => {
    const tmux = makeTmux({ paneIds: ["%1"], borderResult: { ok: false, error: "boom" } });
    const logs: string[] = [];
    const a = { inactive: "fg=#111111" };
    const b = { inactive: "fg=#222222" };
    let current = a;
    const w = createWatcher(deps({ tmux, log: (l) => logs.push(l), themeStyles: { current: () => current }, tickEveryMs: 10_000 }));
    const controller = new AbortController();
    // start() keeps resubscribing until the signal aborts; the styling itself
    // is driven by tick(), so abort before starting.
    controller.abort();
    await w.start(controller.signal);
    expect(logs.join("\n")).toMatch(/styling failed: boom/);
    await w.tick(2_000);
    await w.tick(3_000);
    expect(logs.filter((l) => l.includes("styling failed: boom")).length).toBeLessThanOrEqual(1);
    current = b;
    await w.tick(4_000); // changed again → one more attempt (and one more log)
    expect(logs.filter((l) => l.includes("styling failed: boom")).length).toBeLessThanOrEqual(2);
  });

  it("does not kill a pane whose session became busy while active() was in flight", async () => {
    // The tick interval is not serialized with the dispatch loop: a real
    // execution.started can arrive during the awaited active() lookup, turning
    // the closing state back to open. The stale "not running" answer must not
    // destroy the pane (a later terminal event then finds nothing to re-open).
    const tmux = makeTmux({ paneIds: ["%8"] });
    const tracker = new PaneTracker({ graceMs: 1_000, closePanes: "auto" });
    let releaseActive!: (running: Record<string, { type: "running" }>) => void;
    const staleAnswer = new Promise<Record<string, { type: "running" }>>((resolve) => {
      releaseActive = resolve;
    });
    let activeStarted!: () => void;
    const activeLookup = new Promise<void>((resolve) => {
      activeStarted = resolve;
    });
    const client = makeClient({
      activeImpl: () => {
        activeStarted();
        return staleAnswer;
      },
    });
    const w = createWatcher(deps({ tmux, tracker, client, now: () => 2_000 }));
    await w.dispatch(created("ses_c", "ses_p"));
    await w.dispatch(execSucceeded("ses_c"));
    const ticking = w.tick(3_000); // close is due → awaits session.active()
    await activeLookup;
    await w.dispatch(execStarted("ses_c")); // session is working again
    releaseActive({}); // stale answer: "not running"
    await ticking;
    expect(tmux.kills).toEqual([]);
    expect(tmux.relayouts).toEqual([]);
    expect(tracker.snapshot().get("ses_c")).toEqual({ phase: "open", paneId: "%8", closeAt: null });
  });

  it("forgets the session even when the adapter throws during the close", async () => {
    const tmux = makeTmux({ paneIds: ["%8", "%9"] });
    const tracker = new PaneTracker({ graceMs: 1_000, closePanes: "auto" });
    // Adapter contract breach: killPane rejects instead of returning a result.
    vi.spyOn(tmux, "killPane").mockRejectedValueOnce(new Error("adapter bug"));
    const client = makeClient({ children: [sessionInfo("ses_c", "ses_p")], active: {} });
    const w = createWatcher(deps({ tmux, tracker, client, now: () => 2_000 }));
    await w.dispatch(created("ses_c", "ses_p"));
    await w.dispatch(execSucceeded("ses_c"));
    await expect(w.tick(3_000)).rejects.toThrow(/adapter bug/);
    // The dropped state cannot block the next cycle: busy re-opens, finishing closes.
    expect(tracker.snapshot().get("ses_c")).toBeUndefined();
    await w.dispatch(execStarted("ses_c"));
    expect(tmux.splits).toHaveLength(2);
    expect(tracker.snapshot().get("ses_c")).toEqual({ phase: "open", paneId: "%9", closeAt: null });
    await w.dispatch(execSucceeded("ses_c"));
    await w.tick(4_000);
    expect(tmux.kills).toEqual(["%9"]);
    expect(tracker.snapshot().get("ses_c")).toBeUndefined();
  });

  it("retries a skipped border clear on the next pane close instead of memoizing it", async () => {
    const over: TmuxOver = {
      paneIds: ["%1"],
      clearResult: { ok: true, error: null, skipped: "window shared with opencode-mux %9" },
    };
    const tmux = makeTmux(over);
    const a = { inactive: "fg=#111111" };
    let current: BorderStyles | null = a;
    const w = createWatcher(deps({ tmux, themeStyles: { current: () => current }, tickEveryMs: 600_000, now: () => 2_000 }));
    const controller = new AbortController();
    controller.abort();
    await w.start(controller.signal);
    expect(tmux.borderStyles).toHaveLength(1);

    current = null;
    await w.tick(2_000);
    expect(tmux.clears).toEqual(["%0"]); // skipped while the window is shared
    over.clearResult = { ok: true, error: null };
    await w.tick(2_500);
    // Ticks stay silent: the invariant is zero tmux calls when nothing changed.
    expect(tmux.clears).toEqual(["%0"]);

    // A pane lifecycle moment retries the pending clear.
    await w.dispatch(created("ses_c", "ses_p"));
    await w.dispatch(execSucceeded("ses_c"));
    await w.tick(3_000);
    expect(tmux.clears).toEqual(["%0", "%0"]);
    await w.tick(4_000);
    expect(tmux.clears).toHaveLength(2); // pending dropped
  });

  it("does not clear borders from a pending retry when the theme resolved again", async () => {
    const over: TmuxOver = {
      paneIds: ["%1"],
      clearResult: { ok: true, error: null, skipped: "window shared with opencode-mux %9" },
    };
    const tmux = makeTmux(over);
    const a = { inactive: "fg=#111111" };
    const b = { inactive: "fg=#222222" };
    let current: BorderStyles | null = a;
    const w = createWatcher(deps({ tmux, themeStyles: { current: () => current }, tickEveryMs: 600_000, now: () => 2_000 }));
    const controller = new AbortController();
    controller.abort();
    await w.start(controller.signal);
    current = null;
    await w.tick(2_000);
    expect(tmux.clears).toEqual(["%0"]); // skipped → pending

    // The theme resolved again before the pane close: the retry must not clear.
    current = b;
    await w.dispatch(created("ses_c", "ses_p"));
    await w.dispatch(execSucceeded("ses_c"));
    await w.tick(3_000);
    expect(tmux.clears).toEqual(["%0"]);
    expect(tmux.borderStyles).toHaveLength(2); // b applied by syncTheme
  });

  it("logs a shared-window layout skip once and keeps the pane", async () => {
    const tmux = makeTmux({ paneIds: ["%7", "%8"], layoutSkipped: "window shared with opencode-mux %9" });
    const tracker = new PaneTracker({ graceMs: 1_000, closePanes: "auto" });
    const logs: string[] = [];
    const w = createWatcher(deps({ tmux, tracker, log: (l) => logs.push(l) }));
    await w.dispatch(created("ses_a", "ses_p"));
    await w.dispatch(created("ses_b", "ses_p"));
    expect(tmux.splits).toHaveLength(2);
    expect(logs.filter((l) => l === "layout skipped: window shared with opencode-mux %9")).toHaveLength(1);
    expect(logs.join("\n")).not.toMatch(/action failed:/);
    expect(tracker.snapshot().get("ses_b")).toEqual({ phase: "open", paneId: "%8", closeAt: null });
  });

  it("logs a skipped relayout after a close and still forgets the session", async () => {
    const tmux = makeTmux({
      paneIds: ["%8"],
      relayoutResult: { ok: true, error: null, skipped: "window shared with opencode-mux %9" },
    });
    const tracker = new PaneTracker({ graceMs: 1_000, closePanes: "auto" });
    const logs: string[] = [];
    const w = createWatcher(deps({ tmux, tracker, log: (l) => logs.push(l) }));
    await w.dispatch(created("ses_c", "ses_p"));
    await w.dispatch(execSucceeded("ses_c"));
    await w.tick(3_000);
    expect(tmux.kills).toEqual(["%8"]);
    expect(logs.filter((l) => l === "layout skipped: window shared with opencode-mux %9")).toHaveLength(1);
    expect(logs.join("\n")).not.toMatch(/action failed:/);
    expect(tracker.snapshot().get("ses_c")).toBeUndefined();
  });
});

describe("isSameProject", () => {
  it("matches the same directory, with or without a trailing slash", () => {
    expect(isSameProject("/work/app", "/work/app")).toBe(true);
    expect(isSameProject("/work/app/", "/work/app")).toBe(true);
  });

  it("matches a project root and its subdirectories in both directions", () => {
    expect(isSameProject("/work/app", "/work/app/packages/web")).toBe(true);
    expect(isSameProject("/work/app/packages/web", "/work/app")).toBe(true);
  });

  it("keeps sibling directories with a shared prefix apart", () => {
    expect(isSameProject("/work/app", "/work/app-2")).toBe(false);
    expect(isSameProject("/work/apple", "/work/app")).toBe(false);
  });
});

describe("createWatcher with project scoping (concurrent instances)", () => {
  const scoped = (over: Partial<Parameters<typeof createWatcher>[0]> = {}) =>
    deps({ parentID: null, projectDirectories: ["/work/mine"], ...over });

  it("panes a subagent whose parent belongs to this project", async () => {
    const tmux = makeTmux({ paneIds: ["%1", "%2"] });
    const w = createWatcher(
      scoped({
        tmux,
        client: makeClient({
          parents: {
            ses_mine: sessionInfo("ses_mine", undefined as unknown as string, "/work/mine"),
            ses_theirs: sessionInfo("ses_theirs", undefined as unknown as string, "/work/theirs"),
          },
        }),
      }),
    );
    await w.dispatch(created("ses_child_a", "ses_mine"));
    await w.dispatch(created("ses_child_b", "ses_theirs"));
    expect(tmux.splits).toHaveLength(1);
    expect(tmux.splits[0]!.argv).toContain("ses_child_a");
  });

  it("looks a parent's directory up once and reuses it", async () => {
    const tmux = makeTmux({ paneIds: ["%1", "%2"] });
    const client = makeClient({
      parents: { ses_mine: sessionInfo("ses_mine", undefined as unknown as string, "/work/mine") },
    });
    const get = vi.spyOn(client.session, "get");
    const w = createWatcher(scoped({ tmux, client }));
    await w.dispatch(created("ses_a", "ses_mine"));
    await w.dispatch(created("ses_b", "ses_mine"));
    expect(tmux.splits).toHaveLength(2);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("caps the parent-scope cache at 256 entries with FIFO eviction", async () => {
    // The children are deliberately of another project, so no pane opens: this
    // test is about the cache (session.get calls), not about pane churn.
    const parents: Record<string, SessionInfo> = {};
    for (let i = 0; i < 257; i += 1) {
      parents[`ses_p${i}`] = sessionInfo(`ses_p${i}`, undefined as unknown as string, "/work/theirs");
    }
    const tmux = makeTmux({ paneIds: [] });
    const client = makeClient({ parents });
    const get = vi.spyOn(client.session, "get");
    const lookups = (parentID: string) => get.mock.calls.filter(([input]) => input.sessionID === parentID).length;
    const w = createWatcher(scoped({ tmux, client }));

    for (let i = 0; i < 257; i += 1) {
      await w.dispatch(created(`ses_c${i}`, `ses_p${i}`));
      expect(lookups(`ses_p${i}`)).toBe(1);
    }
    expect(tmux.splits).toEqual([]); // foreign project: no pane was opened

    // The first parent fell out of the 256-entry window: a fresh lookup.
    await w.dispatch(created("ses_c0b", "ses_p0"));
    expect(lookups("ses_p0")).toBe(2);
    // The newest parent is still cached: no extra lookup (FIFO, not "always miss").
    await w.dispatch(created("ses_c256b", "ses_p256"));
    expect(lookups("ses_p256")).toBe(1);
  });

  it("treats a subdirectory of this project as ours", async () => {
    const tmux = makeTmux({ paneIds: ["%1"] });
    const w = createWatcher(
      scoped({
        tmux,
        client: makeClient({
          parents: { ses_root: sessionInfo("ses_root", undefined as unknown as string, "/work/mine/packages/web") },
        }),
      }),
    );
    await w.dispatch(created("ses_child", "ses_root"));
    expect(tmux.splits).toHaveLength(1);
  });

  it("skips and logs when the parent cannot be looked up, without caching the failure", async () => {
    const tmux = makeTmux({ paneIds: ["%1"] });
    const logs: string[] = [];
    const client = makeClient({ getError: "daemon hiccup" });
    const w = createWatcher(scoped({ tmux, client, log: (l) => logs.push(l) }));
    await w.dispatch(created("ses_child", "ses_mine"));
    expect(tmux.splits).toEqual([]);
    expect(logs.join("\n")).toMatch(/scope lookup failed: ses_mine — Error: daemon hiccup/);
  });

  it("adopts only running children of this project", async () => {
    const tmux = makeTmux({ paneIds: ["%1"] });
    const client = makeClient({
      children: [sessionInfo("ses_a", "ses_mine"), sessionInfo("ses_b", "ses_theirs")],
      active: { ses_a: { type: "running" }, ses_b: { type: "running" } },
      parents: {
        ses_mine: sessionInfo("ses_mine", undefined as unknown as string, "/work/mine"),
        ses_theirs: sessionInfo("ses_theirs", undefined as unknown as string, "/work/theirs"),
      },
    });
    const w = createWatcher(scoped({ tmux, client }));
    await w.adopt();
    expect(tmux.splits.map((s) => s.argv[s.argv.indexOf("-s") + 1])).toEqual(["ses_a"]);
  });

  it("does not reopen a busy child of another project", async () => {
    const tmux = makeTmux({ paneIds: ["%1"] });
    const client = makeClient({
      children: [sessionInfo("ses_child", "ses_theirs")],
      parents: { ses_theirs: sessionInfo("ses_theirs", undefined as unknown as string, "/work/theirs") },
    });
    const w = createWatcher(scoped({ tmux, client }));
    await w.dispatch(busy("ses_child"));
    expect(tmux.splits).toEqual([]);
  });

  it("keeps watching every child when a parent is configured explicitly", async () => {
    const tmux = makeTmux({ paneIds: ["%1"] });
    const client = makeClient({});
    const get = vi.spyOn(client.session, "get");
    const w = createWatcher(
      deps({ tmux, client, parentID: "ses_p", projectDirectories: ["/work/mine"] }),
    );
    await w.dispatch(created("ses_child", "ses_p"));
    expect(tmux.splits).toHaveLength(1);
    expect(get).not.toHaveBeenCalled();
  });

  it("invalidates the cached scope verdict when a parent session moves", async () => {
    const tmux = makeTmux({ paneIds: ["%1", "%2"] });
    const over: { parents: Record<string, SessionInfo> } = {
      parents: { ses_p: sessionInfo("ses_p", undefined as unknown as string, "/work/mine") },
    };
    const client = makeClient(over);
    const get = vi.spyOn(client.session, "get");
    const w = createWatcher(scoped({ tmux, client }));
    await w.dispatch(created("ses_a", "ses_p"));
    expect(tmux.splits).toHaveLength(1);
    expect(get).toHaveBeenCalledTimes(1);

    // The session moved out of this project: the cached "ours" verdict is stale.
    over.parents.ses_p = sessionInfo("ses_p", undefined as unknown as string, "/work/theirs");
    await w.dispatch(moved("ses_p"));
    await w.dispatch(created("ses_b", "ses_p"));
    expect(get).toHaveBeenCalledTimes(2);
    expect(tmux.splits).toHaveLength(1); // still only ses_a
  });

  it("does not cache a failed scope lookup: it retries and panes once it succeeds", async () => {
    const tmux = makeTmux({ paneIds: ["%1"] });
    const over: { parents: Record<string, SessionInfo>; getError?: string } = {
      parents: { ses_p: sessionInfo("ses_p", undefined as unknown as string, "/work/mine") },
      getError: "daemon hiccup",
    };
    const client = makeClient(over);
    const get = vi.spyOn(client.session, "get");
    const w = createWatcher(scoped({ tmux, client }));
    await w.dispatch(created("ses_a", "ses_p"));
    await w.dispatch(created("ses_b", "ses_p"));
    expect(get).toHaveBeenCalledTimes(2); // the failure was not cached
    expect(tmux.splits).toEqual([]);

    over.getError = undefined;
    await w.dispatch(created("ses_c", "ses_p"));
    expect(get).toHaveBeenCalledTimes(3);
    expect(tmux.splits).toHaveLength(1);
    expect(tmux.splits[0]!.argv).toContain("ses_c");
  });

  it("keeps two concurrent watchers on their own project and target pane", async () => {
    const client = makeClient({
      parents: {
        ses_a: sessionInfo("ses_a", undefined as unknown as string, "/work/a"),
        ses_b: sessionInfo("ses_b", undefined as unknown as string, "/work/b"),
      },
    });
    const tmuxA = makeTmux({ paneIds: ["%a1"] });
    const tmuxB = makeTmux({ paneIds: ["%b1"] });
    const wA = createWatcher(
      deps({ parentID: null, projectDirectories: ["/work/a"], targetPane: "%a", client, tmux: tmuxA }),
    );
    const wB = createWatcher(
      deps({ parentID: null, projectDirectories: ["/work/b"], targetPane: "%b", client, tmux: tmuxB }),
    );

    // Each child is dispatched to both watchers; only its own project's child
    // is paned, in that watcher's own window.
    await wA.dispatch(created("ses_a1", "ses_a"));
    await wB.dispatch(created("ses_a1", "ses_a"));
    await wA.dispatch(created("ses_b1", "ses_b"));
    await wB.dispatch(created("ses_b1", "ses_b"));
    expect(tmuxA.splits.map((s) => s.targetPane)).toEqual(["%a"]);
    expect(tmuxA.splits[0]!.argv).toContain("ses_a1");
    expect(tmuxB.splits.map((s) => s.targetPane)).toEqual(["%b"]);
    expect(tmuxB.splits[0]!.argv).toContain("ses_b1");

    // Closing each watcher's pane re-lays out only its own window.
    await wA.dispatch(execSucceeded("ses_a1"));
    await wB.dispatch(execSucceeded("ses_b1"));
    await wA.tick(2_000);
    await wB.tick(2_000);
    expect(tmuxA.kills).toEqual(["%a1"]);
    expect(tmuxB.kills).toEqual(["%b1"]);
    expect(tmuxA.relayouts).toEqual([{ targetPane: "%a", layout: "main-vertical", mainPaneSize: undefined }]);
    expect(tmuxB.relayouts).toEqual([{ targetPane: "%b", layout: "main-vertical", mainPaneSize: undefined }]);
  });
});
