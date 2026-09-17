import type { Layout } from "./config.js";
import type { Exec } from "./exec.js";

export interface TmuxSplitInput {
  targetPane: string;
  layout: Layout;
  /** Main pane size in percent (20-80) for main-* layouts; other layouts ignore it. */
  mainPaneSize?: number;
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
    async splitPane({ targetPane, layout, argv, mainPaneSize }) {
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
        //
        // main-* layouts size their main pane from the window options
        // main-pane-width / main-pane-height, which accept a percentage.
        // select-layout itself rejects a "layout,size" suffix ("invalid layout"),
        // so set the matching option first, then apply the plain preset layout.
        // Non-main layouts have no main pane and ignore the size entirely.
        if (mainPaneSize !== undefined && layout.startsWith("main-")) {
          const option = layout === "main-horizontal" ? "main-pane-height" : "main-pane-width";
          await exec.run("tmux", ["set-option", "-w", "-t", targetPane, option, `${mainPaneSize}%`]);
        }
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
