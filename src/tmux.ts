import type { Layout } from "./config.js";
import type { Exec } from "./exec.js";

export interface TmuxSplitInput {
  targetPane: string;
  layout: Layout;
  argv: string[];
}

export interface TmuxResult {
  ok: boolean;
  error: string | null;
  paneId: string | null;
}

export interface Tmux {
  splitPane(input: TmuxSplitInput): Promise<TmuxResult>;
  killPane(paneId: string): Promise<{ ok: boolean; error: string | null }>;
}

/** Pane id from the environment, or null when not inside tmux. */
export function currentPane(env: NodeJS.ProcessEnv): string | null {
  const pane = env.TMUX_PANE;
  return pane !== undefined && pane !== "" ? pane : null;
}

/** Shell-safe single-argument quoting (tmux joins trailing args into `sh -c`). */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:@%+-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

export function tmuxAdapter(exec: Exec): Tmux {
  return {
    async splitPane({ targetPane, layout, argv }) {
      const args = [
        "split-window",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        targetPane,
        ...argv.map(shellQuote),
      ];
      const result = await exec.run("tmux", args);
      const raw = result.stdout.trim().split("\n")[0];
      const paneId = raw === undefined || raw === "" ? null : raw;
      const paneOk = paneId !== null && paneId !== "";
      if (result.ok && paneOk) {
        // Shape the whole window into the requested named layout (e.g. the main
        // pane left with subagents stacked in a right column for main-vertical).
        // tmux keeps re-arranging into this layout as panes are added or removed,
        // so repeated splits no longer cascade or exhaust pane space.
        await exec.run("tmux", ["select-layout", "-t", targetPane, layout]);
      }
      return {
        ok: result.ok && paneOk,
        error: result.ok ? (paneOk ? null : "no pane id returned") : result.stderr.trim() || result.error || "tmux failed",
        paneId,
      };
    },
    async killPane(paneId) {
      const result = await exec.run("tmux", ["kill-pane", "-t", paneId]);
      return {
        ok: result.ok,
        error: result.ok ? null : result.stderr.trim() || result.error || "tmux failed",
      };
    },
  };
}
