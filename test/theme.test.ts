import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BorderStyles } from "../src/tmux.ts";
import { BUILTIN_THEME_BORDERS } from "../src/theme/builtin.ts";
import { createThemeStyles, resolveThemeStyles } from "../src/theme.ts";

const T0 = new Date("2024-01-01T00:00:00Z");
const T1 = new Date("2024-02-01T00:00:00Z");

let dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omux-theme-"));
  dirs.push(dir);
  return dir;
}
function opts(root: string) {
  return { env: { XDG_CONFIG_HOME: join(root, "config") }, cwd: join(root, "proj") };
}
function write(path: string, content: string | object): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content), "utf8");
}
const fg = (c: string) => `fg=${c}`;

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const globalCli = (root: string) => join(root, "config", "opencode", "cli.json");
const globalTui = (root: string) => join(root, "config", "opencode", "tui.json");
const projectCli = (root: string) => join(root, "proj", ".opencode", "cli.json");
const projectTui = (root: string) => join(root, "proj", ".opencode", "tui.json");
const projectTheme = (root: string, name: string) => join(root, "proj", ".opencode", "themes", `${name}.json`);
const globalTheme = (root: string, name: string) => join(root, "config", "themes", `${name}.json`);

const v1Custom = {
  $schema: "https://opencode.ai/theme.json",
  defs: { step1: "#ff0000", step2: "#00ff00" },
  theme: {
    border: { dark: "step1", light: "#0000ff" },
    borderActive: { dark: "step2", light: "none" },
  },
};

describe("resolveThemeStyles", () => {
  it("reads the v2 cli.json theme object and resolves a built-in (dark mode)", () => {
    const root = tempDir();
    write(globalCli(root), { theme: { name: "tokyonight", mode: "dark" } });
    expect(resolveThemeStyles(opts(root))).toEqual({ inactive: fg("#737aa2"), active: fg("#9099b2") });
  });

  it("reads the legacy tui.json plain-string theme", () => {
    const root = tempDir();
    write(globalTui(root), { theme: "tokyonight" });
    expect(resolveThemeStyles(opts(root))).toEqual({ inactive: fg("#737aa2"), active: fg("#9099b2") });
  });

  it("prefers project cli.json over global cli.json", () => {
    const root = tempDir();
    write(projectCli(root), { theme: { name: "tokyonight" } });
    write(globalCli(root), { theme: { name: "dracula" } });
    expect(resolveThemeStyles(opts(root))).toEqual({ inactive: fg("#737aa2"), active: fg("#9099b2") });
  });

  it("skips a theme-less project cli.json and falls through to project tui.json before global", () => {
    const root = tempDir();
    write(projectCli(root), {});
    write(projectTui(root), { theme: "nord" });
    write(globalCli(root), { theme: { name: "dracula" } });
    expect(resolveThemeStyles(opts(root))).toEqual({ inactive: fg("#434c5e"), active: fg("#4c566a") });
  });

  it("skips malformed config files silently and keeps scanning", () => {
    const root = tempDir();
    write(projectCli(root), "{not json");
    const tui = globalTui(root);
    write(tui, { theme: "rosepine" });
    expect(resolveThemeStyles(opts(root))).toEqual({ inactive: fg("#403d52"), active: fg("#9ccfd8") });
  });

  it("resolves a project custom v1 theme with defs refs, variants, and none", () => {
    const root = tempDir();
    write(projectCli(root), { theme: { name: "mytheme", mode: "dark" } });
    write(projectTheme(root, "mytheme"), v1Custom);
    expect(resolveThemeStyles(opts(root))).toEqual({ inactive: fg("#ff0000"), active: fg("#00ff00") });
    write(projectCli(root), { theme: { name: "mytheme", mode: "light" } });
    expect(resolveThemeStyles(opts(root))).toEqual({ inactive: fg("#0000ff") });
  });

  it("falls back to the border colour when a v1 theme has no borderActive", () => {
    const root = tempDir();
    write(projectCli(root), { theme: { name: "plain" } });
    write(projectTheme(root, "plain"), { theme: { border: "#123456" } });
    expect(resolveThemeStyles(opts(root))).toEqual({ inactive: fg("#123456"), active: fg("#123456") });
  });

  it("resolves a global custom theme from the config themes dir", () => {
    const root = tempDir();
    write(globalCli(root), { theme: { name: "mytheme" } });
    write(globalTheme(root, "mytheme"), { theme: { border: "#abcdef" } });
    expect(resolveThemeStyles(opts(root))).toEqual({ inactive: fg("#abcdef"), active: fg("#abcdef") });
  });

  it("resolves a v2 document minimally via border.default with $hue and $ref", () => {
    const root = tempDir();
    write(projectCli(root), { theme: { name: "myv2" } });
    write(projectTheme(root, "myv2"), {
      version: 2,
      hue: { blue: { 500: "#3b82f6" } },
      dark: {
        border: { default: "$hue.blue.500" },
        status: { running: "#22c55e" },
      },
      light: {
        border: { default: "$status.running" },
        status: { running: "#22c55e" },
      },
    });
    // mode absent → dark; active falls back to the border color (no borderActive in v2)
    expect(resolveThemeStyles(opts(root))).toEqual({ inactive: fg("#3b82f6"), active: fg("#3b82f6") });
    write(projectCli(root), { theme: { name: "myv2", mode: "light" } });
    expect(resolveThemeStyles(opts(root))).toEqual({ inactive: fg("#22c55e"), active: fg("#22c55e") });
  });

  it("returns null for the system theme, unknown names, and malformed custom themes", () => {
    const root = tempDir();
    write(projectCli(root), { theme: { name: "system" } });
    expect(resolveThemeStyles(opts(root))).toBeNull();
    write(projectCli(root), { theme: { name: "no-such-theme" } });
    expect(resolveThemeStyles(opts(root))).toBeNull();
    write(projectCli(root), { theme: { name: "broken" } });
    write(projectTheme(root, "broken"), "{not json");
    expect(resolveThemeStyles(opts(root))).toBeNull();
  });

  it("selects light vs dark mode explicitly (system/absent mode defaults to dark)", () => {
    const root = tempDir();
    const dark = { inactive: fg("#484848"), active: fg("#606060") };
    const light = { inactive: fg("#b8b8b8"), active: fg("#a0a0a0") };
    write(globalCli(root), { theme: { name: "opencode", mode: "light" } });
    expect(resolveThemeStyles(opts(root))).toEqual(light);
    write(globalCli(root), { theme: { name: "opencode", mode: "system" } });
    expect(resolveThemeStyles(opts(root))).toEqual(dark);
    write(globalCli(root), { theme: { name: "opencode" } });
    expect(resolveThemeStyles(opts(root))).toEqual(dark);
  });

  it("defaults to the opencode theme when no config sets one", () => {
    const root = tempDir();
    expect(resolveThemeStyles(opts(root))).toEqual({ inactive: fg("#484848"), active: fg("#606060") });
  });
});

