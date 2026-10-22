import { describe, expect, it } from "vitest";
import type { Exec, ExecResult } from "../src/exec.ts";
import type { Layout } from "../src/config.ts";
import { MUX_INSTANCE_OPTION, currentPane, shellQuote, tmuxAdapter } from "../src/tmux.ts";

type Hit = { stdout?: string; stderr?: string; ok?: boolean; error?: string | null };
type Responder = (args: string[]) => Hit | undefined;

/**
 * Fake tmux: split-window returns a pane id, list-panes reports the pane tags
 * the window currently carries (empty by default = single instance, nothing
 * tagged yet), everything else succeeds silently.
 */
function fakeTmux(
  overrides: { split?: Hit; listPanes?: Hit; other?: Responder } = {},
): Responder {
  const split = overrides.split ?? { stdout: "%5\n" };
  const listPanes = overrides.listPanes ?? { stdout: "" };
  return (args) => {
    const extra = overrides.other?.(args);
    if (extra !== undefined) return extra;
    switch (args[0]) {
      case "split-window":
        return split;
      case "list-panes":
        return listPanes;
      default:
        return {};
    }
  };
}

function capturingExec(respond: Responder = () => undefined) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const exec: Exec = {
    async run(command, args) {
      calls.push({ command, args });
      const hit = respond(args);
      const ok = hit?.ok ?? true;
      const result: ExecResult = {
        ok,
        code: ok ? 0 : 1,
        stdout: hit?.stdout ?? "",
        stderr: hit?.stderr ?? "",
        error: hit?.error ?? null,
      };
      return result;
    },
  };
  return { exec, calls };
}

/** Every layout application starts by asking who else lives in the window. */
const listPanes = (tags: string[], ok = true): Hit => ({
  ok,
  stdout: ok ? tags.map((tag) => `${tag}\n`).join("") : "",
  stderr: ok ? "" : "no such window\n",
});

const LIST_PANES_ARGS = ["list-panes", "-t", "%0", "-F", `#{${MUX_INSTANCE_OPTION}}`];
const SPLIT_ARGS = ["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", "%0", "opencode"];
const TAG_ARGS = ["set-option", "-p", "-t", "%5", MUX_INSTANCE_OPTION, "%0"];

