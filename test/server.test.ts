import { describe, expect, it } from "vitest";
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client";
import { childSessions, connectServer, events } from "../src/server.ts";

const client = (list: (input: unknown) => Promise<{ data: unknown[]; cursor: { next: string | null; previous: string | null } }>, subscribe?: () => unknown): OpenCodeClient =>
  ({ session: { list }, event: { subscribe: subscribe ?? (() => undefined) } } as unknown as OpenCodeClient);

const sessionInfo = (id: string, parentID?: string) => ({
  id,
  parentID,
  projectID: "p",
  cost: {},
  tokens: {},
  time: { created: 1, updated: 1 },
  location: { kind: "local", directory: "/x", project: "p" },
});

describe("connectServer", () => {
  it("uses injected ensure/headers and builds a client", async () => {
    let ensureCalls = 0;
    let headersInput: unknown;
    const conn = await connectServer({
      ensure: async () => {
        ensureCalls++;
        return { url: "http://127.0.0.1:1" };
      },
      headers: (endpoint: { url: string }) => {
        headersInput = endpoint;
        return undefined;
      },
    });
    expect(ensureCalls).toBe(1);
    expect(headersInput).toEqual({ url: "http://127.0.0.1:1" });
    expect(conn.url).toBe("http://127.0.0.1:1");
    expect(typeof conn.client.session.list).toBe("function");
    expect(typeof conn.client.event.subscribe).toBe("function");
  });
});

describe("childSessions", () => {
  it("lists without a parent filter when parentID is null and keeps only children", async () => {
    let input: unknown;
    const c = client(async (i) => {
      input = i;
      return { data: [sessionInfo("ses_child", "ses_p"), sessionInfo("ses_top")], cursor: { next: null, previous: null } };
    });
    const found = await childSessions(c, null);
    expect(input).toEqual({});
    expect(found.map((s) => s.id)).toEqual(["ses_child"]);
  });

  it("passes the parentID filter through", async () => {
    let input: unknown;
    const c = client(async (i) => {
      input = i;
      return { data: [sessionInfo("ses_child", "ses_p")], cursor: { next: null, previous: null } };
    });
    const found = await childSessions(c, "ses_p");
    expect(input).toEqual({ parentID: "ses_p" });
    expect(found.map((s) => s.id)).toEqual(["ses_child"]);
  });
});

describe("events", () => {
  it("subscribes with the given signal", async () => {
    const sentinel = (async function* () {})() as AsyncIterable<OpenCodeEvent>;
    const controller = new AbortController();
    const c = client(
      async () => ({ data: [], cursor: { next: null, previous: null } }),
      (options?: unknown) => {
        expect(options).toEqual({ signal: controller.signal });
        return sentinel;
      },
    );
    const stream = await events(c, controller.signal);
    expect(stream).toBe(sentinel);
  });
});
