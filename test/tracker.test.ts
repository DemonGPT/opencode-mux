import { describe, expect, it } from "vitest";
import { PaneTracker } from "../src/tracker.ts";

const auto = { graceMs: 15_000, closePanes: "auto" as const };
const keep = { graceMs: 15_000, closePanes: "keep" as const };

describe("PaneTracker", () => {
  it("emits an open action and records the open phase", () => {
    const t = new PaneTracker(auto);
    t.reserve("ses_a");
    expect(t.open("ses_a", "paneX", 0)).toEqual({ kind: "open", sessionID: "ses_a", paneId: "paneX" });
    expect(t.snapshot().get("ses_a")).toEqual({ phase: "open", paneId: "paneX", closeAt: null });
  });

  it("ignores open for unknown sessions and duplicate opens", () => {
    const t = new PaneTracker(auto);
    t.reserve("ses_a");
    expect(t.open("ghost", "paneX", 0)).toBeNull();
    t.open("ses_a", "paneX", 0);
    expect(t.open("ses_a", "paneY", 1)).toBeNull();
    expect(t.snapshot().get("ses_a")).toEqual({ phase: "open", paneId: "paneX", closeAt: null });
  });

  it("auto mode schedules a close at now+grace and closes at the deadline", () => {
    const t = new PaneTracker(auto);
    t.reserve("ses_a");
    t.open("ses_a", "paneX", 0);
    expect(t.markTerminal("ses_a", 1_000)).toBeNull();
    expect(t.snapshot().get("ses_a")).toEqual({ phase: "closing", paneId: "paneX", closeAt: 16_000 });
    expect(t.tick(15_999)).toEqual([]);
    expect(t.tick(16_000)).toEqual([{ kind: "close", sessionID: "ses_a", paneId: "paneX" }]);
    expect(t.tick(100_000)).toEqual([]);
  });

  it("busy on closing reverts to open and cancels the pending close", () => {
    const t = new PaneTracker(auto);
    t.reserve("ses_a");
    t.open("ses_a", "paneX", 0);
    t.markTerminal("ses_a", 0);
    t.markBusy("ses_a");
    expect(t.snapshot().get("ses_a")).toEqual({ phase: "open", paneId: "paneX", closeAt: null });
    expect(t.tick(100_000)).toEqual([]);
  });

  it("terminal after a busy revival schedules a fresh close", () => {
    const t = new PaneTracker(auto);
    t.reserve("ses_a");
    t.open("ses_a", "paneX", 101);
    t.markTerminal("ses_a", 200);
    t.markBusy("ses_a");
    t.markTerminal("ses_a", 500);
    expect(t.snapshot().get("ses_a")).toEqual({ phase: "closing", paneId: "paneX", closeAt: 15_500 });
    expect(t.tick(15_500)).toEqual([{ kind: "close", sessionID: "ses_a", paneId: "paneX" }]);
  });

  it("terminal while pending closes immediately once the pane opens", () => {
    const t = new PaneTracker(auto);
    t.reserve("ses_a");
    expect(t.markTerminal("ses_a", 100)).toBeNull();
    expect(t.snapshot().get("ses_a")).toEqual({ phase: "pending", terminal: true });
    expect(t.open("ses_a", "paneX", 100)).toEqual({ kind: "open", sessionID: "ses_a", paneId: "paneX" });
    expect(t.snapshot().get("ses_a")).toEqual({ phase: "closing", paneId: "paneX", closeAt: 100 });
    expect(t.tick(100)).toEqual([{ kind: "close", sessionID: "ses_a", paneId: "paneX" }]);
  });

  it("keep mode keeps the pane open forever", () => {
    const t = new PaneTracker(keep);
    t.reserve("ses_a");
    t.open("ses_a", "paneX", 0);
    t.markTerminal("ses_a", 1);
    expect(t.snapshot().get("ses_a")).toEqual({ phase: "kept", paneId: "paneX" });
    expect(t.tick(1e9)).toEqual([]);
    expect(t.markTerminal("ses_a", 2)).toBeNull();
    expect(t.markBusy("ses_a")).toBeNull();
  });

  it("terminal on an already-closing session keeps the original deadline", () => {
    const t = new PaneTracker(auto);
    t.reserve("ses_b");
    t.open("ses_b", "paneY", 0);
    t.markTerminal("ses_b", 0);
    t.markTerminal("ses_b", 10_000);
    expect(t.snapshot().get("ses_b")).toEqual({ phase: "closing", paneId: "paneY", closeAt: 15_000 });
    expect(t.tick(15_000)).toEqual([{ kind: "close", sessionID: "ses_b", paneId: "paneY" }]);
    expect(t.markBusy("ses_b")).toBeNull();
    expect(t.tick(20_000)).toEqual([]);
  });

  it("terminal and busy for unknown sessions are no-ops", () => {
    const t = new PaneTracker(auto);
    expect(t.markTerminal("ghost", 0)).toBeNull();
    expect(t.markBusy("ghost")).toBeNull();
    expect(t.tick(0)).toEqual([]);
  });

  it("reserves unknown sessions once and removes state", () => {
    const t = new PaneTracker(auto);
    expect(t.reserve("ses_r")).toBe(true);
    expect(t.reserve("ses_r")).toBe(false);
    expect(t.snapshot().get("ses_r")).toEqual({ phase: "pending", terminal: false });
    t.remove("ses_r");
    expect(t.snapshot().get("ses_r")).toBeUndefined();
    expect(t.reserve("ses_r")).toBe(true);
  });
});
