import { describe, expect, it } from "vitest";
import type { OpenCodeEvent, SessionInfo } from "@opencode/client";
import { childTitle, classifyEvent, isChildSession } from "../src/session.ts";

const ev = (event: unknown): OpenCodeEvent => event as unknown as OpenCodeEvent;

describe("classifyEvent", () => {
  it("maps session.created to created with parent fields", () => {
    const c = classifyEvent(
      ev({ type: "session.created", data: { sessionID: "ses_c", slug: "coder", parentID: "ses_p", title: "Coder" } }),
    );
    expect(c).toEqual({ kind: "created", sessionID: "ses_c", parentID: "ses_p", title: "Coder", slug: "coder" });
  });

  it("maps session.created without a parent to created without parentID", () => {
    const c = classifyEvent(ev({ type: "session.created", data: { sessionID: "ses_x", slug: "top" } }));
    expect(c).toEqual({ kind: "created", sessionID: "ses_x", slug: "top" });
    expect(c.kind === "created" && c.parentID).toBeUndefined();
  });

  it("maps session.idle and session.deleted to terminal", () => {
    expect(classifyEvent(ev({ type: "session.idle", data: { sessionID: "ses_a" } }))).toEqual({
      kind: "terminal",
      sessionID: "ses_a",
    });
    expect(classifyEvent(ev({ type: "session.deleted", data: { sessionID: "ses_b" } }))).toEqual({
      kind: "terminal",
      sessionID: "ses_b",
    });
  });

  it("maps session.execution terminators to terminal and started to busy", () => {
    // session.idle is deprecated and session.status is client-derived; the daemon's
    // real completion signal is session.execution.* (opencode's own reducer derives
    // session_status idle/busy from these exact events).
    expect(classifyEvent(ev({ type: "session.execution.succeeded", data: { sessionID: "ses_d" } }))).toEqual({
      kind: "terminal",
      sessionID: "ses_d",
    });
    expect(classifyEvent(ev({ type: "session.execution.failed", data: { sessionID: "ses_d" } }))).toEqual({
      kind: "terminal",
      sessionID: "ses_d",
    });
    expect(classifyEvent(ev({ type: "session.execution.interrupted", data: { sessionID: "ses_d" } }))).toEqual({
      kind: "terminal",
      sessionID: "ses_d",
    });
    expect(classifyEvent(ev({ type: "session.execution.started", data: { sessionID: "ses_d" } }))).toEqual({
      kind: "busy",
      sessionID: "ses_d",
    });
  });

  it("maps session.status idle to terminal and busy to busy", () => {
    expect(classifyEvent(ev({ type: "session.status", data: { sessionID: "ses_c", status: { type: "idle" } } }))).toEqual({
      kind: "terminal",
      sessionID: "ses_c",
    });
    expect(classifyEvent(ev({ type: "session.status", data: { sessionID: "ses_c", status: { type: "busy" } } }))).toEqual({
      kind: "busy",
      sessionID: "ses_c",
    });
  });

  it("ignores retry status and unrelated events", () => {
    expect(
      classifyEvent(
        ev({ type: "session.status", data: { sessionID: "ses_c", status: { type: "retry", attempt: 1, message: "m", next: 5 } } }),
      ),
    ).toEqual({ kind: "other" });
    expect(classifyEvent(ev({ type: "server.connected", data: {} }))).toEqual({ kind: "other" });
    expect(classifyEvent(ev({ type: "session.step.ended", data: {} }))).toEqual({ kind: "other" });
  });
});

describe("isChildSession", () => {
  it("is true only when parentID is present", () => {
    expect(isChildSession({ parentID: "ses_p" } as SessionInfo)).toBe(true);
    expect(isChildSession({} as SessionInfo)).toBe(false);
  });
});

describe("childTitle", () => {
  it("prefers a non-empty title, else the fallback", () => {
    expect(childTitle("Coder", "coder")).toBe("Coder");
    expect(childTitle("", "coder")).toBe("coder");
    expect(childTitle(undefined, "ses_c")).toBe("ses_c");
  });
});