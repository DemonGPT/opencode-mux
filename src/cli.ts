import { spawn } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parentFromPassThrough, parseArgs } from "./args.js";
import type { ParsedArgs } from "./args.js";
import { loadConfig } from "./config.js";
import type { CliFlags, MuxConfig } from "./config.js";
import { nodeExec } from "./exec.js";
import { connectServer } from "./server.js";
import type { ConnectServerDeps, ServerConnection, ServiceGeneration } from "./server.js";
import { currentPane, shellQuote, tmuxAdapter } from "./tmux.js";
import { createThemeStyles } from "./theme.js";
import { PaneTracker } from "./tracker.js";
import { VERSION } from "./version.js";
import { createWatcher, defaultPaneArgv } from "./watch.js";

export interface SpawnResult {
  ok: boolean;
  code: number | null;
  error: string | null;
  stdout: string;
  stderr: string;
}

export interface SpawnOpts {
  stdoutFile?: string;
  stderrFile?: string;
  inherit?: boolean;
}

export interface SpawnHandle {
  pid: number | null;
  done: Promise<SpawnResult>;
  kill(): void;
}

export type SpawnFn = (command: string, args: string[], opts?: SpawnOpts) => SpawnHandle;

/** Real subprocess launcher with optional file redirects (never throws). */
export function nodeSpawn(command: string, args: string[], opts: SpawnOpts = {}): SpawnHandle {
  let outFd: number | undefined;
  let errFd: number | undefined;
  try {
    outFd = opts.stdoutFile !== undefined ? openSync(opts.stdoutFile, "a") : undefined;
    errFd = opts.stderrFile !== undefined ? openSync(opts.stderrFile, "a") : undefined;
  } catch (error) {
    try {
      if (outFd !== undefined) closeSync(outFd);
    } catch {
      // already closed
    }
    return {
      pid: null,
      done: Promise.resolve({ ok: false, code: null, error: String(error), stdout: "", stderr: "" }),
      kill: () => {},
    };
  }
  const child = spawn(command, args, {
    stdio: opts.inherit ? "inherit" : ["ignore", outFd ?? "pipe", errFd ?? "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const closeFds = (): void => {
    try {
      if (outFd !== undefined) closeSync(outFd);
    } catch {
      // already closed
    }
    try {
      if (errFd !== undefined) closeSync(errFd);
    } catch {
      // already closed
    }
  };
  const done = new Promise<SpawnResult>((resolve) => {
    child.on("error", (error) => {
      closeFds();
      resolve({ ok: false, code: null, error: String(error), stdout, stderr });
    });
    child.on("close", (code) => {
      closeFds();
      resolve({ ok: code === 0, code, error: null, stdout, stderr });
    });
  });
  return {
    pid: child.pid ?? null,
    done,
    kill: () => {
      child.kill();
    },
  };
}

export interface CliDeps {
  env: NodeJS.ProcessEnv;
  spawn: SpawnFn;
  entryPath: string;
  opencodeCommand?: string;
  nodeCommand?: string;
  tmuxCommand?: string;
  cwd?: string;
  /** Injectable so the watcher path is unit-testable; defaults to the real server connection. */
  connectServer?: (deps?: ConnectServerDeps) => Promise<ServerConnection>;
}

export function usageText(): string {
  return [
    "opencode-mux — drop-in opencode wrapper that opens tmux panes for subagent sessions",
    "",
    "Usage:",
    "  opencode-mux [mux options] [opencode arguments...]",
    "",
    "Mux options:",
    "  --config <path>       config file (default ~/.config/opencode-mux.conf)",
    "  --layout <name>       pane layout: main-vertical | main-horizontal | tiled | even-horizontal | even-vertical (default main-vertical)",
    "  --main-pane-size <pct> main pane size for main-* layouts, percent of window (20-80, default 60)",
    "  --close <mode>        pane lifecycle: auto | keep (default auto)",
    "  --pane-command <cmd>  pane frontend: mini | tui (default mini)",
    "  --grace <seconds>     close delay after a session finishes (default 1)",
    "  --parent <id>         only watch children of this session",
    "  --session-name <name> base name for the owned tmux session (default mux;",
    "                        suffixed with the project when already taken)",
    "  -h, --help            show this help and exit",
    "  --version             print the version and exit",
    "",
    "All other arguments are passed through to opencode unchanged.",
    "",
  ].join("\n");
}

export function watchLogPath(env: NodeJS.ProcessEnv): string {
  const state = env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME !== "" ? env.XDG_STATE_HOME : join(homedir(), ".local", "state");
  return join(state, "opencode-mux", "watch.log");
}

/** Parses "2.0.5" or "opencode v2.0.5" into the major version; junk → null. */
export function parseMajorVersion(version: string): number | null {
  const match = /(?:^|\s)v?(\d+)\./.exec(version.trim());
  return match === null ? null : Number(match[1]);
}

/**
 * Maps an opencode version to the client protocol generation it speaks: 2.0.0–2.0.5
 * serve GET /api/status (legacy), 2.0.6+ serve GET /api/info (new). Each client
 * generation's Service.ensure() probes only its own endpoint and stops a mismatched
 * registered server, so the binary's generation must select the matching client.
 * Returns null for unsupported or unparseable versions.
 */
export function serviceGeneration(version: string): ServiceGeneration | null {
  const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (match === null) return null;
  const major = Number(match[1]);
  if (major !== 2) return null;
  const minor = Number(match[2]);
  return minor === 0 && Number(match[3]) < 6 ? "legacy" : "new";
}

/** tmux session name candidates tried before giving up (concurrent instances). */
const MAX_SESSION_NAME_ATTEMPTS = 20;

/** Project tag for auto-named sessions: tmux rejects spaces, dots and colons. */
export function sessionNameSuffix(cwd: string): string {
  const cleaned = basename(cwd)
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return cleaned === "" ? "session" : cleaned;
}

/**
 * tmux session names for successive attempts: the configured base name first,
 * then "<base>-<project>", then "<base>-<project>-2, -3, …".
 *
 * Later attempts only matter when the earlier names are taken — by another
 * opencode-mux instance running concurrently, or by a session left over from a
 * crash. Colliding instead of sharing is deliberate: each instance owns its
 * session (it kills it on exit) and two TUIs must not share one window.
 */
export function sessionNameCandidate(base: string, cwd: string, attempt: number): string {
  if (attempt <= 0) return base;
  const tagged = `${base}-${sessionNameSuffix(cwd)}`;
  return attempt === 1 ? tagged : `${tagged}-${attempt}`;
}

/** True when tmux refused `new-session` because the session name is taken. */
export function isSessionNameTaken(result: SpawnResult): boolean {
  return /duplicate session|already exists/i.test(`${result.stderr}\n${result.error ?? ""}`);
}

/**
 * Directories this instance may be showing: its working directory plus an
 * explicit opencode `<directory>` argument from the pass-through args (opencode
 * chdirs there, so its sessions belong to that directory, not our cwd).
 * Used to keep concurrent instances' subagents in their own windows.
 */
export function scopeDirectories(passThrough: string[], cwd: string): string[] {
  const dirs = [cwd];
  for (const arg of passThrough) {
    if (arg.startsWith("-")) continue;
    try {
      if (statSync(arg).isDirectory()) {
        const dir = resolve(cwd, arg);
        if (!dirs.includes(dir)) dirs.push(dir);
      }
    } catch {
      // not an existing path (a prompt, a value, …)
    }
  }
  return dirs;
}

/** Re-emits resolved CLI flags as mux argv (for the watcher child process). */
export function flagsToArgv(flags: CliFlags): string[] {
  const argv: string[] = [];
  if (flags.layout !== undefined) argv.push("--layout", flags.layout);
  if (flags.mainPaneSize !== undefined) argv.push("--main-pane-size", String(flags.mainPaneSize));
  if (flags.closePanes !== undefined) argv.push("--close", flags.closePanes);
  if (flags.paneCommand !== undefined) argv.push("--pane-command", flags.paneCommand);
  if (flags.graceSeconds !== undefined) argv.push("--grace", String(flags.graceSeconds));
  if (flags.parent !== undefined) argv.push("--parent", flags.parent ?? "");
  if (flags.sessionName !== undefined) argv.push("--session-name", flags.sessionName);
  return argv;
}

/** argv for the spawned watcher process: marker + config path + explicit flags. */
export function buildWatcherArgv(opts: { configPath?: string; flags: CliFlags; scope?: string[] }): string[] {
  return [
    "--mux-watch",
    ...(opts.configPath !== undefined ? ["--config", opts.configPath] : []),
    ...flagsToArgv(opts.flags),
    ...(opts.scope ?? []).flatMap((dir) => ["--mux-scope", dir]),
  ];
}

/** argv the re-exec'd instance runs inside the fresh tmux session. */
export function buildReexecArgv(entryPath: string, originalArgv: string[]): string[] {
  return [entryPath, ...originalArgv];
}

/** tmux new-session argv that boots the detached session and its command. */
export function buildNewSessionCommand(input: { entryPath: string; originalArgv: string[]; sessionName: string; cwd: string }): string[] {
  return [
    "new-session",
    "-d",
    "-e",
    "MUX_OWNED_SESSION=1",
    "-e",
    `MUX_SESSION_NAME=${input.sessionName}`,
    "-s",
    input.sessionName,
    "-c",
    input.cwd,
    ...buildReexecArgv(input.entryPath, input.originalArgv).map(shellQuote),
  ];
}

async function resolveConfig(parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<MuxConfig> {
  if (parsed.flags.parent === undefined) {
    const inferred = parentFromPassThrough(parsed.passThrough);
    if (inferred !== null) parsed.flags.parent = inferred;
  }
  const config = await loadConfig({ path: parsed.configPath, flags: parsed.flags, env });
  // The launcher may have picked a different name than the configured base when
  // that name was taken by another instance; the owned session must use it for
  // its tmux options and cleanup. Only our own launch sets MUX_SESSION_NAME.
  const ownedName = env.MUX_SESSION_NAME;
  if (env.MUX_OWNED_SESSION === "1" && ownedName !== undefined && ownedName !== "") {
    config.sessionName = ownedName;
  }
  return config;
}

async function runWatch(parsed: ParsedArgs, env: NodeJS.ProcessEnv, deps: CliDeps, generation: ServiceGeneration): Promise<number> {
  const targetPane = currentPane(env);
  if (targetPane === null) {
    process.stderr.write("opencode-mux: watcher requires TMUX_PANE (run inside tmux)\n");
    return 1;
  }
  const config = await resolveConfig(parsed, env);
  const logFile = watchLogPath(env);
  mkdirSync(dirname(logFile), { recursive: true });
  const append = (line: string): void => {
    try {
      appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`);
    } catch {
      // log failures are non-fatal
    }
  };
  const { client } = await (deps.connectServer ?? connectServer)({ generation });
  const tracker = new PaneTracker({ graceMs: config.graceSeconds * 1000, closePanes: config.closePanes });
  const watcher = createWatcher({
    client,
    tmux: tmuxAdapter(nodeExec()),
    tracker,
    log: append,
    targetPane,
    layout: config.layout,
    mainPaneSize: config.mainPaneSize,
    themeStyles: createThemeStyles({ env, cwd: deps.cwd ?? process.cwd() }),
    parentID: config.parent,
    // Without an explicit parent we watch every child session; scope that to
    // this instance's project so concurrent instances do not pane each other's
    // subagents. The cwd is the watcher's own; extra directories (an explicit
    // opencode <directory>) arrive via the internal --mux-scope flags.
    projectDirectories:
      config.parent === null
        ? [...new Set([deps.cwd ?? process.cwd(), ...parsed.scope])]
        : undefined,
    paneArgv: (id) => defaultPaneArgv(id, config.paneCommand),
    tickEveryMs: 500,
  });
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await watcher.start(controller.signal);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  return 0;
}

export async function main(argv: string[], deps: CliDeps): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    process.stdout.write(usageText());
    return 0;
  }
  if (parsed.version) {
    process.stdout.write(`opencode-mux ${VERSION}\n`);
    return 0;
  }

  const tmuxCommand = deps.tmuxCommand ?? "tmux";
  const opencodeCommand = deps.opencodeCommand ?? "opencode";
  const nodeCommand = deps.nodeCommand ?? "node";
  const env = deps.env;

  const tmuxCheck = await deps.spawn(tmuxCommand, ["-V"]).done;
  if (!tmuxCheck.ok) {
    process.stderr.write(
      "opencode-mux: tmux is required but was not found on PATH.\nInstall it with: apt install tmux (Debian/Ubuntu) or brew install tmux (macOS)\n",
    );
    return 1;
  }
  const opencodeCheck = await deps.spawn(opencodeCommand, ["--version"]).done;
  if (!opencodeCheck.ok) {
    process.stderr.write("opencode-mux: opencode is required but was not found on PATH.\nInstall or upgrade it: https://opencode.ai/v2/docs/\n");
    return 1;
  }
  const versionText = opencodeCheck.stdout.trim() || opencodeCheck.stderr.trim();
  if (parseMajorVersion(versionText) !== 2) {
    process.stderr.write(
      `opencode-mux: opencode v2 is required, found version "${versionText || "unknown"}".\nUpgrade it: https://opencode.ai/v2/docs/\n`,
    );
    return 1;
  }
  const generation = serviceGeneration(versionText);
  if (generation === null) {
    process.stderr.write(
      `opencode-mux: unsupported opencode version "${versionText || "unknown"}" (expected a 2.x.y release).\nUpgrade it: https://opencode.ai/v2/docs/\n`,
    );
    return 1;
  }

  if (parsed.watch) return runWatch(parsed, env, deps, generation);

  const config = await resolveConfig(parsed, env);
  const insideTmux = env.TMUX !== undefined && env.TMUX !== "" && env.TMUX_PANE !== undefined && env.TMUX_PANE !== "";

  if (!insideTmux) {
    const cwd = deps.cwd ?? process.cwd();
    // Concurrent instances each own their tmux session: when the configured
    // name is taken (another instance, or a stale session), the next candidate
    // is used. A failed `new-session` is the only race-free check — tmux
    // refuses duplicate names atomically — so collisions are retried rather
    // than probed.
    let sessionName: string | null = null;
    let failure: SpawnResult | null = null;
    for (let attempt = 0; attempt < MAX_SESSION_NAME_ATTEMPTS; attempt++) {
      const candidate = sessionNameCandidate(config.sessionName, cwd, attempt);
      const created = await deps
        .spawn(tmuxCommand, buildNewSessionCommand({
          entryPath: deps.entryPath,
          originalArgv: argv,
          sessionName: candidate,
          cwd,
        }))
        .done;
      if (created.ok) {
        sessionName = candidate;
        break;
      }
      failure = created;
      if (!isSessionNameTaken(created)) break;
    }
    if (sessionName === null) {
      // nodeSpawn reports `error` only when the command could not be started
      // (ENOENT, …); a tmux that ran and failed exits non-zero with the reason
      // on stderr (e.g. "duplicate session: mux"). Surface that instead of
      // printing "unknown error".
      const detail =
        failure === null
          ? `no free session name after ${MAX_SESSION_NAME_ATTEMPTS} attempts`
          : (failure.error ??
            (failure.stderr.trim() !== "" ? failure.stderr.trim() : `tmux exited with code ${failure.code ?? "unknown"}`));
      process.stderr.write(`opencode-mux: failed to start tmux session: ${detail}\n`);
      return 1;
    }
    if (sessionName !== config.sessionName) {
      process.stderr.write(`opencode-mux: tmux session "${config.sessionName}" is taken; using "${sessionName}"\n`);
    }
    // Session-scoped appearance, so the mux looks coherent regardless of the
    // user's global config. These touch only our own session — never -g.
    // Failures are non-fatal: attach proceeds and the exit code is unchanged.
    // `set-option` rejects the "=name" exact-match form (tmux 3.7), so it uses
    // the bare name; our session exists at this point, so it matches exactly.
    await deps.spawn(tmuxCommand, ["set-option", "-t", sessionName, "status", "off"]).done;
    await deps.spawn(tmuxCommand, ["set-option", "-t", sessionName, "mouse", "on"]).done;
    // "=name" pins the exact session: a bare name would prefix-match another
    // instance's session if ours disappeared in the meantime.
    const attached = await deps.spawn(tmuxCommand, ["attach", "-t", `=${sessionName}`], { inherit: true }).done;
    return attached.ok ? 0 : attached.code ?? 1;
  }

  const logFile = watchLogPath(env);
  mkdirSync(dirname(logFile), { recursive: true });
  const cwd = deps.cwd ?? process.cwd();
  const watcher = deps.spawn(
    nodeCommand,
    [
      deps.entryPath,
      ...buildWatcherArgv({
        configPath: parsed.configPath,
        flags: parsed.flags,
        // Openers other than the cwd: the watcher cannot see the pass-through
        // args, so forward the directories it must consider ours.
        scope: scopeDirectories(parsed.passThrough, cwd).filter((dir) => dir !== cwd),
      }),
    ],
    {
      stdoutFile: logFile,
      stderrFile: logFile,
    },
  );
  const tui = await deps.spawn(opencodeCommand, parsed.passThrough, { inherit: true }).done;
  watcher.kill();
  await watcher.done;
  if (env.MUX_OWNED_SESSION === "1") {
    // Exact match, never a prefix match: "mux" must not kill a sibling "mux-2".
    await deps.spawn(tmuxCommand, ["kill-session", "-t", `=${config.sessionName}`]).done;
  }
  return tui.ok ? 0 : tui.code ?? 1;
}
