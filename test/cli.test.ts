import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

/**
 * Fake spawner. tmux's `new-session` answers with a clean session id (`$0`) by
 * default, so outside-tmux tests exercise the primary id path rather than
 * silently landing on the "=name" fallback. A test that wants the fallback (or
 * junk on stdout) overrides `stdout` explicitly.
 */
function fakeSpawn(results: Record<string, (args: string[]) => Partial<SpawnResult>> = {}) {
  const calls: Array<{ command: string; args: string[]; opts?: { stdoutFile?: string; stderrFile?: string; inherit?: boolean } }> = [];
  const killed: Array<{ command: string; args: string[] }> = [];
  const spawn: SpawnFn = (command, args, opts) => {
    calls.push({ command, args, opts });
    const hit = results[command];
    const defaults: Partial<SpawnResult> =
      command === "tmux" && args[0] === "new-session"
        ? { stdout: "$0\n" }
        : command === "opencode" && args[0] === "--version"
          ? { stdout: "opencode v2.0.6" }
          : {};
    const canned = { ...defaults, ...(hit ? hit(args) : {}) };
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

/**
 * Client double for the --mux-watch path. The watcher reconnects on every
 * stream end (a daemon restart must not leave it blind), so a watch run only
 * finishes when a signal aborts it — the way the real TUI ends it. `main`
 * installs its SIGINT/SIGTERM handlers before subscribing, so emitting the
 * signal from the stream is deterministic.
 */
function watcherClient(events: OpenCodeEvent[], onSubscribe?: (signal: AbortSignal | undefined) => void): OpenCodeClient {
  return {
    session: {
      active: async () => ({}),
      list: async () => ({ data: [] }),
    },
    event: {
      subscribe: async function* (opts?: { signal?: AbortSignal }) {
        onSubscribe?.(opts?.signal);
        for (const event of events) yield event;
      },
    },
  } as unknown as OpenCodeClient;
}

/** Aborts the running watcher from inside its own event stream. */
const stopOnSubscribe = (signal: AbortSignal | undefined): void => {
  expect(signal?.aborted).toBe(false);
  process.emit("SIGINT");
};

/**
 * Env for every test that lets `main` reach `runWatch` (`--mux-watch`).
 *
 * The theme adapter is NOT injectable through CliDeps: `src/cli.ts` builds it
 * from `env` + `cwd`, and the watcher applies the resolved border styles via
 * `tmuxAdapter(nodeExec())` — real tmux, inheriting `process.env` (whose `TMUX`
 * points at the user's live server), against `TMUX_PANE` from this env. So any
 * *resolvable* theme writes window options to a real tmux. With no config,
 * `pickTheme` falls back to the builtin `opencode` theme, which is exactly that
 * hazard. A "system" theme resolves to null (no styling ⇒ zero tmux calls), so
 * every watch-path test must force it. `XDG_STATE_HOME` is a temp dir too, so
 * the shared watch.log lands in the sandbox.
 */
function watchEnv(over: NodeJS.ProcessEnv = {}): { env: NodeJS.ProcessEnv; stateHome: string } {
  const configHome = mkdtempSync(join(tmpdir(), "omux-watch-config-"));
  mkdirSync(join(configHome, "opencode"), { recursive: true });
  writeFileSync(join(configHome, "opencode", "cli.json"), JSON.stringify({ theme: "system" }));
  const stateHome = mkdtempSync(join(tmpdir(), "omux-watch-state-"));
  return {
    env: { TMUX: "/tmp/t,1,0", TMUX_PANE: "%0", XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome, ...over },
    stateHome,
  };
}

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
      "new-session", "-d", "-P", "-F", "#{session_id}", "-s", "mux", "-c", "/x",
      "/entry/bin.js", "opencode", "'--session=ses a'",
    ]);
  });

  it("buildNewSessionCommand asks for the session id and injects no ownership at all", () => {
    const cmd = buildNewSessionCommand({ entryPath: "/entry/bin.js", originalArgv: [], sessionName: "mux", cwd: "/x" });
    // No env markers and no argv marker: ownership is the session's own lifetime.
    expect(cmd).not.toContain("-e");
    expect(cmd.some((arg) => arg.startsWith("MUX_"))).toBe(false);
    expect(cmd).not.toContain("--mux-owned");
    expect(cmd).toContain("-P");
    expect(cmd[cmd.indexOf("-F") + 1]).toBe("#{session_id}");
    // Re-exec tail is exactly [entryPath, ...originalArgv] — here just the entry.
    expect(cmd.slice(9)).toEqual(["/entry/bin.js"]);
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

  it("scopes to the cwd plus at most one explicit opencode directory argument", () => {
    const dir = import.meta.dirname;
    const other = join(dir, "..");
    expect(scopeDirectories([], "/work/app")).toEqual(["/work/app"]);
    expect(scopeDirectories([dir, "--model", "fast", "not-a-path"], "/work/app")).toEqual(["/work/app", dir]);
    // A prompt naming another existing directory must not widen the scope again.
    expect(scopeDirectories([dir, other], "/work/app")).toEqual(["/work/app", dir]);
    expect(scopeDirectories(["not-a-path", dir], "/work/app")).toHaveLength(2);
    expect(scopeDirectories(["/work/app"], "/work/app")).toEqual(["/work/app"]);
  });

  it("never treats a flag's value as the opencode directory", () => {
    const dir = import.meta.dirname;
    const other = join(dir, "..");
    // `opencode-mux --some-opt /tmp/other /real/project`: we cannot know which
    // flags take a value, so the token after a flag is a value, never the
    // <directory>. The second positional is the only candidate — scoping to
    // the flag value would both hide this project's subagents and pane a
    // foreign project's (silently).
    expect(scopeDirectories(["--some-opt", dir, other], "/work/app")).toEqual(["/work/app", other]);
    // The flag value alone leaves the scope at the cwd.
    expect(scopeDirectories(["--some-opt", dir], "/work/app")).toEqual(["/work/app"]);
    // A bare positional still wins, first accepted directory only.
    expect(scopeDirectories([other, dir], "/work/app")).toEqual(["/work/app", other]);
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

  it("inside tmux: spawns the watcher, runs the TUI, kills the watcher only", async () => {
    const { spawn, calls, killed } = fakeSpawn();
    const env = {
      TMUX: "/tmp/t,1,0",
      TMUX_PANE: "%0",
      XDG_CONFIG_HOME: "/nonexistent",
      XDG_STATE_HOME: "/tmp/omux",
    };
    const code = await main(["-s", "ses_p"], deps({ spawn, env, entryPath: "/x/dist/bin.js" }));
    expect(code).toBe(0);
    const commands = calls.map((c) => c.command);
    expect(commands).toEqual(["tmux", "opencode", "node", "opencode"]);
    const watcher = calls.find((c) => c.command === "node")!;
    expect(watcher.args).toEqual(["/x/dist/bin.js", "--mux-watch", "--parent", "ses_p"]);
    expect(watcher.opts?.stdoutFile).toMatch(/watch\.log$/);
    expect(watcher.opts?.stderrFile).toBe(watcher.opts?.stdoutFile);
    const tui = calls.find((c) => c.command === "opencode" && c.args[0] === "-s")!;
    expect(tui.args).toEqual(["-s", "ses_p"]);
    expect(tui.opts?.inherit).toBe(true);
    expect(killed.some((k) => k.command === "node")).toBe(true);
    // Regression guard: an instance inside a session must never kill it, and
    // must never probe for a kill target either.
    expect(calls.filter((c) => c.command === "tmux" && c.args[0] === "kill-session")).toEqual([]);
    expect(calls.filter((c) => c.command === "tmux" && c.args[0] === "display-message")).toEqual([]);
  });

  it("inside tmux: forwards an explicit opencode <directory> to the watcher scope", async () => {
    const { spawn, calls } = fakeSpawn();
    const env = { TMUX: "/tmp/t,1,0", TMUX_PANE: "%0", XDG_CONFIG_HOME: "/nonexistent", XDG_STATE_HOME: "/tmp/omux" };
    const dir = import.meta.dirname;
    expect(await main([dir], deps({ spawn, env, entryPath: "/x/dist/bin.js" }))).toBe(0);
    const watcher = calls.find((c) => c.command === "node")!;
    expect(watcher.args).toEqual(["/x/dist/bin.js", "--mux-watch", "--mux-scope", dir]);
  });

  it("inside tmux: stale ownership env confers nothing — no display-message, no kill-session", async () => {
    const { spawn, calls } = fakeSpawn();
    const env = {
      TMUX: "/tmp/t,1,0",
      TMUX_PANE: "%0",
      MUX_OWNED_SESSION: "1",
      MUX_SESSION_NAME: "mux-my-app",
      XDG_CONFIG_HOME: "/nonexistent",
      XDG_STATE_HOME: "/tmp/omux",
    };
    expect(await main(["--session-name", "mux", "-s", "ses_p"], deps({ spawn, env, entryPath: "/x/dist/bin.js" }))).toBe(0);
    // The only tmux call is the version probe: nothing resolves an id, nothing kills.
    expect(calls.filter((c) => c.command === "tmux").map((c) => c.args)).toEqual([["-V"]]);
  });

  it("inside tmux: warns instead of silently widening on an unparsable -s value", async () => {
    const { spawn, calls } = fakeSpawn();
    const env = { TMUX: "/tmp/t,1,0", TMUX_PANE: "%0", XDG_CONFIG_HOME: "/nonexistent", XDG_STATE_HOME: "/tmp/omux" };
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await main(["-s", "not-a-session"], deps({ spawn, env, entryPath: "/x/dist/bin.js" }))).toBe(0);
      expect(err.mock.calls.join("")).toBe(
        'opencode-mux: ignoring -s value "not-a-session": not an opencode session id (watching this project instead)\n',
      );
      // Still watches: the instance is simply not pinned to a parent.
      const watcher = calls.find((c) => c.command === "node")!;
      expect(watcher.args).toEqual(["/x/dist/bin.js", "--mux-watch"]);
    } finally {
      err.mockRestore();
    }
  });

  it("inside tmux: warns for an unparsable --session=<value> too", async () => {
    const { spawn } = fakeSpawn();
    const env = { TMUX: "/tmp/t,1,0", TMUX_PANE: "%0", XDG_CONFIG_HOME: "/nonexistent", XDG_STATE_HOME: "/tmp/omux" };
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await main(["--session=typo"], deps({ spawn, env, entryPath: "/x/dist/bin.js" }))).toBe(0);
      expect(err.mock.calls.join("")).toMatch(/ignoring -s value "typo"/);
    } finally {
      err.mockRestore();
    }
  });

  it("warns once in the launching process and still watches the project", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const warnings = (): string[] =>
      err.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("ignoring -s value"));
    try {
      const outside = fakeSpawn();
      expect(
        await main(["-s", "typo"], deps({ spawn: outside.spawn, env: { XDG_CONFIG_HOME: "/nonexistent", XDG_STATE_HOME: "/tmp/omux" }, entryPath: "/x/dist/bin.js" })),
      ).toBe(0);
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toBe('opencode-mux: ignoring -s value "typo": not an opencode session id (watching this project instead)\n');
      // Known consequence, not a bug to hide: the re-exec'd instance inside the
      // new session runs resolveConfig again, so it prints the same warning a
      // second time — on the pane's tty, wiped by opencode's alternate screen.
      // The re-exec argv still carries the original `-s typo`.
      const reexec = outside.calls.find((c) => c.command === "tmux" && c.args[0] === "new-session")!;
      expect(reexec.args.slice(-2)).toEqual(["-s", "typo"]);
      // Still watches, unpinned, and never kills anything.
      const tmuxCalls = outside.calls.filter((c) => c.command === "tmux").map((c) => c.args);
      expect(tmuxCalls.some((a) => a[0] === "kill-session")).toBe(false);
    } finally {
      err.mockRestore();
    }
  });

  it("outside tmux: creates a session, applies session options and attaches; never cleans up itself", async () => {
    const { spawn, calls } = fakeSpawn();
    const code = await main(
      ["--layout", "tiled", "--foo"],
      deps({ spawn, env: { XDG_CONFIG_HOME: "/nonexistent", XDG_STATE_HOME: "/tmp/omux" }, entryPath: "/x/dist/bin.js" }),
    );
    expect(code).toBe(0);
    const tmuxCalls = calls.filter((c) => c.command === "tmux").map((c) => c.args);
    expect(tmuxCalls[1]!.slice(0, 9)).toEqual(["new-session", "-d", "-P", "-F", "#{session_id}", "-s", "mux", "-c", "/x"]);
    // Re-exec tail is exactly [entryPath, ...originalArgv]: no ownership marker.
    expect(tmuxCalls[1]!.slice(9)).toEqual(["/x/dist/bin.js", "--layout", "tiled", "--foo"]);
    // tmux printed the new session's id (`$0`): every later -t targets it.
    expect(tmuxCalls[2]).toEqual(["set-option", "-t", "$0", "status", "off"]);
    expect(tmuxCalls[3]).toEqual(["set-option", "-t", "$0", "mouse", "on"]);
    expect(tmuxCalls[4]).toEqual(["attach", "-t", "$0"]);
    // attach also returns on detach (prefix+d): the creator must not kill.
    expect(tmuxCalls.some((a) => a[0] === "kill-session")).toBe(false);
  });

  it("outside tmux: targets the session id tmux printed at creation", async () => {
    const { spawn, calls } = fakeSpawn({
      tmux: (args) => (args[0] === "new-session" ? { stdout: "$3\n" } : {}),
    });
    const code = await main(
      [],
      deps({ spawn, env: { XDG_CONFIG_HOME: "/nonexistent", XDG_STATE_HOME: "/tmp/omux" }, entryPath: "/x/dist/bin.js" }),
    );
    expect(code).toBe(0);
    const tmuxCalls = calls.filter((c) => c.command === "tmux").map((c) => c.args);
    expect(tmuxCalls).toContainEqual(["set-option", "-t", "$3", "status", "off"]);
    expect(tmuxCalls).toContainEqual(["set-option", "-t", "$3", "mouse", "on"]);
    expect(tmuxCalls).toContainEqual(["attach", "-t", "$3"]);
    // attach is the last tmux command of the launch: a regression to
    // toContainEqual alone would let a later tmux call slip in unnoticed.
    expect(tmuxCalls.at(-1)).toEqual(["attach", "-t", "$3"]);
    expect(tmuxCalls.some((a) => a[0] === "kill-session")).toBe(false);
  });

  /**
   * Measured on tmux 3.8 (isolated server): `set-option -t '=name' …` fails
   * with "no such session: =name" (rc 1) because set-option resolves a
   * *target-pane* — only a bare session name works there — while
   * `attach -t '=name'` resolves fine. Also measured: an unsupported -F format
   * prints empty stdout with rc 0, so a bad/absent id is reachable exactly when
   * the fallback is needed. Hence: valid id → that id for both; anything else →
   * bare candidate for set-option, "=candidate" for attach.
   */
  it("outside tmux: an empty id falls back to bare name for set-option and =name for attach", async () => {
    const { spawn, calls } = fakeSpawn({ tmux: (args) => (args[0] === "new-session" ? { stdout: "" } : {}) });
    const code = await main(
      [],
      deps({ spawn, env: { XDG_CONFIG_HOME: "/nonexistent", XDG_STATE_HOME: "/tmp/omux" }, entryPath: "/x/dist/bin.js" }),
    );
    expect(code).toBe(0);
    const tmuxCalls = calls.filter((c) => c.command === "tmux").map((c) => c.args);
    expect(tmuxCalls).toContainEqual(["set-option", "-t", "mux", "status", "off"]);
    expect(tmuxCalls).toContainEqual(["set-option", "-t", "mux", "mouse", "on"]);
    expect(tmuxCalls).toContainEqual(["attach", "-t", "=mux"]);
    // The fallback target is never empty (an empty -t would mean "current").
    for (const option of ["status", "mouse"]) {
      const call = tmuxCalls.find((a) => a[0] === "set-option" && a.includes(option))!;
      expect(call[call.indexOf("-t") + 1]).toBe("mux");
    }
    expect(tmuxCalls.some((a) => a[0] === "kill-session")).toBe(false);
  });

  it.each([
    { label: "whitespace-only stdout", stdout: "  \n" },
    { label: "garbage stdout", stdout: "noise\n" },
    { label: "an id behind another line", stdout: "\n$3" },
    { label: "an id with extra text", stdout: "$3 extra\n" },
  ])("outside tmux: $label is not accepted as a session id", async ({ stdout }) => {
    const { spawn, calls } = fakeSpawn({ tmux: (args) => (args[0] === "new-session" ? { stdout } : {}) });
    const code = await main(
      [],
      deps({ spawn, env: { XDG_CONFIG_HOME: "/nonexistent", XDG_STATE_HOME: "/tmp/omux" }, entryPath: "/x/dist/bin.js" }),
    );
    expect(code).toBe(0);
    const tmuxCalls = calls.filter((c) => c.command === "tmux").map((c) => c.args);
    expect(tmuxCalls).toContainEqual(["set-option", "-t", "mux", "status", "off"]);
    expect(tmuxCalls).toContainEqual(["set-option", "-t", "mux", "mouse", "on"]);
    expect(tmuxCalls).toContainEqual(["attach", "-t", "=mux"]);
    expect(tmuxCalls.some((a) => a[0] === "kill-session")).toBe(false);
  });

  it("outside tmux: a clean id with a trailing newline is accepted", async () => {
    const { spawn, calls } = fakeSpawn({ tmux: (args) => (args[0] === "new-session" ? { stdout: "$12\n" } : {}) });
    expect(
      await main([], deps({ spawn, env: { XDG_CONFIG_HOME: "/nonexistent", XDG_STATE_HOME: "/tmp/omux" }, entryPath: "/x/dist/bin.js" })),
    ).toBe(0);
    const tmuxCalls = calls.filter((c) => c.command === "tmux").map((c) => c.args);
    expect(tmuxCalls).toContainEqual(["set-option", "-t", "$12", "status", "off"]);
    expect(tmuxCalls).toContainEqual(["attach", "-t", "$12"]);
    expect(tmuxCalls.some((a) => a.includes("=mux"))).toBe(false);
  });

  it("outside tmux: a failed attach kills nothing and keeps its exit code", async () => {
    const { spawn, calls } = fakeSpawn({
      tmux: (args) => (args[0] === "attach" ? { ok: false, code: 7, stderr: "boom" } : {}),
    });
    const code = await main(
      [],
      deps({ spawn, env: { XDG_CONFIG_HOME: "/nonexistent", XDG_STATE_HOME: "/tmp/omux" }, entryPath: "/x/dist/bin.js" }),
    );
    expect(code).toBe(7);
    const tmuxCalls = calls.filter((c) => c.command === "tmux").map((c) => c.args);
    expect(tmuxCalls).toContainEqual(["attach", "-t", "$0"]);
    expect(tmuxCalls.some((a) => a[0] === "kill-session")).toBe(false);
  });

  it("outside tmux: a taken session name falls back to a project-tagged name", async () => {
    const taken = new Set(["mux"]);
    const { spawn, calls } = fakeSpawn({
      tmux: (args) => {
        if (args[0] !== "new-session") return {};
        const name = args[args.indexOf("-s") + 1]!;
        if (taken.has(name)) return { ok: false, code: 1, stderr: `duplicate session: ${name}\n` };
        taken.add(name);
        // Each successful new-session prints its own id; the retry's id is $1.
        return { stdout: "$1\n" };
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
      expect(tmuxCalls).toContainEqual(["set-option", "-t", "$1", "status", "off"]);
      expect(tmuxCalls).toContainEqual(["attach", "-t", "$1"]);
      expect(tmuxCalls.some((a) => a[0] === "kill-session")).toBe(false);
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
    // A failing set-option is non-fatal and attach is still the last call.
    expect(tmuxCalls.at(-1)).toEqual(["attach", "-t", "$0"]);
    expect(tmuxCalls.some((a) => a[0] === "kill-session")).toBe(false);
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
    const client = watcherClient([firstEvent], stopOnSubscribe);
    const connect = vi.fn(async () => ({ url: "http://127.0.0.1:1", client }));
    // Instances share one log file, so every line carries timestamp + pid.
    const { env, stateHome } = watchEnv();
    const code = await main(
      ["--mux-watch", "--parent", "ses_p"],
      deps({ spawn, env, connectServer: connect }),
    );
    expect(code).toBe(0);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith({ generation: "new" });
    const logPath = join(stateHome, "opencode-mux", "watch.log");
    const lines = readFileSync(logPath, "utf8").trimEnd().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^\[\d{4}-\d\d-\d\dT[^\]]+\] \[\d+\] /);
      expect(line).toContain(`[${process.pid}]`);
    }
    expect(lines.some((line) => line.includes("server connected"))).toBe(true);
  });

  it("--mux-watch: threads the legacy generation for opencode 2.0.5", async () => {
    const { spawn } = fakeSpawn({ opencode: () => ({ stdout: "opencode v2.0.5" }) });
    const firstEvent = { type: "server.connected", data: {} } as unknown as OpenCodeEvent;
    const client = watcherClient([firstEvent], stopOnSubscribe);
    const connect = vi.fn(async () => ({ url: "http://127.0.0.1:1", client }));
    // watchEnv forces the unstyled "system" theme: this run must not touch tmux.
    const { env } = watchEnv();
    const code = await main(
      ["--mux-watch"],
      deps({ spawn, env, connectServer: connect }),
    );
    expect(code).toBe(0);
    expect(connect).toHaveBeenCalledWith({ generation: "legacy" });
  });
});
