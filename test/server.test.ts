import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client";

/**
 * Both SDK lines are mocked so the generation branch in connectServer is
 * observable: a test passes even if the wrong SDK builds the client only when
 * nobody records which one ran. `vi.hoisted` keeps the fns available to the
 * hoisted vi.mock factories.
 */
const sdk = vi.hoisted(() => {
  const endpoint = (url: string) => async () => ({ url });
  const makeClient = (kind: string, options: unknown) => ({
    kind,
    options,
    session: { list: async () => ({ data: [], cursor: { next: null, previous: null } }) },
    event: { subscribe: () => undefined },
  });
  return {
    newEnsure: vi.fn(endpoint("http://127.0.0.1:new")),
    newHeaders: vi.fn((_endpoint: { url: string }) => ({ authorization: "Basic new" })),
    newMake: vi.fn((options: unknown) => makeClient("new", options)),
    legacyEnsure: vi.fn(endpoint("http://127.0.0.1:legacy")),
    legacyHeaders: vi.fn((_endpoint: { url: string }) => ({ authorization: "Basic legacy" })),
    legacyMake: vi.fn((options: unknown) => makeClient("legacy", options)),
  };
});

vi.mock("@opencode/client", () => ({ OpenCode: { make: sdk.newMake } }));
vi.mock("@opencode/client/service", () => ({ Service: { ensure: sdk.newEnsure, headers: sdk.newHeaders } }));
vi.mock("@opencode/client-legacy", () => ({ OpenCode: { make: sdk.legacyMake } }));
vi.mock("@opencode/client-legacy/service", () => ({ Service: { ensure: sdk.legacyEnsure, headers: sdk.legacyHeaders } }));

// Imported after the mocks are registered (vi.mock is hoisted above imports).
import { childSessions, connectServer, events } from "../src/server.ts";

const client = (
  list: (input: unknown) => Promise<{ data: unknown[]; cursor: { next: string | null; previous: string | null } }>,
  subscribe?: () => unknown,
): OpenCodeClient => ({ session: { list }, event: { subscribe: subscribe ?? (() => undefined) } }) as unknown as OpenCodeClient;

const sessionInfo = (id: string, parentID?: string) => ({
  id,
  parentID,
  projectID: "p",
  cost: {},
  tokens: {},
  time: { created: 1, updated: 1 },
  location: { kind: "local", directory: "/x", project: "p" },
});

beforeEach(() => {
  for (const fn of Object.values(sdk)) fn.mockClear();
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
    // Injection replaces only the service lookup: the default (new) client line still builds.
    expect(sdk.newMake).toHaveBeenCalledTimes(1);
    expect(sdk.newMake).toHaveBeenCalledWith({ baseUrl: "http://127.0.0.1:1", headers: undefined });
    expect(sdk.newEnsure).not.toHaveBeenCalled();
    expect(sdk.newHeaders).not.toHaveBeenCalled();
  });

  it("connects and builds the client through the NEW SDK line by default", async () => {
    const conn = await connectServer();
    expect(conn.url).toBe("http://127.0.0.1:new");
    expect(sdk.newEnsure).toHaveBeenCalledTimes(1);
    expect(sdk.newHeaders).toHaveBeenCalledWith({ url: "http://127.0.0.1:new" });
    expect(sdk.newMake).toHaveBeenCalledTimes(1);
    expect(sdk.newMake).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:new",
      headers: { authorization: "Basic new" },
    });
    expect(conn.client).toBe(sdk.newMake.mock.results[0]!.value);
    expect(sdk.legacyEnsure).not.toHaveBeenCalled();
    expect(sdk.legacyHeaders).not.toHaveBeenCalled();
    expect(sdk.legacyMake).not.toHaveBeenCalled();
  });

  it("connects and builds the client through the NEW SDK line when generation is new", async () => {
    const conn = await connectServer({ generation: "new" });
    expect(conn.url).toBe("http://127.0.0.1:new");
    expect(sdk.newEnsure).toHaveBeenCalledTimes(1);
    expect(sdk.newMake).toHaveBeenCalledTimes(1);
    expect(sdk.legacyEnsure).not.toHaveBeenCalled();
    expect(sdk.legacyHeaders).not.toHaveBeenCalled();
    expect(sdk.legacyMake).not.toHaveBeenCalled();
  });

  it("builds the client from the legacy SDK line ONLY when generation is legacy", async () => {
    const conn = await connectServer({ generation: "legacy" });
    expect(conn.url).toBe("http://127.0.0.1:legacy");
    expect(sdk.legacyEnsure).toHaveBeenCalledTimes(1);
    expect(sdk.legacyHeaders).toHaveBeenCalledWith({ url: "http://127.0.0.1:legacy" });
    expect(sdk.legacyMake).toHaveBeenCalledTimes(1);
    expect(sdk.legacyMake).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:legacy",
      headers: { authorization: "Basic legacy" },
    });
    expect(conn.client).toBe(sdk.legacyMake.mock.results[0]!.value);
    expect(typeof conn.client.session.list).toBe("function");
    expect(typeof conn.client.event.subscribe).toBe("function");
    // The new line must not even be probed.
    expect(sdk.newEnsure).not.toHaveBeenCalled();
    expect(sdk.newHeaders).not.toHaveBeenCalled();
    expect(sdk.newMake).not.toHaveBeenCalled();
  });

  it("keeps injected ensure/headers on the legacy path while still using the legacy client", async () => {
    const injectedEnsure = vi.fn(async () => ({ url: "http://127.0.0.1:injected" }));
    const injectedHeaders = vi.fn(() => ({ authorization: "Basic injected" }));
    const conn = await connectServer({ generation: "legacy", ensure: injectedEnsure, headers: injectedHeaders });
    expect(injectedEnsure).toHaveBeenCalledTimes(1);
    expect(injectedHeaders).toHaveBeenCalledWith({ url: "http://127.0.0.1:injected" });
    expect(conn.url).toBe("http://127.0.0.1:injected");
    expect(sdk.legacyMake).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:injected",
      headers: { authorization: "Basic injected" },
    });
    expect(sdk.legacyEnsure).not.toHaveBeenCalled();
    expect(sdk.legacyHeaders).not.toHaveBeenCalled();
    expect(sdk.newEnsure).not.toHaveBeenCalled();
    expect(sdk.newMake).not.toHaveBeenCalled();
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
