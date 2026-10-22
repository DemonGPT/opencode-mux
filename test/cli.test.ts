import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import {
  buildNewSessionCommand,
  buildReexecArgv,
  buildWatcherArgv,
  flagsToArgv,
  isSessionNameTaken,
  main,
  parseMajorVersion,
  scopeDirectories,
  serviceGeneration,
  sessionNameCandidate,
  sessionNameSuffix,
  usageText,
  watchLogPath,
} from "../src/cli.js";
import { VERSION } from "../src/version.js";
import type { CliDeps, SpawnFn, SpawnHandle, SpawnResult } from "../src/cli.js";
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client";

function fakeSpawn(results: Record<string, (args: string[]) => Partial<SpawnResult>> = {}) {
  const calls: Array<{ command: string; args: string[]; opts?: { stdoutFile?: string; stderrFile?: string; inherit?: boolean } }> = [];
  const killed: Array<{ command: string; args: string[] }> = [];
  const spawn: SpawnFn = (command, args, opts) => {
    calls.push({ command, args, opts });
    const hit = results[command];
    const canned = hit ? hit(args) : command === "opencode" && args[0] === "--version" ? { stdout: "opencode v2.0.6" } : {};
    const done = Promise.resolve({ ok: true, code: 0, error: null, stdout: "", stderr: "", ...canned });
    return {
      pid: 1,
      done,
      kill: () => killed.push({ command, args }),
    } as SpawnHandle;
  };
  return { spawn, calls, killed };
}

const deps = (over: { spawn?: SpawnFn; env?: NodeJS.ProcessEnv; entryPath?: string; cwd?: string; connectServer?: CliDeps["connectServer"] } = {}) => ({
  env: over.env ?? {},
  spawn: over.spawn ?? fakeSpawn().spawn,
  entryPath: over.entryPath ?? "/x/dist/bin.js",
  cwd: over.cwd ?? "/x",
  connectServer: over.connectServer,
});

describe("usageText", () => {
  it("documents the mux flags and the passthrough contract", () => {
    const text = usageText();
    expect(text).toMatch(/--close <mode>/);
    expect(text).toMatch(/passed through to opencode/);
  });
});

describe("flagsToArgv", () => {
  it("re-emits resolved flags as mux argv", () => {
    expect(flagsToArgv({ layout: "main-vertical", mainPaneSize: 60 })).toEqual([
      "--layout", "main-vertical",
      "--main-pane-size", "60",
    ]);
  });

  it("flagsToArgv includes pane-command", () => {
    expect(flagsToArgv({ paneCommand: "tui" })).toEqual(["--pane-command", "tui"]);
    expect(flagsToArgv({ layout: "tiled", paneCommand: "mini" })).toEqual([
      "--layout", "tiled",
      "--pane-command", "mini",
    ]);
  });
});

describe("watchLogPath", () => {
  it("honours XDG_STATE_HOME and falls back to ~/.local/state", () => {
    expect(watchLogPath({ XDG_STATE_HOME: "/state" })).toBe("/state/opencode-mux/watch.log");
    expect(watchLogPath({})).toBe(join(process.env.HOME ?? "/tmp", ".local", "state", "opencode-mux", "watch.log"));
  });
});

describe("parseMajorVersion", () => {
  it("parses plain and prefixed versions", () => {
    expect(parseMajorVersion("2.0.5")).toBe(2);
    expect(parseMajorVersion("opencode v2.0.5")).toBe(2);
    expect(parseMajorVersion("v1.8.0")).toBe(1);
    expect(parseMajorVersion("garbage")).toBeNull();
  });
});

describe("serviceGeneration", () => {
  it("maps versions to the /api/status (legacy) and /api/info (new) protocol lines", () => {
    const legacy = ["opencode v2.0.0", "opencode v2.0.4", "opencode v2.0.5"];
    const modern = ["opencode v2.0.6", "opencode v2.0.7", "opencode v2.1.0"];
    const unsupported = ["opencode v1.9.0", "v3.0.0", "opencode v2", "garbage", ""];
    for (const version of legacy) expect(serviceGeneration(version)).toBe("legacy");
    for (const version of modern) expect(serviceGeneration(version)).toBe("new");
    for (const version of unsupported) expect(serviceGeneration(version)).toBeNull();
  });
});

