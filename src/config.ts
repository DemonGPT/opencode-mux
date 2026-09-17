import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type Layout = "main-vertical" | "main-horizontal" | "tiled";
export type ClosePanes = "auto" | "keep";

export interface MuxConfig {
  sessionName: string;
  layout: Layout;
  closePanes: ClosePanes;
  graceSeconds: number;
  parent: string | null;
}

export interface CliFlags {
  layout?: Layout;
  closePanes?: ClosePanes;
  graceSeconds?: number;
  parent?: string | null;
  sessionName?: string;
}

export const DEFAULT_CONFIG: MuxConfig = {
  sessionName: "mux",
  layout: "main-vertical",
  closePanes: "auto",
  graceSeconds: 15,
  parent: null,
};

const LAYOUTS: ReadonlySet<string> = new Set(["main-vertical", "main-horizontal", "tiled"]);
const CLOSE_MODES: ReadonlySet<string> = new Set(["auto", "keep"]);

export function parseConfText(text: string): Partial<MuxConfig> {
  const out: Partial<MuxConfig> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue; // malformed line: ignore
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    switch (key) {
      case "session_name":
        if (value !== "") out.sessionName = value;
        break;
      case "layout":
        if (LAYOUTS.has(value)) {
          out.layout = value as Layout;
        } else {
          throw new Error(`opencode-mux: invalid layout "${value}" (expected main-vertical | main-horizontal | tiled)`);
        }
        break;
      case "close_panes":
        if (CLOSE_MODES.has(value)) {
          out.closePanes = value as ClosePanes;
        } else {
          throw new Error(`opencode-mux: invalid close_panes "${value}" (expected auto | keep)`);
        }
        break;
      case "grace": {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) {
          throw new Error(`opencode-mux: invalid grace "${value}" (expected a non-negative number of seconds)`);
        }
        out.graceSeconds = Math.floor(n);
        break;
      }
      case "parent":
        out.parent = value === "" ? null : value;
        break;
      default:
        break; // unknown keys are ignored for forward compatibility
    }
  }
  return out;
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && xdg !== "" ? xdg : join(homedir(), ".config");
  return join(base, "opencode-mux.conf");
}

export async function loadConfig(opts: {
  path?: string;
  flags?: CliFlags;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<MuxConfig> {
  const path = opts.path ?? configPath(opts.env ?? process.env);
  let fromFile: Partial<MuxConfig> = {};
  try {
    fromFile = parseConfText(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const flags = opts.flags ?? {};
  return {
    sessionName: flags.sessionName ?? fromFile.sessionName ?? DEFAULT_CONFIG.sessionName,
    layout: flags.layout ?? fromFile.layout ?? DEFAULT_CONFIG.layout,
    closePanes: flags.closePanes ?? fromFile.closePanes ?? DEFAULT_CONFIG.closePanes,
    graceSeconds: flags.graceSeconds ?? fromFile.graceSeconds ?? DEFAULT_CONFIG.graceSeconds,
    parent: flags.parent !== undefined ? flags.parent : (fromFile.parent ?? DEFAULT_CONFIG.parent),
  };
}
