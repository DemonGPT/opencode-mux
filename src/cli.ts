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
 * crash. Colliding instead of sharing is deliberate: two TUIs must not share
 * one window, and each instance's session is independent — nothing kills it,
 * it simply ends when its own TUI pane exits (AGENTS.md invariant 7).
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

/** A tmux session id as printed by `-P -F '#{session_id}'` (`$0`, `$12`, …). */
const SESSION_ID_PATTERN = /^\$\d+$/;

/**
 * The session id tmux printed at creation, or null when stdout is not exactly
 * an id. Only trailing whitespace is ignored: leading junk, extra lines or
 * extra text mean the format was not what we asked for, and proximity matters
 * (a stray `$3` inside noise is not trustworthy). Measured on tmux 3.8 with an
 * isolated server: an unsupported -F format prints *empty* stdout with rc 0,
 * so both "no output" and "junk output" are reachable with a successful
 * new-session.
 */
function printedSessionId(stdout: string): string | null {
  const printed = stdout.trimEnd();
  return SESSION_ID_PATTERN.test(printed) ? printed : null;
}

/**
 * Directories this instance may be showing: its working directory plus at most
 * one explicit opencode `<directory>` argument from the pass-through args
 * (opencode chdirs there, so its sessions belong to that directory, not our
 * cwd). Used to keep concurrent instances' subagents in their own windows.
 *
 * Only a *positional* argument counts as that directory: it must not start
 * with "-" **and** its predecessor must not be a flag token. We cannot know
 * which opencode flags take a value, so `--some-opt /tmp/other /real/project`
 * must treat `/tmp/other` as that flag's value (treating it as the directory
 * would silently scope the watcher to a foreign project — hiding our own
 * subagents *and* paning theirs). opencode's `<directory>` is documented as a
 * positional argument; if it could legitimately follow a flag, that flag would
 * need an explicit rule here rather than widening this one.
 *
 * Only the *first* accepted directory is kept: any other positional is far
 * more likely to be a prompt that happens to name a path, and adding it would
 * widen the watcher's scope again.
 */
export function scopeDirectories(passThrough: string[], cwd: string): string[] {
  const dirs = [cwd];
  for (let i = 0; i < passThrough.length; i++) {
    const arg = passThrough[i]!;
    if (arg.startsWith("-")) continue;
    // A token after a flag token may be that flag's value, never a positional.
    const previous = passThrough[i - 1];
    if (previous !== undefined && previous.startsWith("-")) continue;
    try {
      if (!statSync(arg).isDirectory()) continue;
      const dir = resolve(cwd, arg);
      if (!dirs.includes(dir)) dirs.push(dir);
      break;
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

/**
 * tmux new-session argv that boots the detached session and its command.
 *
 * `-P -F '#{session_id}'` makes tmux print the new session's id (`$0`, …), which
 * the caller uses as an exact `-t` target: a bare session *name* would
 * prefix-match a sibling instance's session if ours disappeared in the
 * meantime, and tmux session ids are exact by construction.
 *
 * Ownership is deliberately NOT propagated through the tmux session
 * environment: `-e` would leak into every process in the session (and into any
 * nested opencode-mux run), which would then kill the host session on exit.
 * There is no ownership marker at all: the session owns itself and ends when
 * its TUI pane exits, so no session is ever killed explicitly (AGENTS.md
 * invariant 7 — a kill would also destroy user windows and can resolve to the
 * wrong session).
 */
export function buildNewSessionCommand(input: { entryPath: string; originalArgv: string[]; sessionName: string; cwd: string }): string[] {
  return [
    "new-session",
    "-d",
    "-P",
    "-F",
    "#{session_id}",
    "-s",
    input.sessionName,
    "-c",
    input.cwd,
    ...buildReexecArgv(input.entryPath, input.originalArgv).map(shellQuote),
  ];
}

/** First `-s`/`--session`/`--session=<v>` value in the pass-through args, else null. */
function sessionPinValue(passThrough: string[]): string | null {
  for (let i = 0; i < passThrough.length; i++) {
    const arg = passThrough[i]!;
    if (arg === "-s" || arg === "--session") {
      const next = passThrough[i + 1];
      if (next !== undefined && !next.startsWith("-")) return next;
    }
    if (arg.startsWith("--session=")) return arg.slice("--session=".length);
  }
  return null;
}

async function resolveConfig(parsed: ParsedArgs, env: NodeJS.ProcessEnv): Promise<MuxConfig> {
  if (parsed.flags.parent === undefined) {
    const inferred = parentFromPassThrough(parsed.passThrough);
    if (inferred !== null) {
      parsed.flags.parent = inferred;
    } else {
      // Without a usable parent the instance watches the whole project. Say so
      // instead of silently widening: a typo'd session id looks like "it just
      // watches everything". Never fatal, never changes the exit code.
      const ignored = sessionPinValue(parsed.passThrough);
      if (ignored !== null && ignored !== "") {
        process.stderr.write(
          `opencode-mux: ignoring -s value "${ignored}": not an opencode session id (watching this project instead)\n`,
        );
      }
    }
  }
  return loadConfig({ path: parsed.configPath, flags: parsed.flags, env });
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
      // Instances share one log file: pid + timestamp make every line attributable.
      appendFileSync(logFile, `[${new Date().toISOString()}] [${process.pid}] ${line}\n`);
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
    /** `-t` target for the session-scoped options; tmux resolves it as a target-pane. */
    let optionTarget: string | null = null;
    /** `-t` target for attach; the exact-match "=name" form is accepted here. */
    let attachTarget: string | null = null;
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
        // Exact handle for the later -t: tmux printed the session id (`$0`, …).
        // When stdout is not a clean id (unsupported -F format → empty stdout
        // with rc 0, or junk), fall back to the name itself. Measured on tmux
        // 3.8 (isolated server): `set-option -t '=name' …` fails with
        // "no such session: =name" (rc 1) because set-option resolves a
        // *target-pane* and only a bare session name works there, while
        // `attach -t '=name'` resolves fine. So the fallback uses the bare name
        // for the options and "=name" for attach; the id works for both.
        const id = printedSessionId(created.stdout);
        optionTarget = id ?? candidate;
        attachTarget = id ?? `=${candidate}`;
        break;
      }
      failure = created;
      if (!isSessionNameTaken(created)) break;
    }
    if (sessionName === null || optionTarget === null || attachTarget === null) {
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
    // The target is the session id captured at creation whenever tmux printed
    // one: exact by construction, so it can never prefix-match a sibling. With
    // no usable id the options target the bare session name (the only form
    // `set-option` resolves for a session) and attach uses the exact-match
    // "=name" form; a failing set-option there stays non-fatal, as always.
    await deps.spawn(tmuxCommand, ["set-option", "-t", optionTarget, "status", "off"]).done;
    await deps.spawn(tmuxCommand, ["set-option", "-t", optionTarget, "mouse", "on"]).done;
    const attached = await deps.spawn(tmuxCommand, ["attach", "-t", attachTarget], { inherit: true }).done;
    // No cleanup here. `attach` returns on TUI exit *and* on detach
    // (prefix+d), and a detached session must keep running. Nothing kills the
    // session at all: it ends by itself when its TUI pane exits.
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
  // Never kill a session: the session terminates by itself when its TUI pane
  // exits, this instance may be living in the user's own session, and an
  // id-resolving kill could even target the host it runs in (without
  // TMUX_PANE, `display-message '#{session_id}'` means tmux's "current"
  // session). Killing would also destroy windows the user opened here.
  return tui.ok ? 0 : tui.code ?? 1;
}
