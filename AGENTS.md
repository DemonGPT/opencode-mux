# AGENTS.md — working on opencode-mux

## Project

**opencode-mux** (npm `opencode-mux`, v0.1.0, MIT): a drop-in wrapper for
opencode v2 that opens tmux panes for subagent sessions automatically.
Node >= 20, TypeScript, ESM (`"type": "module"`), built with `tsc`, tested
with Vitest. No runtime framework. Package ships only `dist/`
(`bin.opencode-mux → dist/bin.js`).

## Architecture map

| Module | Role |
| ------ | ---- |
| `src/bin.ts` | Entry; `#!/usr/bin/env node`, wires `main` with real spawn/env |
| `src/cli.ts` | Orchestration: tmux/opencode version gates, session creation, owned-session cleanup, watcher spawn, `--mux-watch` path |
| `src/args.ts` | Flag parsing: mux flags consumed, everything else passed through to opencode; `--mux-*` unknown flags error |
| `src/config.ts` | `opencode-mux.conf` (XDG-aware) loading; auto-creates with defaults; precedence flags > file > defaults; unknown keys ignored |
| `src/watch.ts` | Watcher: server events → pane lifecycle; `defaultPaneArgv` = `["opencode", "mini", "-s", sessionID]` |
| `src/tracker.ts` | `PaneTracker` state machine: open → closing (grace) → closed; `closePanes: auto\|keep` |
| `src/tmux.ts` | Tmux adapter: split-window, kill-pane, window-scoped border styles (`-w`), `currentPane` from `TMUX_PANE` |
| `src/theme.ts` | Theme resolution + mtime-cached provider (`createThemeStyles`) |
| `src/theme/builtin.ts` | **Generated** — vendored border table of the 33 opencode v2.0.5 built-in themes. Do not hand-edit; regenerate via `scripts/generate-theme-table.mjs` |
| `src/server.ts` | Connect to the opencode background service (generation-aware) |
| `src/session.ts` | Session/event helpers |
| `src/exec.ts` | `nodeExec()` command runner used by the tmux adapter |
| `src/version.ts` | `VERSION` constant |

## Non-negotiable invariants

0. **Commit identity: agent commits use `opencode <opencode@agents.local>` —
   NEVER the human's identity.** The repo has no local `user.name`/`user.email`
   (the global config belongs to the human). Every agent-made commit MUST set
   the author and committer explicitly, e.g.
   `GIT_AUTHOR_NAME=opencode GIT_AUTHOR_EMAIL=opencode@agents.local GIT_COMMITTER_NAME=opencode GIT_COMMITTER_EMAIL=opencode@agents.local git commit ...`
   The same applies to rebases/amends (env vars override config for the whole
   command). Verify with `git log --format='%an <%ae>'` before pushing.

1. **Never touch user config.** No tmux `-g` options, no writes to
   `~/.tmux.conf`, and no writes to opencode configs (`cli.json`, `tui.json`,
   `auth.json`, ...). Tmux writes are runtime-scoped only:
   - session options: `set-option -t <session> ...`
   - border styles: `set-option -w ...` / `set-option -w -u ...` (window scope)
   - never `-g` anywhere.
2. **The only config opencode-mux writes** is its own auto-created
   `opencode-mux.conf` (best-effort; read-only environments still run on
   defaults).
3. **Theme safety**: a `"system"` theme or anything unknown/unresolvable means
   **no border styling** — never wrong colors. Theme resolution precedence:
   project `.opencode/cli.json` → project `.opencode/tui.json` → global
   `cli.json` → global `tui.json` (first name wins; v2 object form
   `theme.name`/`theme.mode` and legacy string form both supported). Explicit
   `dark`/`light` mode is honored; `system`/absent → dark.
4. **opencode compatibility is two generations**: 2.0.0–2.0.5 (legacy client,
   server probes `GET /api/status`) and 2.0.6+ (new client, probes
   `GET /api/info`). `serviceGeneration()` in `cli.ts` selects the matching
   client; the binary's generation must always drive the choice. Keep any new
   server interaction working on **both**.
5. **Pane command is `opencode mini -s <id>`** (both generations support it).
   Mini removes the tab strip/agent switcher that the full TUI cannot hide —
   that's deliberate. The main pane always gets the full TUI
   (`opencode` + pass-through args).