describe("flag argv builders", () => {
  it("flagsToArgv skips unset flags and emits set ones in order", () => {
    expect(flagsToArgv({})).toEqual([]);
    expect(flagsToArgv({ layout: "tiled", graceSeconds: 30, closePanes: "keep", parent: null, sessionName: "duel" })).toEqual([
      "--layout", "tiled",
      "--close", "keep",
      "--grace", "30",
      "--parent", "",
      "--session-name", "duel",
    ]);
  });

  it("buildWatcherArgv is --mux-watch plus config path, flags and scope", () => {
    expect(buildWatcherArgv({ flags: {} })).toEqual(["--mux-watch"]);
    expect(buildWatcherArgv({ configPath: "/c", flags: { parent: "ses_p" } })).toEqual([
      "--mux-watch", "--config", "/c", "--parent", "ses_p",
    ]);
    expect(buildWatcherArgv({ flags: {}, scope: ["/other/project"] })).toEqual([
      "--mux-watch", "--mux-scope", "/other/project",
    ]);
  });

  it("buildReexecArgv and buildNewSessionCommand assemble the tmux re-exec", () => {
    expect(buildReexecArgv("/entry/bin.js", ["-s", "ses_p"])).toEqual(["/entry/bin.js", "-s", "ses_p"]);
    expect(buildNewSessionCommand({ entryPath: "/entry/bin.js", originalArgv: ["opencode", "--session=ses a"], sessionName: "mux", cwd: "/x" })).toEqual([
      "new-session", "-d", "-e", "MUX_OWNED_SESSION=1", "-e", "MUX_SESSION_NAME=mux", "-s", "mux", "-c", "/x",
      "/entry/bin.js", "opencode", "'--session=ses a'",
    ]);
  });
});

describe("concurrent session naming", () => {
  it("tags later candidates with the project directory", () => {
    expect(sessionNameSuffix("/home/u/work/my-app")).toBe("my-app");
    expect(sessionNameSuffix("/home/u/work/My App.v2")).toBe("My-App-v2");
    expect(sessionNameSuffix("/")).toBe("session");
    expect(sessionNameSuffix("/home/u/wörk")).toBe("w-rk");
    expect(sessionNameCandidate("mux", "/home/u/work/my-app", 0)).toBe("mux");
    expect(sessionNameCandidate("mux", "/home/u/work/my-app", 1)).toBe("mux-my-app");
    expect(sessionNameCandidate("mux", "/home/u/work/my-app", 2)).toBe("mux-my-app-2");
    expect(sessionNameCandidate("work", "/home/u/work/my-app", 1)).toBe("work-my-app");
  });

  it("detects tmux's duplicate-session refusal only", () => {
    const result = (stderr: string) => ({ ok: false, code: 1, error: null, stdout: "", stderr });
    expect(isSessionNameTaken(result("duplicate session: mux\n"))).toBe(true);
    expect(isSessionNameTaken(result("session already exists\n"))).toBe(true);
    expect(isSessionNameTaken(result("no server running on /tmp/tmux-1000/default\n"))).toBe(false);
    expect(isSessionNameTaken(result(""))).toBe(false);
  });

  it("scopes to the cwd plus explicit opencode directory arguments", () => {
    const dir = import.meta.dirname;
    expect(scopeDirectories([], "/work/app")).toEqual(["/work/app"]);
    expect(scopeDirectories([dir, "--model", "fast", "not-a-path"], "/work/app")).toEqual(["/work/app", dir]);
  });
});

