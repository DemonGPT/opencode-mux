import type { ClosePanes, CliFlags, Layout } from "./config.js";

export interface ParsedArgs {
  flags: CliFlags;
  configPath?: string;
  help: boolean;
  version: boolean;
  watch: boolean;
  passThrough: string[];
}

const LAYOUTS: ReadonlySet<string> = new Set(["main-vertical", "main-horizontal", "tiled", "even-horizontal", "even-vertical"]);
const CLOSE_MODES: ReadonlySet<string> = new Set(["auto", "keep"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { flags: {}, help: false, version: false, watch: false, passThrough: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--mux-watch") {
      out.watch = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      out.help = true;
      continue;
    }
    if (arg === "--version") {
      out.version = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(0, eq) : arg;
    const inline = eq >= 0 ? arg.slice(eq + 1) : null;
    const value = (): string | null => {
      if (inline !== null) return inline;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        i++;
        return next;
      }
      return null;
    };
    switch (name) {
      case "--config": {
        const v = value();
        if (v === null) throw new Error("opencode-mux: --config requires a path");
        out.configPath = v;
        break;
      }
      case "--layout": {
        const v = value();
        if (v === null || !LAYOUTS.has(v)) {
          throw new Error("opencode-mux: --layout requires main-vertical | main-horizontal | tiled | even-horizontal | even-vertical");
        }
        out.flags.layout = v as Layout;
        break;
      }
      case "--main-pane-size": {
        const v = value();
        const n = v === null ? Number.NaN : Number(v);
        if (!Number.isFinite(n) || n < 20 || n > 80) {
          throw new Error("opencode-mux: --main-pane-size requires a number between 20 and 80");
        }
        out.flags.mainPaneSize = Math.floor(n);
        break;
      }
      case "--close": {
        const v = value();
        if (v === null || !CLOSE_MODES.has(v)) {
          throw new Error("opencode-mux: --close requires auto | keep");
        }
        out.flags.closePanes = v as ClosePanes;
        break;
      }
      case "--grace": {
        const v = value();
        const n = v === null ? Number.NaN : Number(v);
        if (!Number.isFinite(n) || n < 0) {
          throw new Error("opencode-mux: --grace requires a non-negative number of seconds");
        }
        out.flags.graceSeconds = Math.floor(n);
        break;
      }
      case "--parent": {
        const v = value();
        if (v === null) throw new Error("opencode-mux: --parent requires a session id");
        out.flags.parent = v === "" ? null : v;
        break;
      }
      case "--session-name": {
        const v = value();
        if (v === null || v === "") throw new Error("opencode-mux: --session-name requires a name");
        out.flags.sessionName = v;
        break;
      }
      default:
        if (name.startsWith("--mux-")) {
          throw new Error(`opencode-mux: unknown flag ${name}`);
        }
        out.passThrough.push(arg);
    }
  }
  return out;
}

/** Returns the parent session id from pass-through `-s`/`--session` opencode args, else null. */
export function parentFromPassThrough(passThrough: string[]): string | null {
  for (let i = 0; i < passThrough.length; i++) {
    const arg = passThrough[i]!;
    if (arg === "-s" || arg === "--session") {
      const next = passThrough[i + 1];
      if (next !== undefined && next.startsWith("ses_")) return next;
    }
    if (arg.startsWith("--session=")) {
      const id = arg.slice("--session=".length);
      if (id.startsWith("ses_")) return id;
    }
  }
  return null;
}