6. **Failures are non-fatal** for appearance: a failing `set-option` or border
   apply never changes exit codes or blocks attach.

## Behavior notes

- Outside tmux: create owned detached session (env `MUX_OWNED_SESSION=1`),
  scope `status off`/`mouse on` to it, re-exec inside, attach. On TUI exit,
  `kill-session` the owned session.
- Inside tmux: run as watcher; adopt already-running children at start
  (finished ones are skipped — no startup pane flash); open pane per child
  session `created` event for our parent; close after `graceSeconds` (default
  1) following session finish.
- Parent session is inferred from pass-through `-s`/`--session` when
  `--parent` is absent.
- Theme hot-reload: mtime-cached provider checked every 500 ms tick;
  `JSON.stringify` change detection; apply/clear via `applyBorderStyles`/
  `clearBorderStyles`; **zero tmux calls when nothing changed**.
- Watcher log: `$XDG_STATE_HOME/opencode-mux/watch.log`.
- `--mux-watch`/`--parent` are internal flags emitted by the CLI itself.

## Testing

```sh
npm test        # vitest — full suite must stay green (125 tests baseline)
npm run check   # tsc --noEmit
npm run build   # tsc -p tsconfig.build.json
```

- **`scripts/e2e-smoke.ts` is environment-blocked** (needs a staging env). It
  must stay byte-exact — do not modify it as a workaround.
- The live-verification pattern is a scratch harness driving compiled `dist/`
  modules against an isolated tmux server (`TMUX_TMPDIR`) and an isolated
  opencode daemon. Keep the real daemon out of tests at all costs.

## Environment quirks (learned the hard way)

- **The shell tool may collapse newlines** in inline commands. For anything
  multi-step, write a script file (e.g. `/tmp/opencode-mux-probe/x.sh`) and
  run `bash /tmp/.../x.sh` — script files preserve newlines and work.
- **A scratch tmux server loads the user's `~/.tmux.conf`** (e.g.
  `base-index 1`): the first window may be index 1, not 0. Always target
  panes by pane id (`#{pane_id}`), never by hard-coded `session:0.0`.
- **tmux 3.7c quirk**: option commands reject `session:index` targets
  (`no such window: app:0`) but accept pane ids / bare session names / `@window`.
  Production code already uses pane ids / session names.
- **Isolated daemon pattern**: `opencode serve --port N` with scratch
  `XDG_CONFIG_HOME`/`XDG_STATE_HOME`/etc. Plain `serve` does **not** write a
  `service.json` — seed one yourself
  (`{id, version, url, pid, password}`, copy the shape from
  `~/.local/state/opencode/service.json`). HTTP auth is **Basic**
  `opencode:<password>`, not Bearer. Model calls need the real
  `auth.json` copied into the scratch config dir.
- Copy the real `auth.json` from `~/.local/share/opencode/auth.json`.
- The real daemon is at `~/.local/state/opencode/service.json` — never churn
  it with connect/smoke tests.
- `opencode mini` renders to the alternate screen; captures taken in the
  first seconds can appear blank (flush timing) — capture again after a few
  seconds or capture the full pane before trusting a blank.
- The running opencode daemon is the source of truth for compatible versions;
  `opencode --version` can differ from earlier notes (user upgrades freely).
  The wrapper must keep working on 2.0.5 *and* 2.0.6+.

## Conventions

- Additive forward-compat: unknown config keys are ignored; unknown
  non-`--mux-` args pass through to opencode; unknown `--mux-*` flags are an
  error.
- Theme table regen: `node scripts/generate-theme-table.mjs` (fetches the
  pinned `anomalyco/opencode` v2.0.5 tag) or `--from <dir>` for local assets.
  Idempotent — output must be byte-identical on re-run.
- Keep tests representative of the *new* pane command shape when touching
  pane argv (`["opencode", "mini", "-s", id]`; session id is `argv[3]`).
- Error messages are prefixed `opencode-mux:` and reference stderr.
- **Release flow**: `npm version <x.y.z>` (identity-env vars set) creates the
  version commit + `v*` tag; push `main` and the tag — the tag push triggers
  `.github/workflows/publish.yml`, which publishes to npm with provenance
  (requires the `NPM_TOKEN` secret). Publish is not done manually.