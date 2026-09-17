import type { OpenCodeEvent, SessionInfo } from "@opencode/client";

export type EventClass =
  | { kind: "created"; sessionID: string; parentID?: string; title?: string; slug: string }
  | { kind: "terminal"; sessionID: string }
  | { kind: "busy"; sessionID: string }
  | { kind: "other" };

/** Classifies an SDK event into what the watcher reacts to. */
export function classifyEvent(event: OpenCodeEvent): EventClass {
  switch (event.type) {
    case "session.created":
      return {
        kind: "created",
        sessionID: event.data.sessionID,
        parentID: event.data.parentID,
        title: event.data.title,
        slug: event.data.slug,
      };
    case "session.idle":
    case "session.deleted":
      return { kind: "terminal", sessionID: event.data.sessionID };
    case "session.execution.started":
      return { kind: "busy", sessionID: event.data.sessionID };
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
      // The daemon's turn-lifecycle signal (session.idle is deprecated and
      // session.status is client-derived): opencode's own app reducer derives
      // session busy/idle from these exact events.
      return { kind: "terminal", sessionID: event.data.sessionID };
    case "session.status":
      if (event.data.status.type === "idle") return { kind: "terminal", sessionID: event.data.sessionID };
      if (event.data.status.type === "busy") return { kind: "busy", sessionID: event.data.sessionID };
      return { kind: "other" };
    default:
      return { kind: "other" };
  }
}

/** True when the session is a subagent session (has a parent). */
export function isChildSession(info: SessionInfo): boolean {
  return info.parentID !== undefined;
}

/** Pane label: non-empty title, otherwise the fallback (slug or session id). */
export function childTitle(title: string | undefined, fallback: string): string {
  return title !== undefined && title !== "" ? title : fallback;
}