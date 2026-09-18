import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BorderStyles } from "./tmux.js";
import { BUILTIN_THEME_BORDERS } from "./theme/builtin.js";

type ThemeMode = "dark" | "light";

interface ThemePick {
  name: string;
  mode: ThemeMode;
}

/** A resolved v1 color: a normalized hex or an ANSI palette index. */
type ResolvedColor = { hex: string } | { ansi: number };

interface ThemeStylesResult {
  styles: BorderStyles | null;
  /** The custom theme file that produced the styles, when one was used. */
  customFile: string | null;
}

function configBase(env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_CONFIG_HOME;
  return xdg !== undefined && xdg !== "" ? xdg : join(homedir(), ".config");
}

/** The four opencode config files in resolution precedence order. */
function configCandidates(opts: { env: NodeJS.ProcessEnv; cwd: string }): string[] {
  return [
    join(opts.cwd, ".opencode", "cli.json"),
    join(opts.cwd, ".opencode", "tui.json"),
    join(configBase(opts.env), "opencode", "cli.json"),
    join(configBase(opts.env), "opencode", "tui.json"),
  ];
}

/** Parses a JSON file, returning null for missing or malformed files. */
function readJson(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Theme name from a config doc: cli.json object form or legacy string form. */
function themeName(doc: unknown): string | null {
  if (typeof doc !== "object" || doc === null) return null;
  const theme = (doc as Record<string, unknown>).theme;
  if (typeof theme === "string" && theme !== "") return theme;
  if (typeof theme === "object" && theme !== null) {
    const name = (theme as Record<string, unknown>).name;
    if (typeof name === "string" && name !== "") return name;
  }
  return null;
}

/** Mode from a config doc; system/absent modes resolve as dark. */
function themeMode(doc: unknown): ThemeMode {
  if (typeof doc !== "object" || doc === null) return "dark";
  const theme = (doc as Record<string, unknown>).theme;
  if (typeof theme === "object" && theme !== null && (theme as Record<string, unknown>).mode === "light") return "light";
  return "dark";
}

function pickTheme(opts: { env: NodeJS.ProcessEnv; cwd: string }): ThemePick {
  for (const file of configCandidates(opts)) {
    const doc = readJson(file);
    if (doc === null) continue;
    const name = themeName(doc);
    if (name === null) continue;
    return { name, mode: themeMode(doc) };
  }
  return { name: "opencode", mode: "dark" };
}

/** Custom theme file for a name: project dir first, then the global config dir. */
function customThemePath(opts: { env: NodeJS.ProcessEnv; cwd: string }, name: string): string | null {
  const project = join(opts.cwd, ".opencode", "themes", `${name}.json`);
  if (existsSync(project)) return project;
  const global = join(configBase(opts.env), "themes", `${name}.json`);
  if (existsSync(global)) return global;
  return null;
}

const isHex = (value: string): boolean => /^#[0-9a-fA-F]{3,8}$/.test(value);

/** Normalizes #RGB/#RGBA/#RRGGBB/#RRGGBBAA to lowercase #rrggbb, or null. */
function normHex(value: string): string | null {
  let h = value.slice(1);
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  else if (h.length === 4) h = h.slice(0, 3).split("").map((c) => c + c).join("");
  else if (h.length === 8) h = h.slice(0, 6);
  return h.length === 6 ? `#${h.toLowerCase()}` : null;
}

/** Resolves a v1 flat theme value: hex | ansi | "none" | ref into defs/theme | {dark,light}. */
function resolveV1Value(
  value: unknown,
  theme: Record<string, unknown>,
  defs: Record<string, unknown>,
  mode: ThemeMode,
  depth = 0,
): ResolvedColor | null {
  if (depth > 8 || value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 && value <= 255 ? { ansi: value } : null;
  }
  if (typeof value !== "string") return null;
  if (isHex(value)) {
    const hex = normHex(value);
    return hex === null ? null : { hex };
  }
  if (value === "none" || value === "transparent") return null;
  const next = defs[value] ?? theme[value];
  if (next === undefined) return null;
  if (typeof next === "object" && next !== null && ("dark" in next || "light" in next)) {
    const variant = (next as Record<string, unknown>)[mode] ?? (next as Record<string, unknown>).dark;
    return resolveV1Value(variant, theme, defs, mode, depth + 1);
  }
  return resolveV1Value(next, theme, defs, mode, depth + 1);
}

function pickV1(value: unknown, theme: Record<string, unknown>, defs: Record<string, unknown>, mode: ThemeMode): ResolvedColor | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    const variant = (value as Record<string, unknown>)[mode] ?? (value as Record<string, unknown>).dark;
    return resolveV1Value(variant, theme, defs, mode);
  }
  return resolveV1Value(value, theme, defs, mode);
}

function toStyleColor(resolved: ResolvedColor | null): string | null {
  if (resolved === null) return null;
  return "hex" in resolved ? resolved.hex : `colour${resolved.ansi}`;
}

