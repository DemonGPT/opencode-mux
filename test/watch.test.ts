import { describe, expect, it, vi } from "vitest";
import type { OpenCodeClient, OpenCodeEvent, SessionInfo } from "@opencode/client";
import { PaneTracker } from "../src/tracker.ts";
import type { Tmux } from "../src/tmux.ts";
import { createWatcher, defaultPaneArgv } from "../src/watch.ts";

const created = (sessionID: string, parentID: string, slug = "coder"): OpenCodeEvent =>
  ({ type: "session.created", data: { sessionID, parentID, slug } }) as unknown as OpenCodeEvent;
const parentless = (sessionID: string): OpenCodeEvent =>
  ({ type: "session.created", data: { sessionID, slug: "top" } }) as unknown as OpenCodeEvent;
const idle = (sessionID: string): OpenCodeEvent =>
  ({ type: "session.idle", data: { sessionID } }) as unknown as OpenCodeEvent;
const busy = (sessionID: string): OpenCodeEvent =>
  ({ type: "session.status", data: { sessionID, status: { type: "busy" } } }) as unknown as OpenCodeEvent;

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

function makeTmux(over: { paneIds?: string[]; splits?: Array<{ targetPane: string; layout: string; argv: string[] }>; kills?: string[] } = {}): Tmux & { splits: Array<{ targetPane: string; layout: string; argv: string[] }>; kills: string[] } {
  const splits = over.splits ?? [];
  const kills = over.kills ?? [];
  let next = 0;
  return {
    splits,
    kills,
    async splitPane(input) {
      splits.push(input);
      const paneId = over.paneIds?.[next++];
      return paneId !== undefined ? { ok: true, error: null, paneId } : { ok: false, error: "no pane", paneId: null };
    },
    async killPane(paneId) {
      kills.push(paneId);
      return { ok: true, error: null };
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
  it("defaultPaneArgv builds the opencode attach command", () => {
    expect(defaultPaneArgv("ses_c")).toEqual(["opencode", "-s", "ses_c"]);
  });

  it("opens a pane for a matching created event and records the open phase", async () => {
    const tmux = makeTmux({ paneIds: ["%7"] });
    const tracker = new PaneTracker({ graceMs: 1_000, closePanes: "auto" });
    const w = createWatcher(deps({ tmux, tracker }));
    await w.dispatch(created("ses_c", "ses_p"));
    expect(tmux.splits).toEqual([{ targetPane: "%0", layout: "main-vertical", argv: ["opencode", "-s", "ses_c"] }]);
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

  it("adopts existing children, closing already-finished ones immediately", async () => {
    const tmux = makeTmux({ paneIds: ["%1", "%2"] });
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
    expect(tmux.splits.map((s) => s.argv[2])).toEqual(["ses_running", "ses_done"]);
    expect(tracker.snapshot().get("ses_running")).toEqual({ phase: "open", paneId: "%1", closeAt: null });
    expect(tracker.snapshot().get("ses_done")).toBeUndefined();
    expect(tmux.kills).toEqual(["%2"]);
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
});