describe("BUILTIN_THEME_BORDERS", () => {
  it("covers all 33 built-in opencode themes with bare colors", () => {
    expect(Object.keys(BUILTIN_THEME_BORDERS)).toHaveLength(33);
    const bare = /^(?:#[0-9a-f]{6}|colour\d+)$/;
    for (const [name, entry] of Object.entries(BUILTIN_THEME_BORDERS)) {
      for (const mode of ["dark", "light"] as const) {
        expect(entry[mode].inactive, `${name}.${mode}.inactive`).toMatch(bare);
        expect(entry[mode].active, `${name}.${mode}.active`).toMatch(bare);
      }
    }
  });

  it("matches the verified border colors for opencode and tokyonight", () => {
    expect(BUILTIN_THEME_BORDERS["opencode"]!.dark).toEqual({ inactive: "#484848", active: "#606060" });
    expect(BUILTIN_THEME_BORDERS["opencode"]!.light).toEqual({ inactive: "#b8b8b8", active: "#a0a0a0" });
    expect(BUILTIN_THEME_BORDERS["tokyonight"]!.dark).toEqual({ inactive: "#737aa2", active: "#9099b2" });
    expect(BUILTIN_THEME_BORDERS["dracula"]!.dark).toEqual({ inactive: "#44475a", active: "#bd93f9" });
  });
});

describe("createThemeStyles", () => {
  const darkTokyonight: BorderStyles = { inactive: fg("#737aa2"), active: fg("#9099b2") };
  const darkDracula: BorderStyles = { inactive: fg("#44475a"), active: fg("#bd93f9") };

  it("caches on unchanged files and re-resolves only when an mtime changes", () => {
    const root = tempDir();
    const cli = globalCli(root);
    write(cli, { theme: { name: "tokyonight", mode: "dark" } });
    utimesSync(cli, T0, T0);
    const provider = createThemeStyles(opts(root));
    const first = provider.current();
    expect(first).toEqual(darkTokyonight);
    expect(provider.current()).toBe(first); // same cached object
    // Content changes but the mtime is pinned: the cached value is kept.
    write(cli, { theme: { name: "dracula", mode: "dark" } });
    utimesSync(cli, T0, T0);
    expect(provider.current()).toBe(first);
    // A bump in mtime triggers a re-read.
    utimesSync(cli, T1, T1);
    expect(provider.current()).toEqual(darkDracula);
  });

  it("monitors the resolved custom theme file in addition to the configs", () => {
    const root = tempDir();
    const cli = projectCli(root);
    const theme = projectTheme(root, "mytheme");
    write(cli, { theme: { name: "mytheme" } });
    write(theme, { theme: { border: "#111111" } });
    utimesSync(cli, T0, T0);
    utimesSync(theme, T0, T0);
    const provider = createThemeStyles(opts(root));
    const first = provider.current();
    expect(first).toEqual({ inactive: fg("#111111"), active: fg("#111111") });
    write(theme, { theme: { border: "#222222" } });
    utimesSync(theme, T0, T0);
    expect(provider.current()).toBe(first); // theme file untouched (same mtime)
    utimesSync(theme, T1, T1);
    expect(provider.current()).toEqual({ inactive: fg("#222222"), active: fg("#222222") });
  });
});