import { describe, expect, it } from "vitest";
import type { Exec } from "../src/exec.ts";
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
  it("splits a pane with layout flags and pane argv", async () => {
    const { exec, calls } = capturingExec({ tmux: () => ({ stdout: "%5\n" }) });
    const t = tmuxAdapter(exec);
    const r = await t.splitPane({ targetPane: "%0", layout: "main-vertical", argv: ["opencode", "-s", "ses_x"] });
    expect(r).toEqual({ ok: true, error: null, paneId: "%5" });
    expect(calls).toEqual([
      { command: "tmux", args: ["split-window", "-P", "-F", "#{pane_id}", "-t", "%0", "-h", "opencode", "-s", "ses_x"] },
    ]);
  });

  it("maps main-horizontal to -v and tiled to no flag", async () => {
    const a = capturingExec({ tmux: () => ({ stdout: "%5\n" }) });
    await tmuxAdapter(a.exec).splitPane({ targetPane: "%0", layout: "main-horizontal", argv: ["opencode"] });
    expect(a.calls[0]!.args).toEqual(["split-window", "-P", "-F", "#{pane_id}", "-t", "%0", "-v", "opencode"]);
    const b = capturingExec({ tmux: () => ({ stdout: "%5\n" }) });
    await tmuxAdapter(b.exec).splitPane({ targetPane: "%0", layout: "tiled", argv: ["opencode"] });
    expect(b.calls[0]!.args).toEqual(["split-window", "-P", "-F", "#{pane_id}", "-t", "%0", "opencode"]);
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

  it("returns failure when the pane id is missing", async () => {
    const { exec } = capturingExec({ tmux: () => ({ stdout: "" }) });
    const r = await tmuxAdapter(exec).splitPane({ targetPane: "%0", layout: "tiled", argv: [] });
    expect(r.ok).toBe(false);
    expect(r.paneId).toBeNull();
  });

  it("kills a pane", async () => {
    const { exec, calls } = capturingExec();
    const r = await tmuxAdapter(exec).killPane("%5");
    expect(r).toEqual({ ok: true, error: null });
    expect(calls).toEqual([{ command: "tmux", args: ["kill-pane", "-t", "%5"] }]);
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
