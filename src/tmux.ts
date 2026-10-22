import type { Layout } from "./config.js";
import type { Exec } from "./exec.js";

export interface TmuxLayoutInput {
  targetPane: string;
  layout: Layout;
  /** Main pane size in percent (20-80) for main-* layouts; other layouts ignore it. */
  mainPaneSize?: number;
}

export interface TmuxSplitInput extends TmuxLayoutInput {
  argv: string[];
}

export interface TmuxResult {
  ok: boolean;
  error: string | null;
  paneId: string | null;
}

export interface TmuxApplyResult {
  ok: boolean;
  error: string | null;
}

/** Window-scoped pane border styles, keyed by tmux option name. */
export interface BorderStyles {
  inactive?: string;
  active?: string;
}

export interface Tmux {
  splitPane(input: TmuxSplitInput): Promise<TmuxResult>;
  killPane(paneId: string): Promise<{ ok: boolean; error: string | null }>;
  /**
   * Re-applies the configured layout to the target pane's window, e.g. after a
   * pane closed so the remaining panes share the space evenly again.
   */
  relayout(input: TmuxLayoutInput): Promise<TmuxApplyResult>;
  applyBorderStyles(targetPane: string, styles: BorderStyles): Promise<TmuxApplyResult>;
  clearBorderStyles(targetPane: string): Promise<TmuxApplyResult>;
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

/**
 * Applies the named preset layout to the target window (resolved from the
 * target pane) and sizes the main pane for main-* layouts.
 *
 * main-* layouts size their main pane from the window options
 * main-pane-width / main-pane-height, which accept a percentage.
 * select-layout itself rejects a "layout,size" suffix ("invalid layout"),
 * so the matching option is set first, then the plain preset layout is applied.
 * Non-main layouts have no main pane and ignore the size entirely.
 *
 * Best-effort on the sizing option: a failing set-option does not stop the
 * layout from being applied; the first failure is reported.
 */
async function applyLayout(exec: Exec, { targetPane, layout, mainPaneSize }: TmuxLayoutInput): Promise<TmuxApplyResult> {
  let firstError: string | null = null;
  if (mainPaneSize !== undefined && layout.startsWith("main-")) {
    const option = layout === "main-horizontal" ? "main-pane-height" : "main-pane-width";
    const sizing = await exec.run("tmux", ["set-option", "-w", "-t", targetPane, option, `${mainPaneSize}%`]);
    if (!sizing.ok) firstError = sizing.stderr.trim() || sizing.error || "tmux failed";
  }
  const result = await exec.run("tmux", ["select-layout", "-t", targetPane, layout]);
  if (!result.ok && firstError === null) firstError = result.stderr.trim() || result.error || "tmux failed";
  return { ok: firstError === null, error: firstError };
}

export function tmuxAdapter(exec: Exec): Tmux {
  return {
    async splitPane({ targetPane, layout, argv, mainPaneSize }) {
      const args = [
        "split-window",
        "-d",
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
        // -d keeps the current (main) pane active: opening a subagent pane must
        // not steal focus from the TUI the user is working in.
        // Shape the whole window into the requested named layout (e.g. the main
        // pane left with subagents stacked in a right column for main-vertical),
        // so repeated splits do not cascade or exhaust pane space. Appearance
        // failures are non-fatal: the pane exists either way.
        await applyLayout(exec, { targetPane, layout, mainPaneSize });
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
    async relayout(input) {
      return applyLayout(exec, input);
    },
    /**
     * Applies border styles to the target pane's window via window options (-w,
     * never the server-wide -g), so only that window is affected. Best-effort:
     * each defined style is attempted sequentially; a failure does not stop the
     * remaining styles and the first failure is reported.
     */
    async applyBorderStyles(targetPane, styles) {
      const commands: Array<{ option: "pane-border-style" | "pane-active-border-style"; value: string }> = [];
      if (styles.inactive !== undefined) commands.push({ option: "pane-border-style", value: styles.inactive });
      if (styles.active !== undefined) commands.push({ option: "pane-active-border-style", value: styles.active });
      let firstError: string | null = null;
      try {
        for (const { option, value } of commands) {
          const result = await exec.run("tmux", ["set-option", "-w", "-t", targetPane, option, value]);
          if (!result.ok && firstError === null) {
            firstError = result.stderr.trim() || result.error || "tmux failed";
          }
        }
      } catch (error) {
        return { ok: false, error: firstError ?? String(error) };
      }
      return { ok: firstError === null, error: firstError };
    },
    /**
     * Unsets the window's border style options (-w -u), restoring inherited
     * defaults on the target pane's window only — never the server-wide -g.
     * Best-effort: a failure does not stop the second unset and the first
     * failure is reported.
     */
    async clearBorderStyles(targetPane) {
      const options = ["pane-border-style", "pane-active-border-style"];
      let firstError: string | null = null;
      try {
        for (const option of options) {
          const result = await exec.run("tmux", ["set-option", "-w", "-u", "-t", targetPane, option]);
          if (!result.ok && firstError === null) {
            firstError = result.stderr.trim() || result.error || "tmux failed";
          }
        }
      } catch (error) {
        return { ok: false, error: firstError ?? String(error) };
      }
      return { ok: firstError === null, error: firstError };
    },
  };
}
