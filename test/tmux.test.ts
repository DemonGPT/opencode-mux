import { describe, expect, it } from "vitest";
import type { Exec } from "../src/exec.ts";
import type { Layout } from "../src/config.ts";
import { currentPane, shellQuote, tmuxAdapter } from "../src/tmux.ts";

function capturingExec(overrides: Record<string, (args: string[]) => { stdout?: string; stderr?: string; ok?: boolean; error?: string | null }> = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const exec: Exec = {
    async run(command, args) {
      calls.push({ command, args });
      const hit = overrides[command]?.(args);
      return {
        ok: hit?.ok ?? true,
        code: (hit?.ok ?? true) ? 0 : 1,
        stdout: hit?.stdout ?? "",
        stderr: hit?.stderr ?? "",
        error: hit?.error ?? null,
      };
    },
  };
  return { exec, calls };
}

describe("tmuxAdapter", () => {
  it("splits a pane with pane argv and shapes the window via select-layout", async () => {
    const { exec, calls } = capturingExec({ tmux: () => ({ stdout: "%5\n" }) });
    const t = tmuxAdapter(exec);
    const r = await t.splitPane({ targetPane: "%0", layout: "main-vertical", argv: ["opencode", "-s", "ses_x"] });
    expect(r).toEqual({ ok: true, error: null, paneId: "%5" });
    expect(calls).toEqual([
      { command: "tmux", args: ["split-window", "-P", "-F", "#{pane_id}", "-t", "%0", "opencode", "-s", "ses_x"] },
      { command: "tmux", args: ["select-layout", "-t", "%0", "main-vertical"] },
    ]);
  });

  it("applies the named layout after every split, for every layout", async () => {
    for (const layout of ["main-vertical", "main-horizontal", "tiled", "even-horizontal", "even-vertical"] as const) {
      const { exec, calls } = capturingExec({ tmux: () => ({ stdout: "%5\n" }) });
      await tmuxAdapter(exec).splitPane({ targetPane: "%0", layout, argv: ["opencode"] });
      expect(calls).toEqual([
        { command: "tmux", args: ["split-window", "-P", "-F", "#{pane_id}", "-t", "%0", "opencode"] },
        { command: "tmux", args: ["select-layout", "-t", "%0", layout] },
      ]);
    }
  });

  it("quotes argv items that the tmux shell join would mangle", async () => {
    const { exec, calls } = capturingExec({ tmux: () => ({ stdout: "%5\n" }) });
    await tmuxAdapter(exec).splitPane({ targetPane: "%0", layout: "tiled", argv: ["sh", "-c", "echo hi there", "o'brien"] });
    expect(calls[0]!.args.slice(6)).toEqual(["sh", "-c", "'echo hi there'", "'o'\\''brien'"]);
  });

  it("returns failure with stderr when tmux errors", async () => {
    const { exec } = capturingExec({ tmux: () => ({ ok: false, stderr: "no server running" }) });
    const r = await tmuxAdapter(exec).splitPane({ targetPane: "%0", layout: "tiled", argv: [] });
    expect(r).toEqual({ ok: false, error: "no server running", paneId: null });
  });

  it("returns failure when the pane id is missing and skips select-layout", async () => {
    const { exec, calls } = capturingExec({ tmux: () => ({ stdout: "" }) });
    const r = await tmuxAdapter(exec).splitPane({ targetPane: "%0", layout: "tiled", argv: [] });
    expect(r.ok).toBe(false);
    expect(r.paneId).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("sizes the main pane via window options, only for main-* layouts", async () => {
    const run = async (layout: Layout, mainPaneSize: number | undefined) => {
      const { exec, calls } = capturingExec({ tmux: () => ({ stdout: "%5\n" }) });
      const r = await tmuxAdapter(exec).splitPane({ targetPane: "%0", layout, mainPaneSize, argv: ["opencode"] });
      expect(r.ok).toBe(true);
      return calls.map((c) => c.args);
    };
    const splitOnly = (layout: Layout) => [
      ["split-window", "-P", "-F", "#{pane_id}", "-t", "%0", "opencode"],
      ["select-layout", "-t", "%0", layout],
    ];
    // main-* layouts set their window option (percent) then apply the plain
    // preset layout; select-layout itself rejects "layout,size" suffixes.
    expect(await run("main-vertical", 60)).toEqual([
      ["split-window", "-P", "-F", "#{pane_id}", "-t", "%0", "opencode"],
      ["set-option", "-w", "-t", "%0", "main-pane-width", "60%"],
      ["select-layout", "-t", "%0", "main-vertical"],
    ]);
    expect(await run("main-horizontal", 80)).toEqual([
      ["split-window", "-P", "-F", "#{pane_id}", "-t", "%0", "opencode"],
      ["set-option", "-w", "-t", "%0", "main-pane-height", "80%"],
      ["select-layout", "-t", "%0", "main-horizontal"],
    ]);
    // Non-main layouts have no main pane: no option set, plain layout.
    expect(await run("tiled", 60)).toEqual(splitOnly("tiled"));
    expect(await run("even-horizontal", 60)).toEqual(splitOnly("even-horizontal"));
    // No size given: no option set, as before.
    expect(await run("main-vertical", undefined)).toEqual(splitOnly("main-vertical"));
  });

  it("kills a pane", async () => {
    const { exec, calls } = capturingExec();
    const r = await tmuxAdapter(exec).killPane("%5");
    expect(r).toEqual({ ok: true, error: null });
    expect(calls).toEqual([{ command: "tmux", args: ["kill-pane", "-t", "%5"] }]);
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
    const { exec, calls } = capturingExec({
      tmux: (args) => (args.includes("pane-border-style") ? { ok: false, stderr: "bad style\n" } : {}),
    });
    const r = await tmuxAdapter(exec).applyBorderStyles("%0", { inactive: "fg=red", active: "fg=green" });
    expect(r).toEqual({ ok: false, error: "bad style" });
    expect(calls).toEqual([
      { command: "tmux", args: ["set-option", "-w", "-t", "%0", "pane-border-style", "fg=red"] },
      { command: "tmux", args: ["set-option", "-w", "-t", "%0", "pane-active-border-style", "fg=green"] },
    ]);
  });

  it("applyBorderStyles uses -w scoping and never passes -g", async () => {
    const { exec, calls } = capturingExec();
    await tmuxAdapter(exec).applyBorderStyles("%0", { inactive: "a", active: "b" });
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.args.includes("-w") && !c.args.includes("-g"))).toBe(true);
  });

  it("clearBorderStyles unsets both border options with -w -u on the target pane", async () => {
    const { exec, calls } = capturingExec();
    const r = await tmuxAdapter(exec).clearBorderStyles("%0");
    expect(r).toEqual({ ok: true, error: null });
    expect(calls).toEqual([
      { command: "tmux", args: ["set-option", "-w", "-u", "-t", "%0", "pane-border-style"] },
      { command: "tmux", args: ["set-option", "-w", "-u", "-t", "%0", "pane-active-border-style"] },
    ]);
  });

  it("clearBorderStyles is best-effort and reports the first error", async () => {
    const { exec, calls } = capturingExec({
      tmux: (args) => (args.includes("pane-border-style") ? { ok: false, stderr: "no server\n" } : {}),
    });
    const r = await tmuxAdapter(exec).clearBorderStyles("%0");
    expect(r).toEqual({ ok: false, error: "no server" });
    expect(calls).toHaveLength(2);
  });

  it("clearBorderStyles never passes -g", async () => {
    const { exec, calls } = capturingExec();
    await tmuxAdapter(exec).clearBorderStyles("%0");
    expect(calls.every((c) => c.args.includes("-w") && c.args.includes("-u") && !c.args.includes("-g"))).toBe(true);
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
