import { spawn } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parentFromPassThrough, parseArgs } from "./args.js";
import type { ParsedArgs } from "./args.js";
import { loadConfig } from "./config.js";
import type { CliFlags, MuxConfig } from "./config.js";
import { nodeExec } from "./exec.js";
import { connectServer } from "./server.js";
import type { ServerConnection } from "./server.js";
import { currentPane, shellQuote, tmuxAdapter } from "./tmux.js";
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
  connectServer?: () => Promise<ServerConnection>;
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
    "  --layout <name>       pane layout: main-vertical | main-horizontal | tiled (default main-vertical)",
    "  --close <mode>        pane lifecycle: auto | keep (default auto)",
    "  --grace <seconds>     close delay after a session finishes (default 15)",
    "  --parent <id>         only watch children of this session",
    "  --session-name <name> tmux session name (default mux)",
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
 * True when an opencode version speaks the client's service protocol (/api/info,
 * introduced in 2.0.6). Older servers only expose /api/status, which the client's
 * Service.ensure() treats as incompatible and stops — so the CLI refuses before
 * connecting. Fails closed on unparseable input.
 */
export function meetsServiceProtocol(version: string): boolean {
  const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (match === null) return false;
  const major = Number(match[1]);
  if (major > 2) return true;
  if (major < 2) return false;
  const minor = Number(match[2]);
  return minor > 0 || Number(match[3]) >= 6;
}

/** Re-emits resolved CLI flags as mux argv (for the watcher child process). */
export function flagsToArgv(flags: CliFlags): string[] {
  const argv: string[] = [];
  if (flags.layout !== undefined) argv.push("--layout", flags.layout);
  if (flags.closePanes !== undefined) argv.push("--close", flags.closePanes);
  if (flags.graceSeconds !== undefined) argv.push("--grace", String(flags.graceSeconds));
  if (flags.parent !== undefined) argv.push("--parent", flags.parent ?? "");
  if (flags.sessionName !== undefined) argv.push("--session-name", flags.sessionName);
  return argv;
}

/** argv for the spawned watcher process: marker + config path + explicit flags. */
export function buildWatcherArgv(opts: { configPath?: string; flags: CliFlags }): string[] {
  return [
    "--mux-watch",
    ...(opts.configPath !== undefined ? ["--config", opts.configPath] : []),
    ...flagsToArgv(opts.flags),
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
  return loadConfig({ path: parsed.configPath, flags: parsed.flags, env });
}

async function runWatch(parsed: ParsedArgs, env: NodeJS.ProcessEnv, deps: CliDeps): Promise<number> {
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
  const { client } = await (deps.connectServer ?? connectServer)();
  const tracker = new PaneTracker({ graceMs: config.graceSeconds * 1000, closePanes: config.closePanes });
  const watcher = createWatcher({
    client,
    tmux: tmuxAdapter(nodeExec()),
    tracker,
    log: append,
    targetPane,
    layout: config.layout,
    parentID: config.parent,
    paneArgv: defaultPaneArgv,
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
  if (!meetsServiceProtocol(versionText)) {
    process.stderr.write(
      `opencode-mux: opencode "${versionText}" predates the client service protocol (needs >= 2.0.6); connecting would stop its running server.\nUpgrade it: https://opencode.ai/v2/docs/\n`,
    );
    return 1;
  }

  if (parsed.watch) return runWatch(parsed, env, deps);

  const config = await resolveConfig(parsed, env);
  const insideTmux = env.TMUX !== undefined && env.TMUX !== "" && env.TMUX_PANE !== undefined && env.TMUX_PANE !== "";

  if (!insideTmux) {
    const created = await deps
      .spawn(tmuxCommand, buildNewSessionCommand({
        entryPath: deps.entryPath,
        originalArgv: argv,
        sessionName: config.sessionName,
        cwd: deps.cwd ?? process.cwd(),
      }))
      .done;
    if (!created.ok) {
      process.stderr.write(`opencode-mux: failed to start tmux session: ${created.error ?? "unknown error"}\n`);
      return 1;
    }
    const attached = await deps.spawn(tmuxCommand, ["attach", "-t", config.sessionName], { inherit: true }).done;
    return attached.ok ? 0 : attached.code ?? 1;
  }

  const logFile = watchLogPath(env);
  mkdirSync(dirname(logFile), { recursive: true });
  const watcher = deps.spawn(nodeCommand, [deps.entryPath, ...buildWatcherArgv({ configPath: parsed.configPath, flags: parsed.flags })], {
    stdoutFile: logFile,
    stderrFile: logFile,
  });
  const tui = await deps.spawn(opencodeCommand, parsed.passThrough, { inherit: true }).done;
  watcher.kill();
  await watcher.done;
  if (env.MUX_OWNED_SESSION === "1") {
    await deps.spawn(tmuxCommand, ["kill-session", "-t", config.sessionName]).done;
  }
  return tui.ok ? 0 : tui.code ?? 1;
}