describe("main", () => {
  it("prints help and exits 0 without spawning", async () => {
    const { spawn, calls } = fakeSpawn();
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await main(["--help"], deps({ spawn }))).toBe(0);
      expect(out).toHaveBeenCalledWith(usageText());
      expect(calls).toEqual([]);
    } finally {
      out.mockRestore();
    }
  });

  it("prints the version and exits 0", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await main(["--version"], deps())).toBe(0);
      expect(out).toHaveBeenCalledWith(`opencode-mux ${VERSION}\n`);
    } finally {
      out.mockRestore();
    }
  });

  it("errors with an install hint when tmux is missing", async () => {
    const { spawn } = fakeSpawn({ tmux: () => ({ ok: false, error: "ENOENT" }) });
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await main([], deps({ spawn }))).toBe(1);
      expect(err.mock.calls.join("")).toMatch(/tmux is required/);
    } finally {
      err.mockRestore();
    }
  });

  it("errors when opencode is not v2", async () => {
    const { spawn } = fakeSpawn({ opencode: () => ({ stdout: "opencode v1.9.0" }) });
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await main([], deps({ spawn }))).toBe(1);
      expect(err.mock.calls.join("")).toMatch(/opencode v2 is required/);
    } finally {
      err.mockRestore();
    }
  });

  it("errors with a hint and no extra spawns when the opencode version is unsupported", async () => {
    const { spawn, calls } = fakeSpawn({ opencode: () => ({ stdout: "opencode v2.0" }) });
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await main([], deps({ spawn }))).toBe(1);
      expect(err.mock.calls.join("")).toMatch(/unsupported opencode version/);
      expect(calls.map((c) => c.command)).toEqual(["tmux", "opencode"]);
    } finally {
      err.mockRestore();
    }
  });

  it("--mux-watch: refuses to connect when the opencode version is unsupported", async () => {
    const { spawn } = fakeSpawn({ opencode: () => ({ stdout: "opencode v2.0" }) });
    const connect = vi.fn(async () => ({ url: "http://127.0.0.1:1", client: {} as unknown as OpenCodeClient }));
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const code = await main(
        ["--mux-watch"],
        deps({ spawn, env: { TMUX: "/tmp/t,1,0", TMUX_PANE: "%0" }, connectServer: connect }),
      );
      expect(code).toBe(1);
      expect(connect).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  it("inside tmux: spawns the watcher, runs the TUI, kills watcher and session", async () => {
    const { spawn, calls, killed } = fakeSpawn();
    const env = {
      TMUX: "/tmp/t,1,0",
      TMUX_PANE: "%0",
      MUX_OWNED_SESSION: "1",
      XDG_CONFIG_HOME: "/nonexistent",
      XDG_STATE_HOME: "/tmp/omux",
    };
    const code = await main(["-s", "ses_p"], deps({ spawn, env, entryPath: "/x/dist/bin.js" }));
    expect(code).toBe(0);
    const commands = calls.map((c) => c.command);
    expect(commands).toEqual(["tmux", "opencode", "node", "opencode", "tmux"]);
    const watcher = calls.find((c) => c.command === "node")!;
    expect(watcher.args).toEqual(["/x/dist/bin.js", "--mux-watch", "--parent", "ses_p"]);
    expect(watcher.opts?.stdoutFile).toMatch(/watch\.log$/);
    expect(watcher.opts?.stderrFile).toBe(watcher.opts?.stdoutFile);
    const tui = calls.find((c) => c.command === "opencode" && c.args[0] === "-s")!;
    expect(tui.args).toEqual(["-s", "ses_p"]);
    expect(tui.opts?.inherit).toBe(true);
    expect(killed.some((k) => k.command === "node")).toBe(true);
    expect(calls.filter((c) => c.command === "tmux" && c.args[0] === "kill-session").map((c) => c.args)).toEqual([
      ["kill-session", "-t", "=mux"],
    ]);
  });

  it("inside tmux: forwards an explicit opencode <directory> to the watcher scope", async () => {
    const { spawn, calls } = fakeSpawn();
    const env = { TMUX: "/tmp/t,1,0", TMUX_PANE: "%0", XDG_CONFIG_HOME: "/nonexistent", XDG_STATE_HOME: "/tmp/omux" };
    const dir = import.meta.dirname;
    expect(await main([dir], deps({ spawn, env, entryPath: "/x/dist/bin.js" }))).toBe(0);
    const watcher = calls.find((c) => c.command === "node")!;
    expect(watcher.args).toEqual(["/x/dist/bin.js", "--mux-watch", "--mux-scope", dir]);
  });

  it("inside tmux: MUX_SESSION_NAME from the launcher wins over the config base name", async () => {
    const { spawn, calls } = fakeSpawn();
    const env = {
      TMUX: "/tmp/t,1,0",
      TMUX_PANE: "%0",
      MUX_OWNED_SESSION: "1",
      MUX_SESSION_NAME: "mux-my-app",
      XDG_CONFIG_HOME: "/nonexistent",
      XDG_STATE_HOME: "/tmp/omux",
    };
    expect(await main(["--session-name", "mux"], deps({ spawn, env, entryPath: "/x/dist/bin.js" }))).toBe(0);
    // The watcher still gets the explicit flag, the cleanup uses the owned name.
    expect(calls.filter((c) => c.command === "tmux").map((c) => c.args)).toEqual([["-V"], ["kill-session", "-t", "=mux-my-app"]]);
  });

  it("outside tmux: creates a session, applies session options, and attaches", async () => {
    const { spawn, calls } = fakeSpawn();
    const code = await main(
      ["--layout", "tiled", "--foo"],
      deps({ spawn, env: { XDG_CONFIG_HOME: "/nonexistent", XDG_STATE_HOME: "/tmp/omux" }, entryPath: "/x/dist/bin.js" }),
    );
    expect(code).toBe(0);
    const tmuxCalls = calls.filter((c) => c.command === "tmux").map((c) => c.args);
    expect(tmuxCalls[1]!.slice(0, 10)).toEqual(["new-session", "-d", "-e", "MUX_OWNED_SESSION=1", "-e", "MUX_SESSION_NAME=mux", "-s", "mux", "-c", "/x"]);
    expect(tmuxCalls[1]!.slice(10)).toEqual(["/x/dist/bin.js", "--layout", "tiled", "--foo"]);
    expect(tmuxCalls[2]).toEqual(["set-option", "-t", "mux", "status", "off"]);
    expect(tmuxCalls[3]).toEqual(["set-option", "-t", "mux", "mouse", "on"]);
    expect(tmuxCalls[4]).toEqual(["attach", "-t", "=mux"]);
  });

  it("outside tmux: a taken session name falls back to a project-tagged name", async () => {
    const taken = new Set(["mux"]);
    const { spawn, calls } = fakeSpawn({
      tmux: (args) => {
        if (args[0] !== "new-session") return {};
        const name = args[args.indexOf("-s") + 1]!;
        if (taken.has(name)) return { ok: false, code: 1, stderr: `duplicate session: ${name}\n` };
        taken.add(name);
        return {};
      },
    });
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const code = await main(
        [],
        deps({ spawn, env: { XDG_CONFIG_HOME: "/nonexistent", XDG_STATE_HOME: "/tmp/omux" }, entryPath: "/x/dist/bin.js", cwd: "/work/my-app" }),
      );
      expect(code).toBe(0);
      const tmuxCalls = calls.filter((c) => c.command === "tmux").map((c) => c.args);
      const names = tmuxCalls.filter((a) => a[0] === "new-session").map((a) => a[a.indexOf("-s") + 1]);
      expect(names).toEqual(["mux", "mux-my-app"]);
      expect(tmuxCalls).toContainEqual(["set-option", "-t", "mux-my-app", "status", "off"]);
      expect(tmuxCalls).toContainEqual(["attach", "-t", "=mux-my-app"]);
      expect(err.mock.calls.join("")).toMatch(/tmux session "mux" is taken; using "mux-my-app"/);
    } finally {
      err.mockRestore();
    }
  });

  it("outside tmux: keeps trying distinct names, then reports the duplicate failure", async () => {
    const { spawn, calls } = fakeSpawn({
      tmux: (args) => (args[0] === "new-session" ? { ok: false, code: 1, stderr: "duplicate session: mux\n" } : {}),
    });
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(
        await main([], deps({ spawn, env: { XDG_CONFIG_HOME: "/nonexistent", XDG_STATE_HOME: "/tmp/omux" }, entryPath: "/x/dist/bin.js", cwd: "/work/my-app" })),
      ).toBe(1);
      const attempts = calls.filter((c) => c.command === "tmux" && c.args[0] === "new-session");
      expect(attempts).toHaveLength(20);
      expect(attempts[0]!.args).toContain("mux");
      expect(attempts[1]!.args).toContain("mux-my-app");
      expect(err.mock.calls.join("")).toMatch(/failed to start tmux session: duplicate session: mux/);
      expect(calls.some((c) => c.command === "tmux" && c.args[0] === "attach")).toBe(false);
    } finally {
      err.mockRestore();
    }
  });

  it("outside tmux: a non-collision failure is reported immediately", async () => {
    const { spawn, calls } = fakeSpawn({
      tmux: (args) => (args[0] === "new-session" ? { ok: false, code: 1, stderr: "no server running on /tmp/tmux\n" } : {}),
    });
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(
        await main([], deps({ spawn, env: { XDG_CONFIG_HOME: "/nonexistent", XDG_STATE_HOME: "/tmp/omux" }, entryPath: "/x/dist/bin.js" })),
      ).toBe(1);
      expect(calls.filter((c) => c.command === "tmux" && c.args[0] === "new-session")).toHaveLength(1);
      expect(err.mock.calls.join("")).toMatch(/failed to start tmux session: no server running/);
    } finally {
      err.mockRestore();
    }
  });

  it("outside tmux: a failing set-option is non-fatal and attach still runs", async () => {
    const { spawn, calls } = fakeSpawn({
      tmux: (args) => (args[0] === "set-option" ? { ok: false, stderr: "boom" } : {}),
      opencode: () => ({ stdout: "opencode v2.0.6" }),
    });
    const code = await main(
      [],
      deps({ spawn, env: { XDG_CONFIG_HOME: "/nonexistent", XDG_STATE_HOME: "/tmp/omux" }, entryPath: "/x/dist/bin.js" }),
    );
    expect(code).toBe(0);
    const tmuxCalls = calls.filter((c) => c.command === "tmux").map((c) => c.args);
    expect(tmuxCalls.some((a) => a[0] === "set-option")).toBe(true);
    expect(tmuxCalls.at(-1)).toEqual(["attach", "-t", "=mux"]);
  });

  it("outside tmux: a failing new-session without stderr reports the exit code", async () => {
    const { spawn } = fakeSpawn({ tmux: (args) => (args[0] === "new-session" ? { ok: false, code: 3 } : {}) });
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(
        await main([], deps({ spawn, env: { XDG_CONFIG_HOME: "/nonexistent", XDG_STATE_HOME: "/tmp/omux" }, entryPath: "/x/dist/bin.js" })),
      ).toBe(1);
      expect(err.mock.calls.join("")).toBe("opencode-mux: failed to start tmux session: tmux exited with code 3\n");
    } finally {
      err.mockRestore();
    }
  });

  it("--mux-watch outside tmux: exits 1 with the TMUX_PANE hint", async () => {
    const { spawn } = fakeSpawn();
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await main(["--mux-watch"], deps({ spawn, env: {} }))).toBe(1);
      expect(err.mock.calls.join("")).toMatch(/TMUX_PANE/);
    } finally {
      err.mockRestore();
    }
  });

  it("--mux-watch inside tmux: runs the watcher loop via the injected client", async () => {
    const { spawn } = fakeSpawn();
    const firstEvent = { type: "server.connected", data: {} } as unknown as OpenCodeEvent;
    const client = {
      session: {
        active: async () => ({}),
        list: async () => ({ data: [] }),
      },
      event: {
        subscribe: async function* () {
          yield firstEvent;
        },
      },
    } as unknown as OpenCodeClient;
    const connect = vi.fn(async () => ({ url: "http://127.0.0.1:1", client }));
    const code = await main(
      ["--mux-watch", "--parent", "ses_p"],
      deps({
        spawn,
        env: { TMUX: "/tmp/t,1,0", TMUX_PANE: "%0", XDG_CONFIG_HOME: "/nonexistent", XDG_STATE_HOME: "/tmp/omux-runwatch" },
        connectServer: connect,
      }),
    );
    expect(code).toBe(0);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith({ generation: "new" });
  });

  it("--mux-watch: threads the legacy generation for opencode 2.0.5", async () => {
    const { spawn } = fakeSpawn({ opencode: () => ({ stdout: "opencode v2.0.5" }) });
    const firstEvent = { type: "server.connected", data: {} } as unknown as OpenCodeEvent;
    const client = {
      session: {
        active: async () => ({}),
        list: async () => ({ data: [] }),
      },
      event: {
        subscribe: async function* () {
          yield firstEvent;
        },
      },
    } as unknown as OpenCodeClient;
    const connect = vi.fn(async () => ({ url: "http://127.0.0.1:1", client }));
    const code = await main(
      ["--mux-watch"],
      deps({
        spawn,
        env: { TMUX: "/tmp/t,1,0", TMUX_PANE: "%0", XDG_CONFIG_HOME: "/nonexistent", XDG_STATE_HOME: "/tmp/omux-legacy" },
        connectServer: connect,
      }),
    );
    expect(code).toBe(0);
    expect(connect).toHaveBeenCalledWith({ generation: "legacy" });
  });
});
