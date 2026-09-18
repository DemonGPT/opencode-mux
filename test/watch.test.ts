import { describe, expect, it, vi } from "vitest";
import type { OpenCodeClient, OpenCodeEvent, SessionInfo } from "@opencode/client";
import { PaneTracker } from "../src/tracker.ts";
import type { BorderStyles, Tmux, TmuxApplyResult } from "../src/tmux.ts";
import { createWatcher, defaultPaneArgv } from "../src/watch.ts";

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

const sessionInfo = (id: string, parentID: string): SessionInfo =>
  ({ id, parentID, projectID: "p", cost: {}, tokens: {}, time: { created: 1, updated: 1 }, location: { kind: "local", directory: "/x", project: "p" } }) as unknown as SessionInfo;

function makeClient(over: { active?: Record<string, { type: "running" }>; children?: SessionInfo[]; stream?: (opts: { signal?: AbortSignal }) => AsyncIterable<OpenCodeEvent> }): OpenCodeClient {
  const subscribe = (opts: { signal?: AbortSignal }) =>
    over.stream ? over.stream(opts) : (async function* () {})();
  return {
    session: {
      async list() {
        return { data: over.children ?? [], cursor: { next: null, previous: null } };
      },
      async active() {
        return over.active ?? {};
      },
    },
    event: { subscribe },
  } as unknown as OpenCodeClient;
}

function makeTmux(over: { paneIds?: string[]; splits?: Array<{ targetPane: string; layout: string; argv: string[] }>; kills?: string[]; borderStyles?: Array<{ targetPane: string; styles: BorderStyles }>; clears?: string[]; borderResult?: TmuxApplyResult; clearResult?: TmuxApplyResult } = {}): Tmux & { splits: Array<{ targetPane: string; layout: string; argv: string[] }>; kills: string[]; borderStyles: Array<{ targetPane: string; styles: BorderStyles }>; clears: string[] } {
  const splits = over.splits ?? [];
  const kills = over.kills ?? [];
  const borderStyles = over.borderStyles ?? [];
  const clears = over.clears ?? [];
  let next = 0;
  return {
    splits,
    kills,
    borderStyles,
    clears,
    async splitPane(input) {
      splits.push(input);
      const paneId = over.paneIds?.[next++];
      return paneId !== undefined ? { ok: true, error: null, paneId } : { ok: false, error: "no pane", paneId: null };
    },
    async killPane(paneId) {
      kills.push(paneId);
      return { ok: true, error: null };
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
    expect(defaultPaneArgv("ses_c")).toEqual(["opencode", "mini", "-s", "ses_c"]);
  });

  it("opens a pane for a matching created event and records the open phase", async () => {
    const tmux = makeTmux({ paneIds: ["%7"] });
    const tracker = new PaneTracker({ graceMs: 1_000, closePanes: "auto" });
    const w = createWatcher(deps({ tmux, tracker }));
    await w.dispatch(created("ses_c", "ses_p"));
    expect(tmux.splits).toEqual([{ targetPane: "%0", layout: "main-vertical", argv: ["opencode", "mini", "-s", "ses_c"] }]);
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
    expect(tmux.splits.map((s) => s.argv[3])).toEqual(["ses_running"]);
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

  it("logs and drops the state when the split fails", async () => {
    const tmux = makeTmux({ paneIds: [] });
    const tracker = new PaneTracker({ graceMs: 1_000, closePanes: "auto" });
    const logs: string[] = [];
    const w = createWatcher(deps({ tmux, tracker, log: (l) => logs.push(l) }));
    await w.dispatch(created("ses_c", "ses_p"));
    expect(logs.join("\n")).toMatch(/action failed: split-window/);
    expect(tracker.snapshot().get("ses_c")).toBeUndefined();
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

  it("start subscribes to the event stream and ends when it ends", async () => {
    const tmux = makeTmux({ paneIds: ["%8"] });
    const tracker = new PaneTracker({ graceMs: 1_000, closePanes: "auto" });
    let subscribeOpts: { signal?: AbortSignal } = {};
    const client = makeClient({
      stream: async function* (opts) {
        subscribeOpts = opts;
        yield created("ses_c", "ses_p");
        yield idle("ses_c");
        return;
      },
    });
    const w = createWatcher(deps({ client, tmux, tracker, tickEveryMs: 10_000 }));
    const controller = new AbortController();
    await w.start(controller.signal);
    expect(subscribeOpts.signal).toBe(controller.signal);
    expect(tmux.splits).toHaveLength(1);
    expect(subscribeOpts.signal?.aborted).toBe(false);
    expect(tracker.snapshot().get("ses_c")).toEqual({ phase: "closing", paneId: "%8", closeAt: 2_000 });
    await w.tick(2_000);
    expect(tmux.kills).toEqual(["%8"]);
  });

  it("applies theme styles once at start when provided", async () => {
    const tmux = makeTmux({ paneIds: ["%1"] });
    const styles = { inactive: "fg=#737aa2", active: "fg=#9099b2" };
    const themeStyles = { current: () => styles };
    const w = createWatcher(deps({ tmux, themeStyles, tickEveryMs: 10_000 }));
    const controller = new AbortController();
    await w.start(controller.signal);
    expect(tmux.borderStyles).toEqual([{ targetPane: "%0", styles }]);
    expect(tmux.clears).toEqual([]);
    expect(tmux.splits).toEqual([]);
  });

  it("makes zero styling calls when themeStyles is absent", async () => {
    const tmux = makeTmux({ paneIds: ["%1"] });
    const w = createWatcher(deps({ tmux, tickEveryMs: 10_000 }));
    const controller = new AbortController();
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
    await w.start(controller.signal);
    expect(logs.join("\n")).toMatch(/styling failed: boom/);
    await w.tick(2_000);
    await w.tick(3_000);
    expect(logs.filter((l) => l.includes("styling failed: boom")).length).toBeLessThanOrEqual(1);
    current = b;
    await w.tick(4_000); // changed again → one more attempt (and one more log)
    expect(logs.filter((l) => l.includes("styling failed: boom")).length).toBeLessThanOrEqual(2);
  });
});
