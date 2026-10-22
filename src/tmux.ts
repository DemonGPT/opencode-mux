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
  /**
   * Appearance failure after a successful split-window: the pane exists, so the
   * split is still ok, but the window could not be shaped. Only present when a
   * layout failure actually happened (the watcher logs it).
   */
  layoutError?: string;
  /**
   * Set when the pane was created but the window-wide layout was deliberately
   * not applied because another opencode-mux instance owns panes in the same
   * window (see windowInstances). Mutually exclusive with layoutError: only a
   * real failure sets that, so callers can tell "declined on purpose" from
   * "tried and failed".
   */
  layoutSkipped?: string;
}

export interface TmuxApplyResult {
  ok: boolean;
  error: string | null;
  /**
   * Set when the layout was deliberately not applied because another
   * opencode-mux instance owns panes in the same window (see windowInstances).
   */
  skipped?: string;
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
 * Pane option (set per pane, never -g) recording which opencode-mux instance
 * created a pane, keyed by that instance's target pane id. Used to detect a
 * window shared by two instances, where a window-wide layout would otherwise
 * make them re-tile over each other.
 */
export const MUX_INSTANCE_OPTION = "@mux-instance";

/**
 * Distinct instance tags of the panes in the target pane's window. A pane
 * without the option contributes an empty string and is ignored, so the main
 * pane and hand-made splits never count as another instance.
 */
async function windowInstances(exec: Exec, targetPane: string): Promise<string[]> {
  const result = await exec.run("tmux", ["list-panes", "-t", targetPane, "-F", `#{${MUX_INSTANCE_OPTION}}`]);
  if (!result.ok) return [];
  const tags = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return [...new Set(tags)];
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
 * A window shared with another opencode-mux instance is left alone: the layout
 * is window-wide, so two instances would re-tile each other's panes on every
 * event. Whichever instance created panes there first keeps the geometry.
 *
 * Best-effort on the sizing option: a failing set-option does not stop the
 * layout from being applied; the first failure is reported.
 */
async function applyLayout(exec: Exec, { targetPane, layout, mainPaneSize }: TmuxLayoutInput): Promise<TmuxApplyResult> {
  const foreign = (await windowInstances(exec, targetPane)).filter((tag) => tag !== targetPane);
  if (foreign.length > 0) {
    return { ok: true, error: null, skipped: `window shared with opencode-mux ${foreign.join(", ")}` };
  }
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
      let layoutError: string | null = null;
      let layoutSkipped: string | null = null;
      if (result.ok && paneOk) {
        // -d keeps the current (main) pane active: opening a subagent pane must
        // not steal focus from the TUI the user is working in.
        // Tag the pane with this instance's identity (pane-scoped, never -g) so
        // a second instance in the same window can tell it is not alone.
        await exec.run("tmux", ["set-option", "-p", "-t", paneId, MUX_INSTANCE_OPTION, targetPane]);
        // Shape the whole window into the requested named layout (e.g. the main
        // pane left with subagents stacked in a right column for main-vertical),
        // so repeated splits do not cascade or exhaust pane space. Appearance
        // failures are non-fatal: the pane exists either way, but they are
        // reported so the watcher can log them instead of failing silently.
        const shaped = await applyLayout(exec, { targetPane, layout, mainPaneSize });
        if (!shaped.ok && shaped.error !== null) layoutError = shaped.error;
        // A declined layout (window shared with another instance) is not a
        // failure: the pane is fine, only the geometry was left alone.
        else if (shaped.ok && shaped.skipped !== undefined) layoutSkipped = shaped.skipped;
      }
      return {
        ok: result.ok && paneOk,
        error: result.ok ? (paneOk ? null : "no pane id returned") : result.stderr.trim() || result.error || "tmux failed",
        paneId,
        ...(layoutError === null ? {} : { layoutError }),
        ...(layoutSkipped === null ? {} : { layoutSkipped }),
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
      // Never clear a window another instance also styles: the unset is
      // window-wide, so it would permanently strip that instance's theme (its
      // own "already applied" memo cannot notice). Leaving the styles in place
      // is the lesser evil; applying our own styles is last-writer-wins and
      // self-corrects on the next theme change.
      const foreign = (await windowInstances(exec, targetPane)).filter((tag) => tag !== targetPane);
      if (foreign.length > 0) {
        return { ok: true, error: null, skipped: `window shared with opencode-mux ${foreign.join(", ")}` };
      }
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
