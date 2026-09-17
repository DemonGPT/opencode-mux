import { describe, expect, it } from "vitest";
import { parentFromPassThrough, parseArgs } from "../src/args.ts";

describe("parseArgs", () => {
  it("passes through unknown flags and positional args untouched", () => {
    const parsed = parseArgs(["-s", "ses_abc", "--models"]);
    expect(parsed.passThrough).toEqual(["-s", "ses_abc", "--models"]);
    expect(parsed.flags).toEqual({});
  });

  it("parses mux flags with separate values", () => {
    const parsed = parseArgs([
      "--layout", "tiled",
      "--grace", "30",
      "--close", "keep",
      "--parent", "ses_p",
      "--session-name", "duel",
    ]);
    expect(parsed.flags).toEqual({
      layout: "tiled",
      graceSeconds: 30,
      closePanes: "keep",
      parent: "ses_p",
      sessionName: "duel",
    });
  });

  it("parses the --flag=value form", () => {
    const parsed = parseArgs(["--layout=tiled", "--config=/x/opencode-mux.conf"]);
    expect(parsed.flags.layout).toBe("tiled");
    expect(parsed.configPath).toBe("/x/opencode-mux.conf");
  });

  it("maps an empty --parent value to null", () => {
    expect(parseArgs(["--parent", ""]).flags.parent).toBeNull();
  });

  it("rejects unknown mux flags but keeps other unknowns for opencode", () => {
    expect(() => parseArgs(["--mux-bogus"])).toThrow(/unknown flag/);
    expect(parseArgs(["--whatever"]).passThrough).toEqual(["--whatever"]);
  });

  it("accepts every supported layout name (omo-slim parity)", () => {
    for (const layout of ["main-vertical", "main-horizontal", "tiled", "even-horizontal", "even-vertical"]) {
      expect(parseArgs(["--layout", layout]).flags.layout).toBe(layout);
    }
  });

  it("rejects invalid values", () => {
    expect(() => parseArgs(["--layout", "sideways"])).toThrow(/--layout/);
    expect(() => parseArgs(["--grace", "-1"])).toThrow(/--grace/);
    expect(() => parseArgs(["--close", "sometimes"])).toThrow(/--close/);
    expect(() => parseArgs(["--grace"])).toThrow(/--grace/);
  });

  it("recognises help/version/watch markers", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--version"]).version).toBe(true);
    expect(parseArgs(["--mux-watch"]).watch).toBe(true);
  });
});

describe("parentFromPassThrough", () => {
  it("extracts -s and --session ids", () => {
    expect(parentFromPassThrough(["-s", "ses_abc"])).toBe("ses_abc");
    expect(parentFromPassThrough(["--session", "ses_abc"])).toBe("ses_abc");
    expect(parentFromPassThrough(["--session=ses_abc"])).toBe("ses_abc");
  });

  it("ignores non-session values and returns null when absent", () => {
    expect(parentFromPassThrough(["-s", "other"])).toBeNull();
    expect(parentFromPassThrough([])).toBeNull();
    expect(parentFromPassThrough(["--whatever"])).toBeNull();
  });
});