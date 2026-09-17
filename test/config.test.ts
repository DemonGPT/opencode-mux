import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, configPath, loadConfig, parseConfText } from "../src/config.ts";

describe("parseConfText", () => {
  it("returns an empty partial for empty input", () => {
    expect(parseConfText("")).toEqual({});
  });

  it("ignores comments and blank lines", () => {
    expect(parseConfText("# comment\n\n  \n# another\n")).toEqual({});
  });

  it("parses all keys", () => {
    const out = parseConfText(
      "session_name = duel\nlayout = tiled\nclose_panes = keep\ngrace = 42\nparent = ses_abc\n",
    );
    expect(out).toEqual({
      sessionName: "duel",
      layout: "tiled",
      closePanes: "keep",
      graceSeconds: 42,
      parent: "ses_abc",
    });
  });

  it("maps an empty parent value to null", () => {
    expect(parseConfText("parent =\n")).toEqual({ parent: null });
  });

  it("ignores unknown keys and malformed lines", () => {
    expect(parseConfText("bogus = 1\nno equals here\n")).toEqual({});
  });

  it("throws on invalid layout", () => {
    expect(() => parseConfText("layout = sideways\n")).toThrow(/invalid layout/);
  });

  it("throws on invalid close_panes", () => {
    expect(() => parseConfText("close_panes = sometimes\n")).toThrow(/invalid close_panes/);
  });

  it("throws on invalid grace", () => {
    expect(() => parseConfText("grace = -3\n")).toThrow(/invalid grace/);
    expect(() => parseConfText("grace = abc\n")).toThrow(/invalid grace/);
  });
});

describe("configPath", () => {
  it("uses XDG_CONFIG_HOME when set", () => {
    expect(configPath({ XDG_CONFIG_HOME: "/x/y" })).toBe(join("/x/y", "opencode-mux.conf"));
  });
});

describe("loadConfig", () => {
  it("returns defaults when the config file is missing", async () => {
    const config = await loadConfig({ path: "/nonexistent/opencode-mux.conf", env: {} });
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("merges file values, then flags on top", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omux-"));
    const path = join(dir, "opencode-mux.conf");
    await writeFile(path, "layout = tiled\ngrace = 5\n");
    const config = await loadConfig({ path, flags: { graceSeconds: 30, closePanes: "keep" }, env: {} });
    expect(config).toEqual({
      sessionName: "mux",
      layout: "tiled",
      closePanes: "keep",
      graceSeconds: 30,
      parent: null,
    });
  });

  it("lets flags set parent to null explicitly", async () => {
    const config = await loadConfig({ path: "/nonexistent/opencode-mux.conf", flags: { parent: null }, env: {} });
    expect(config.parent).toBeNull();
  });
});