/** Dotted-path lookup into a token document. */
function readPath(doc: Record<string, unknown>, path: string): unknown {
  let value: unknown = doc;
  for (const key of path.split(".")) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** Resolves a v2 ColorValue: hex | "transparent" | "$path" token reference. */
function resolveV2Color(value: unknown, scope: Record<string, unknown>, seen: Set<string>): string | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 && value <= 255 ? `colour${value}` : null;
  }
  if (typeof value !== "string") return null;
  if (value === "none" || value === "transparent") return null;
  if (isHex(value)) return normHex(value);
  if (!value.startsWith("$")) return null;
  if (seen.has(value)) return null;
  seen.add(value);
  return resolveV2Color(readPath(scope, value.slice(1)), scope, seen);
}

/** Resolves a custom theme document: v1 flat fully, v2 minimally via border.default. */
function resolveCustomDoc(doc: unknown, mode: ThemeMode): BorderStyles | null {
  const docObj = doc as Record<string, unknown> | null;
  if (docObj === null || typeof docObj !== "object") return null;
  if (docObj.version === 2) {
    const palette = (docObj[mode] as Record<string, unknown> | undefined) ?? {};
    const border = palette.border as Record<string, unknown> | undefined;
    // v2 token refs resolve against the palette merged with the doc's hue table.
    const scope: Record<string, unknown> = { ...docObj, ...palette };
    const color = resolveV2Color(border?.default, scope, new Set());
    if (color === null) return null;
    // v2 has no borderActive: the border colour drives both pane states.
    return { inactive: `fg=${color}`, active: `fg=${color}` };
  }
  const theme = ((docObj.theme ?? docObj) as Record<string, unknown> | undefined) ?? {};
  const defs = (docObj.defs as Record<string, unknown> | undefined) ?? {};
  const styles: BorderStyles = {};
  const inactive = toStyleColor(pickV1(theme.border, theme, defs, mode));
  if (inactive !== null) styles.inactive = `fg=${inactive}`;
  // Absent borderActive falls back to the border colour; a present-but-unresolvable
  // one drops the field instead.
  const active = toStyleColor(pickV1(theme.borderActive ?? theme.border, theme, defs, mode));
  if (active !== null) styles.active = `fg=${active}`;
  return styles.inactive === undefined && styles.active === undefined ? null : styles;
}

function resolveStyles(opts: { env: NodeJS.ProcessEnv; cwd: string }): ThemeStylesResult {
  const pick = pickTheme(opts);
  if (pick.name === "system") return { styles: null, customFile: null };
  const custom = customThemePath(opts, pick.name);
  if (custom !== null) {
    const doc = readJson(custom);
    return { styles: doc === null ? null : resolveCustomDoc(doc, pick.mode), customFile: custom };
  }
  const builtin = BUILTIN_THEME_BORDERS[pick.name];
  const colors = builtin?.[pick.mode];
  if (colors === undefined) return { styles: null, customFile: null };
  return {
    styles: { inactive: `fg=${colors.inactive}`, active: `fg=${colors.active}` },
    customFile: null,
  };
}

/**
 * Resolves the active opencode theme into tmux border style fragments
 * (`fg=<color>`), or null when the theme is `system`, unknown, or unresolvable.
 * Precedence: project cli.json → project tui.json → global cli.json → global
 * tui.json; the first file that names a theme wins. Never throws.
 */
export function resolveThemeStyles(opts: { env: NodeJS.ProcessEnv; cwd: string }): BorderStyles | null {
  try {
    return resolveStyles(opts).styles;
  } catch {
    return null;
  }
}

export interface ThemeStylesProvider {
  /**
   * Current border styles, re-resolved only when a watched file's mtime
   * changes (the four config candidates plus the resolved custom theme file).
   */
  current(): BorderStyles | null;
}

/**
 * Mtime-cached theme styles provider; cheap enough for per-tick polling.
 * Never throws.
 */
export function createThemeStyles(opts: { env: NodeJS.ProcessEnv; cwd: string }): ThemeStylesProvider {
  let cached: BorderStyles | null = null;
  let cachedSig = "";
  let themeFile: string | null = null;

  const statSig = (path: string): string => {
    try {
      return `${path}:${statSync(path).mtimeMs}`;
    } catch {
      return `${path}:missing`;
    }
  };

  const composeSig = (): string => {
    let sig = configCandidates(opts).map(statSig).join(";");
    sig += themeFile === null ? ";theme:none" : `;theme:${statSig(themeFile)}`;
    return sig;
  };

  return {
    current() {
      try {
        const sig = composeSig();
        if (sig === cachedSig) return cached;
        const { styles, customFile } = resolveStyles(opts);
        cached = styles;
        themeFile = customFile;
        cachedSig = composeSig();
        return cached;
      } catch {
        return cached;
      }
    },
  };
}