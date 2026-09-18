import { describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, configPath, defaultConfText, loadConfig, parseConfText } from "../src/config.ts";

describe("parseConfText", () => {
  it("returns an empty partial for empty input", () => {
    expect(parseConfText("")).toEqual({});
  });

  it("ignores comments and blank lines", () => {
    expect(parseConfText("# comment\n\n  \n# another\n")).toEqual({});
  });

  it("parses all keys", () => {
    const out = parseConfText(
      "session_name = duel\nlayout = tiled\nclose_panes = keep\npane_command = tui\ngrace = 42\nparent = ses_abc\n",
    );
    expect(out).toEqual({
      sessionName: "duel",
      layout: "tiled",
      closePanes: "keep",
      paneCommand: "tui",
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

  it("parses every supported layout (omo-slim parity)", () => {
    for (const layout of ["main-vertical", "main-horizontal", "tiled", "even-horizontal", "even-vertical"]) {
      expect(parseConfText(`layout = ${layout}\n`)).toEqual({ layout });
    }
  });

  it("throws on invalid close_panes", () => {
    expect(() => parseConfText("close_panes = sometimes\n")).toThrow(/invalid close_panes/);
  });

  it("parses pane_command", () => {
    expect(parseConfText("pane_command = mini\n")).toEqual({ paneCommand: "mini" });
    expect(parseConfText("pane_command = tui\n")).toEqual({ paneCommand: "tui" });
  });

  it("throws on invalid pane_command", () => {
    expect(() => parseConfText("pane_command = nano\n")).toThrow(/invalid pane_command/);
  });

  it("throws on invalid grace", () => {
    expect(() => parseConfText("grace = -3\n")).toThrow(/invalid grace/);
    expect(() => parseConfText("grace = abc\n")).toThrow(/invalid grace/);
  });

  it("parses main_pane_size", () => {
    expect(parseConfText("main_pane_size = 40\n")).toEqual({ mainPaneSize: 40 });
  });

  it("throws on invalid main_pane_size", () => {
    expect(() => parseConfText("main_pane_size = 10\n")).toThrow(/invalid main_pane_size/);
    expect(() => parseConfText("main_pane_size = 90\n")).toThrow(/invalid main_pane_size/);
    expect(() => parseConfText("main_pane_size = abc\n")).toThrow(/invalid main_pane_size/);
  });
});

describe("configPath", () => {
  it("uses XDG_CONFIG_HOME when set", () => {
    expect(configPath({ XDG_CONFIG_HOME: "/x/y" })).toBe(join("/x/y", "opencode-mux.conf"));
  });
});

describe("defaultConfText", () => {
  it("round-trips to DEFAULT_CONFIG", () => {
    expect(parseConfText(defaultConfText())).toEqual(DEFAULT_CONFIG);
  });
});

describe("loadConfig", () => {
  it("autocreates the default config file when missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omux-"));
    const path = join(dir, "opencode-mux.conf");
    const config = await loadConfig({ path, env: {} });
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(parseConfText(await readFile(path, "utf8"))).toEqual(DEFAULT_CONFIG);
  });

  it("falls back to defaults when the config file cannot be created", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omux-"));
    const ro = join(dir, "ro");
    await mkdir(ro);
    await chmod(ro, 0o555); // read-only: mkdir succeeds, writeFile fails
    try {
      const config = await loadConfig({ path: join(ro, "opencode-mux.conf"), env: {} });
      expect(config).toEqual(DEFAULT_CONFIG);
    } finally {
      await chmod(ro, 0o755);
    }
  });

  it("merges file values, then flags on top", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omux-"));
    const path = join(dir, "opencode-mux.conf");
    await writeFile(path, "layout = tiled\nmain_pane_size = 40\ngrace = 5\n");
    const config = await loadConfig({ path, flags: { graceSeconds: 30, closePanes: "keep" }, env: {} });
    expect(config).toEqual({
      sessionName: "mux",
      layout: "tiled",
      closePanes: "keep",
      paneCommand: "mini",
      graceSeconds: 30,
      mainPaneSize: 40,
      parent: null,
    });
  });

  it("lets flags set parent to null explicitly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omux-"));
    const config = await loadConfig({ path: join(dir, "opencode-mux.conf"), flags: { parent: null }, env: {} });
    expect(config.parent).toBeNull();
  });
});