describe("tmuxAdapter", () => {
  it("splits a pane, tags it with the owning instance, and shapes the window via select-layout", async () => {
    const { exec, calls } = capturingExec(fakeTmux());
    const t = tmuxAdapter(exec);
    const r = await t.splitPane({ targetPane: "%0", layout: "main-vertical", argv: ["opencode", "-s", "ses_x"] });
    expect(r).toEqual({ ok: true, error: null, paneId: "%5" });
    expect(calls.map((c) => c.args)).toEqual([
      ["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", "%0", "opencode", "-s", "ses_x"],
      ["set-option", "-p", "-t", "%5", MUX_INSTANCE_OPTION, "%0"],
      LIST_PANES_ARGS,
      ["select-layout", "-t", "%0", "main-vertical"],
    ]);
  });

  it("tags the new pane with the configured pane option, scoped to that pane only", async () => {
    const { exec, calls } = capturingExec(fakeTmux());
    await tmuxAdapter(exec).splitPane({ targetPane: "%0", layout: "tiled", argv: ["opencode"] });
    expect(MUX_INSTANCE_OPTION).toBe("@mux-instance");
    const tag = calls.find((c) => c.args[0] === "set-option");
    expect(tag?.args).toEqual(TAG_ARGS);
    // Pane scope (-p) with the split's own pane id; never window/server scope.
    expect(tag?.args).toContain("-p");
    expect(tag?.args).not.toContain("-w");
    expect(tag?.args).not.toContain("-g");
    expect(tag?.args[tag.args.indexOf("-t") + 1]).toBe("%5");
  });

  it("still shapes the window when tagging the pane fails (appearance stays non-fatal)", async () => {
    const { exec, calls } = capturingExec(
      fakeTmux({ other: (args) => (args[0] === "set-option" ? { ok: false, stderr: "bad option\n" } : undefined) }),
    );
    const r = await tmuxAdapter(exec).splitPane({ targetPane: "%0", layout: "tiled", argv: ["opencode"] });
    expect(r).toEqual({ ok: true, error: null, paneId: "%5" });
    expect(calls.some((c) => c.args[0] === "select-layout")).toBe(true);
  });

  it("applies the named layout after every split, for every layout", async () => {
    for (const layout of ["main-vertical", "main-horizontal", "tiled", "even-horizontal", "even-vertical"] as const) {
      const { exec, calls } = capturingExec(fakeTmux());
      await tmuxAdapter(exec).splitPane({ targetPane: "%0", layout, argv: ["opencode"] });
      expect(calls.map((c) => c.args)).toEqual([
        SPLIT_ARGS,
        TAG_ARGS,
        LIST_PANES_ARGS,
        ["select-layout", "-t", "%0", layout],
      ]);
    }
  });

  it("quotes argv items that the tmux shell join would mangle", async () => {
    const { exec, calls } = capturingExec(fakeTmux());
    await tmuxAdapter(exec).splitPane({ targetPane: "%0", layout: "tiled", argv: ["sh", "-c", "echo hi there", "o'brien"] });
    expect(calls[0]!.args.slice(7)).toEqual(["sh", "-c", "'echo hi there'", "'o'\\''brien'"]);
  });

  it("returns failure with stderr when tmux errors", async () => {
    const { exec, calls } = capturingExec(fakeTmux({ split: { ok: false, stderr: "no server running" } }));
    const r = await tmuxAdapter(exec).splitPane({ targetPane: "%0", layout: "tiled", argv: [] });
    expect(r).toEqual({ ok: false, error: "no server running", paneId: null });
    // No pane exists: nothing to tag, no layout, no ownership probe.
    expect(calls).toHaveLength(1);
  });

  it("returns failure when the pane id is missing and skips tagging and select-layout", async () => {
    const { exec, calls } = capturingExec(fakeTmux({ split: { stdout: "" } }));
    const r = await tmuxAdapter(exec).splitPane({ targetPane: "%0", layout: "tiled", argv: [] });
    expect(r.ok).toBe(false);
    expect(r.paneId).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("sizes the main pane via window options, only for main-* layouts", async () => {
    const run = async (layout: Layout, mainPaneSize: number | undefined) => {
      const { exec, calls } = capturingExec(fakeTmux());
      const r = await tmuxAdapter(exec).splitPane({ targetPane: "%0", layout, mainPaneSize, argv: ["opencode"] });
      expect(r.ok).toBe(true);
      return calls.map((c) => c.args);
    };
    const splitOnly = (layout: Layout) => [
      SPLIT_ARGS,
      TAG_ARGS,
      LIST_PANES_ARGS,
      ["select-layout", "-t", "%0", layout],
    ];
    // main-* layouts set their window option (percent) then apply the plain
    // preset layout; select-layout itself rejects "layout,size" suffixes.
    expect(await run("main-vertical", 60)).toEqual([
      SPLIT_ARGS,
      TAG_ARGS,
      LIST_PANES_ARGS,
      ["set-option", "-w", "-t", "%0", "main-pane-width", "60%"],
      ["select-layout", "-t", "%0", "main-vertical"],
    ]);
    expect(await run("main-horizontal", 80)).toEqual([
      SPLIT_ARGS,
      TAG_ARGS,
      LIST_PANES_ARGS,
      ["set-option", "-w", "-t", "%0", "main-pane-height", "80%"],
      ["select-layout", "-t", "%0", "main-horizontal"],
    ]);
    // Non-main layouts have no main pane: no option set, plain layout.
    expect(await run("tiled", 60)).toEqual(splitOnly("tiled"));
    expect(await run("even-horizontal", 60)).toEqual(splitOnly("even-horizontal"));
    // No size given: no option set, as before.
    expect(await run("main-vertical", undefined)).toEqual(splitOnly("main-vertical"));
  });

  it("skips the layout (and main-pane sizing) when a foreign instance tagged the window", async () => {
    const { exec, calls } = capturingExec(fakeTmux({ listPanes: listPanes(["%9"]) }));
    const r = await tmuxAdapter(exec).splitPane({
      targetPane: "%0",
      layout: "main-vertical",
      mainPaneSize: 60,
      argv: ["opencode"],
    });
    // The split still succeeded; only the window-wide shaping was declined.
    // The deliberate skip is reported as layoutSkipped (not layoutError, which
    // stays reserved for a real appearance failure) so a caller can tell the
    // two apart and log the reason.
    expect(r).toEqual({
      ok: true,
      error: null,
      paneId: "%5",
      layoutSkipped: "window shared with opencode-mux %9",
    });
    expect(r).not.toHaveProperty("layoutError");
    // The pane was still created and tagged as ours: the skip is geometry-only.
    expect(calls.map((c) => c.args)).toEqual([SPLIT_ARGS, TAG_ARGS, LIST_PANES_ARGS]);
    expect(calls.some((c) => c.args[0] === "set-option" && c.args[1] === "-p")).toBe(true);
    expect(calls.some((c) => c.args[0] === "select-layout")).toBe(false);
    expect(calls.some((c) => c.args.includes("main-pane-width"))).toBe(false);
    expect(calls.some((c) => c.args[0] === "set-option" && c.args.includes("-w"))).toBe(false);
  });

  it("does not skip the layout when the window only carries our own tag", async () => {
    // Our tag plus untagged panes (main pane, hand-made splits) is the normal
    // single-instance case.
    const { exec, calls } = capturingExec(fakeTmux({ listPanes: listPanes(["%0"]) }));
    const r = await tmuxAdapter(exec).splitPane({ targetPane: "%0", layout: "tiled", argv: ["opencode"] });
    expect(r).toEqual({ ok: true, error: null, paneId: "%5" });
    expect(calls.map((c) => c.args).at(-1)).toEqual(["select-layout", "-t", "%0", "tiled"]);
  });

  it("treats a failing list-panes as not-shared and applies the layout", async () => {
    const { exec, calls } = capturingExec(fakeTmux({ listPanes: listPanes([], false) }));
    const r = await tmuxAdapter(exec).splitPane({ targetPane: "%0", layout: "even-vertical", argv: ["opencode"] });
    expect(r).toEqual({ ok: true, error: null, paneId: "%5" });
    expect(calls.map((c) => c.args).at(-1)).toEqual(["select-layout", "-t", "%0", "even-vertical"]);
  });

  it("reports a layout failure on the split result while the split stays ok", async () => {
    const { exec } = capturingExec(
      fakeTmux({ other: (args) => (args[0] === "select-layout" ? { ok: false, stderr: "no such window\n" } : undefined) }),
    );
    const r = await tmuxAdapter(exec).splitPane({ targetPane: "%0", layout: "tiled", argv: ["opencode"] });
    expect(r).toEqual({ ok: true, error: null, paneId: "%5", layoutError: "no such window" });
  });

  it("reports a main-pane sizing failure as layoutError while the split stays ok", async () => {
    const { exec } = capturingExec(fakeTmux({ other: (args) => (args.includes("main-pane-width") ? { ok: false, stderr: "bad option\n" } : undefined) }));
    const r = await tmuxAdapter(exec).splitPane({ targetPane: "%0", layout: "main-vertical", mainPaneSize: 60, argv: ["opencode"] });
    expect(r).toEqual({ ok: true, error: null, paneId: "%5", layoutError: "bad option" });
  });

  it("omits layoutError and layoutSkipped when the layout succeeds", async () => {
    const { exec } = capturingExec(fakeTmux());
    const r = await tmuxAdapter(exec).splitPane({ targetPane: "%0", layout: "tiled", argv: ["opencode"] });
    expect(r).not.toHaveProperty("layoutError");
    expect(r).not.toHaveProperty("layoutSkipped");
  });

  it("kills a pane", async () => {
    const { exec, calls } = capturingExec();
    const r = await tmuxAdapter(exec).killPane("%5");
    expect(r).toEqual({ ok: true, error: null });
    expect(calls).toEqual([{ command: "tmux", args: ["kill-pane", "-t", "%5"] }]);
  });

  it("relayout re-applies the layout, sizing the main pane for main-* layouts", async () => {
    const { exec, calls } = capturingExec(fakeTmux());
    const r = await tmuxAdapter(exec).relayout({ targetPane: "%0", layout: "main-vertical", mainPaneSize: 60 });
    expect(r).toEqual({ ok: true, error: null });
    expect(calls.map((c) => c.args)).toEqual([
      LIST_PANES_ARGS,
      ["set-option", "-w", "-t", "%0", "main-pane-width", "60%"],
      ["select-layout", "-t", "%0", "main-vertical"],
    ]);
  });

  it("relayout applies non-main layouts as a plain preset layout", async () => {
    const { exec, calls } = capturingExec(fakeTmux());
    const r = await tmuxAdapter(exec).relayout({ targetPane: "%0", layout: "tiled", mainPaneSize: 60 });
    expect(r).toEqual({ ok: true, error: null });
    expect(calls.map((c) => c.args)).toEqual([LIST_PANES_ARGS, ["select-layout", "-t", "%0", "tiled"]]);
  });

  it("relayout skips the whole window when another instance owns panes there", async () => {
    const { exec, calls } = capturingExec(fakeTmux({ listPanes: listPanes(["%9", "%11"]) }));
    const r = await tmuxAdapter(exec).relayout({ targetPane: "%0", layout: "main-vertical", mainPaneSize: 60 });
    expect(r).toEqual({ ok: true, error: null, skipped: "window shared with opencode-mux %9, %11" });
    expect(calls.map((c) => c.args)).toEqual([LIST_PANES_ARGS]);
  });

  it("relayout proceeds when the ownership probe fails", async () => {
    const { exec, calls } = capturingExec(fakeTmux({ listPanes: listPanes([], false) }));
    const r = await tmuxAdapter(exec).relayout({ targetPane: "%0", layout: "tiled" });
    expect(r).toEqual({ ok: true, error: null });
    expect(calls.map((c) => c.args)).toEqual([LIST_PANES_ARGS, ["select-layout", "-t", "%0", "tiled"]]);
  });

  it("relayout still applies the layout when sizing the main pane fails, reporting the failure", async () => {
    const { exec, calls } = capturingExec(
      fakeTmux({ other: (args) => (args.includes("main-pane-width") ? { ok: false, stderr: "bad option\n" } : undefined) }),
    );
    const r = await tmuxAdapter(exec).relayout({ targetPane: "%0", layout: "main-vertical", mainPaneSize: 60 });
    expect(r).toEqual({ ok: false, error: "bad option" });
    expect(calls.map((c) => c.args)).toEqual([
      LIST_PANES_ARGS,
      ["set-option", "-w", "-t", "%0", "main-pane-width", "60%"],
      ["select-layout", "-t", "%0", "main-vertical"],
    ]);
  });

  it("relayout reports a select-layout failure", async () => {
    const { exec } = capturingExec(
      fakeTmux({ other: (args) => (args[0] === "select-layout" ? { ok: false, stderr: "no such window\n" } : undefined) }),
    );
    const r = await tmuxAdapter(exec).relayout({ targetPane: "%0", layout: "even-vertical" });
    expect(r).toEqual({ ok: false, error: "no such window" });
  });

  it("applyBorderStyles sets both border styles with -w scoping on the target pane", async () => {
    const { exec, calls } = capturingExec();
    const r = await tmuxAdapter(exec).applyBorderStyles("%0", { inactive: "fg=colour235", active: "fg=green" });
    expect(r).toEqual({ ok: true, error: null });
    expect(calls).toEqual([
      { command: "tmux", args: ["set-option", "-w", "-t", "%0", "pane-border-style", "fg=colour235"] },
      { command: "tmux", args: ["set-option", "-w", "-t", "%0", "pane-active-border-style", "fg=green"] },
    ]);
  });

  it("applyBorderStyles sets only the defined fields and skips undefined ones", async () => {
    const { exec, calls } = capturingExec();
    const r = await tmuxAdapter(exec).applyBorderStyles("%0", { active: "fg=blue" });
    expect(r).toEqual({ ok: true, error: null });
    expect(calls).toEqual([{ command: "tmux", args: ["set-option", "-w", "-t", "%0", "pane-active-border-style", "fg=blue"] }]);
  });

  it("applyBorderStyles does nothing when no styles are defined", async () => {
    const { exec, calls } = capturingExec();
    const r = await tmuxAdapter(exec).applyBorderStyles("%0", {});
    expect(r).toEqual({ ok: true, error: null });
    expect(calls).toEqual([]);
  });

  it("applyBorderStyles keeps going when one command fails and reports the first error", async () => {
    const { exec, calls } = capturingExec(
      fakeTmux({ other: (args) => (args.includes("pane-border-style") ? { ok: false, stderr: "bad style\n" } : undefined) }),
    );
    const r = await tmuxAdapter(exec).applyBorderStyles("%0", { inactive: "fg=red", active: "fg=green" });
    expect(r).toEqual({ ok: false, error: "bad style" });
    expect(calls.map((c) => c.args)).toEqual([
      ["set-option", "-w", "-t", "%0", "pane-border-style", "fg=red"],
      ["set-option", "-w", "-t", "%0", "pane-active-border-style", "fg=green"],
    ]);
  });

  it("clearBorderStyles unsets both border options with -w -u on the target pane", async () => {
    const { exec, calls } = capturingExec(fakeTmux());
    const r = await tmuxAdapter(exec).clearBorderStyles("%0");
    expect(r).toEqual({ ok: true, error: null });
    expect(calls.map((c) => c.args)).toEqual([
      LIST_PANES_ARGS,
      ["set-option", "-w", "-u", "-t", "%0", "pane-border-style"],
      ["set-option", "-w", "-u", "-t", "%0", "pane-active-border-style"],
    ]);
  });

  it("clearBorderStyles does nothing in a window another instance styles", async () => {
    const { exec, calls } = capturingExec(fakeTmux({ listPanes: listPanes(["%9"]) }));
    const r = await tmuxAdapter(exec).clearBorderStyles("%0");
    expect(r).toEqual({ ok: true, error: null, skipped: "window shared with opencode-mux %9" });
    expect(calls.map((c) => c.args)).toEqual([LIST_PANES_ARGS]);
    expect(calls.some((c) => c.args.includes("-u"))).toBe(false);
  });

  it("clearBorderStyles unsets the styles when only our own tag is present", async () => {
    const { exec, calls } = capturingExec(fakeTmux({ listPanes: listPanes(["%0"]) }));
    const r = await tmuxAdapter(exec).clearBorderStyles("%0");
    expect(r).toEqual({ ok: true, error: null });
    expect(calls.map((c) => c.args).slice(1)).toEqual([
      ["set-option", "-w", "-u", "-t", "%0", "pane-border-style"],
      ["set-option", "-w", "-u", "-t", "%0", "pane-active-border-style"],
    ]);
  });

  it("clearBorderStyles is best-effort and reports the first error", async () => {
    const { exec, calls } = capturingExec(
      fakeTmux({ other: (args) => (args.includes("pane-border-style") ? { ok: false, stderr: "no server\n" } : undefined) }),
    );
    const r = await tmuxAdapter(exec).clearBorderStyles("%0");
    expect(r).toEqual({ ok: false, error: "no server" });
    // The probe plus both unsets: a failing unset does not stop the second one.
    expect(calls.map((c) => c.args)).toEqual([
      LIST_PANES_ARGS,
      ["set-option", "-w", "-u", "-t", "%0", "pane-border-style"],
      ["set-option", "-w", "-u", "-t", "%0", "pane-active-border-style"],
    ]);
  });

  it("never passes -g and only scopes window options with -w", async () => {
    const { exec, calls } = capturingExec(fakeTmux());
    const t = tmuxAdapter(exec);
    await t.splitPane({ targetPane: "%0", layout: "main-vertical", mainPaneSize: 60, argv: ["opencode"] });
    await t.relayout({ targetPane: "%0", layout: "main-vertical", mainPaneSize: 60 });
    await t.applyBorderStyles("%0", { inactive: "a", active: "b" });
    await t.clearBorderStyles("%0");
    await t.killPane("%5");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => !c.args.includes("-g"))).toBe(true);
    for (const { args } of calls) {
      if (args[0] === "set-option") {
        // Per-pane tag or window-scoped styling: never server-wide.
        expect(["-p", "-w"].some((scope) => args.includes(scope))).toBe(true);
      }
      if (args[0] === "list-panes") {
        expect(args).not.toContain("-w");
      }
    }
  });
});

describe("shellQuote", () => {
  it("leaves safe tokens unquoted and quotes the rest", () => {
    expect(shellQuote("ses_x")).toBe("ses_x");
    expect(shellQuote("echo hi there")).toBe("'echo hi there'");
    expect(shellQuote("o'brien")).toBe("'o'\\''brien'");
  });
});

describe("currentPane", () => {
  it("reads TMUX_PANE from the environment", () => {
    expect(currentPane({ TMUX_PANE: "%3" })).toBe("%3");
    expect(currentPane({ TMUX_PANE: "" })).toBeNull();
    expect(currentPane({})).toBeNull();
  });
});
