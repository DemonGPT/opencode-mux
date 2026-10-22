# AGENTS.md — working on opencode-mux

## Project

**opencode-mux** (npm `opencode-mux`, v1.3.0, MIT): a drop-in wrapper for
opencode v2 that opens tmux panes for subagent sessions automatically.
Node >= 20, TypeScript, ESM (`"type": "module"`), built with `tsc`, tested
with Vitest. No runtime framework. Package ships only `dist/`
(`bin.opencode-mux → dist/bin.js`).

## Architecture map

| Module | Role |
| ------ | ---- |
| `src/bin.ts` | Entry; `#!/usr/bin/env node`, wires `main` with real spawn/env |
| `src/cli.ts` | Orchestration: tmux/opencode version gates, session creation (collision-safe naming, session-id capture for `-t`/attach, see concurrency invariant), watcher spawn, `--mux-watch` path |
| `src/args.ts` | Flag parsing: mux flags consumed, everything else passed through to opencode; `--mux-*` unknown flags error |
| `src/config.ts` | `opencode-mux.conf` (XDG-aware) loading; auto-creates with defaults; precedence flags > file > defaults; unknown keys ignored |
| `src/watch.ts` | Watcher: server events → pane lifecycle; optional project scoping (`projectDirectories`, see concurrency invariant); `defaultPaneArgv(sessionID, paneCommand)` = `["env", "BUN_CONFIG_HTTP_IDLE_TIMEOUT=0", "opencode", "mini", "-s", sessionID]` for `mini`, `["opencode", "-s", sessionID]` for `tui` (default `paneCommand` = `"mini"`) |
| `src/tracker.ts` | `PaneTracker` state machine: pending → open → closing (grace; emitted exactly once, cancellable by `markBusy`) → forgotten; `kept` for `closePanes: keep`. No closed phase — the watcher `forget`s the entry after handling the close |
| `src/tmux.ts` | Tmux adapter: split-window (+ pane-scoped `@mux-instance` tag), kill-pane, `relayout` (re-apply the configured layout, used after a pane closes), window-scoped border styles (`-w`), `windowInstances` probe that skips layout and border clears in a window another instance shares, `currentPane` from `TMUX_PANE` |
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
   - pane markers: `set-option -p -t <pane> @mux-instance <tag>` (pane scope;
     records which instance created the pane)
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
5. **Default pane command is `opencode mini -s <id>`** (both generations
   support it), launched through `env BUN_CONFIG_HTTP_IDLE_TIMEOUT=0` to work
   around upstream opencode #50135: mini's long-lived `session.wait` is aborted
   by Bun's 300s fetch idle timeout, freezing the pane during long tool calls.
   Mini removes the tab strip/agent switcher that the full TUI cannot hide —
   that's deliberate. `--pane-command tui` launches the full TUI as bare
   `opencode -s <id>` — opencode has **no `tui` subcommand**, so
   `opencode tui -s <id>` would parse `tui` as the directory argument and exit
   immediately (`ENOENT: chdir … -> 'tui'`), closing the pane. The main pane
   always gets the full TUI (`opencode` + pass-through args).
6. **Failures are non-fatal** for appearance: a failing `set-option` or border
   apply never changes exit codes or blocks attach.
7. **Instances are independent**: several opencode-mux processes may run
   concurrently (one per project/terminal) against the same background service.
   - Each outside-tmux launch **owns exactly one** tmux session and never
     shares it: `new-session` is attempted with the configured base name
     (`mux`), then `<base>-<project>`, then `<base>-<project>-N`. Session
     creation is the race-free check (tmux refuses duplicates atomically), and
     `new-session -d -P -F '#{session_id}'` returns the **session id**, which
     `set-option`/`attach` then target — exact by construction, so a bare name
     can never prefix-match a sibling. When no id is parsed the fallback is
     the bare name for `set-option` (the only form it resolves) and `=name`
     for attach. **Never inject ownership into the session
     environment** (`-e MUX_OWNED_SESSION=...`): it is inherited by every
     process in the session, so a nested launch would kill its host. **Never
     run `kill-session` either** — from any path: the session already ends when
     its TUI pane exits, a kill would also destroy windows the user opened in
     it, and any id-resolving kill is self-destructive (without `TMUX_PANE`,
     `display-message '#{session_id}'` returns whatever session tmux calls
     "current", possibly the host this process lives in). Ownership is simply
     the session's own lifetime. The one intentional exception is
     `scripts/e2e-smoke.ts`, which cleans up only the isolated smoke session it
     created itself; that file is byte-exact and frozen (see Testing).
   - A window is **not** shared between instances. Each created pane is tagged
     with its instance (`@mux-instance`); before applying a window-wide layout,
     the adapter lists the window's tags and skips re-tiling (and skips
     clearing border styles) when a foreign tag is present. Two instances in
     one window therefore degrade to "first one keeps the geometry" instead of
     re-tiling over each other on every event.
   - A watcher **without an explicit parent** must only pane subagents whose
     parent session belongs to its own project (`projectDirectories` =
     cwd + an explicit opencode `<directory>` arg, matched with
     `isSameProject`: equal or ancestor/descendant). Never reintroduce global
     watch-all: two instances would open panes for each other's subagents.
   - An explicit `--parent` pins the scope and skips directory matching. A
     pass-through `-s`/`--session` pins it too, but only when the value starts
     with `ses_`; anything else prints a warning on stderr and falls back to
     project scoping.

## Behavior notes

- Outside tmux: create the detached session
  (`new-session -d -P -F '#{session_id}'`, no `-e` env markers), scope
  `status off`/`mouse on` to the captured session id, re-exec inside, attach.
  Nothing kills the session: it ends when its TUI pane exits, detaching keeps
  it, and windows the user opened inside it survive. `kill-session` is banned
  outside the frozen smoke script (see invariant 7).
- Inside tmux: run as watcher; adopt already-running children at start
  (finished ones are skipped — no startup pane flash); open pane per child
  session `created` event for our parent; close after `graceSeconds` (default
  1) following session finish. A close is re-checked against
  `session.active()` first: a stale or duplicated terminal event must never
  kill a pane whose session is working again (fail-open if the lookup throws),
  and the tracker state is re-validated after that await (still `closing`,
  emitted, same pane id) so a session that started a new turn mid-lookup keeps
  its pane; `forget()` runs in a `finally`, and a failed `kill-pane` still
  triggers the relayout. `start()` resubscribes after ~1 s whenever the event
  stream ends or errors (the SDK's `SharedEvents` finishes its subscribers
  instead of reconnecting), and each (re)connect's `server.connected` triggers
  `adopt()` again — so a daemon restart does not leave the watcher blind for
  the rest of the TUI's life. One subscription is active at a time, and an
  abort exits promptly. Without an explicit parent, only children of sessions
  in this project get panes (concurrent instances; parent directory lookups
  via `session.get` are cached per parent id, capped at 256 entries and
  invalidated on `session.moved`).
- The watcher log is shared by all instances
  (`$XDG_STATE_HOME/opencode-mux/watch.log`); lines are appended atomically and
  carry the writing pid (`[<iso>] [<pid>] …`) so concurrent instances can be
  told apart.
- Concurrent instances re-apply layout and borders per their own window, so
  they never fight over another window's geometry. In a window two instances
  share, the layout is left to the first instance and border styles are
  last-writer-wins by design (they self-correct on the next theme change).
- New panes are created with `split-window -d`, so opening a subagent pane
  never steals focus from the main TUI.
- Every split and every close re-applies the configured layout
  (`tmux.relayout` → `set-option -w main-pane-width/height` for `main-*`,
  then `select-layout`). tmux hands a closed pane's cells to one neighbour, so
  without the post-close relayout the remaining subagent panes keep uneven
  sizes. The relayout runs even when `kill-pane` fails (the pane may have
  exited on its own); its failures are logged, never fatal.
- Parent session is inferred from pass-through `-s`/`--session` when
  `--parent` is absent — only when the value starts with `ses_`.
- Theme hot-reload: mtime-cached provider checked every 500 ms tick;
  `JSON.stringify` change detection; apply/clear via `applyBorderStyles`/
  `clearBorderStyles`; **zero tmux calls when nothing changed**.
- Watcher log: `$XDG_STATE_HOME/opencode-mux/watch.log`.
- `--mux-watch` and `--mux-scope` are internal flags emitted by the CLI itself
  (`--mux-scope` forwards project-scope directories to the watcher). `--parent`
  is public and the CLI forwards it to the watcher child; an explicit parent
  disables directory scoping.
- Layout re-tiling is skipped for a window another instance also owns (see
  invariant 7), and a failing `set-option -w` (main pane size) is reported on
  the split result (`layoutError`) instead of being swallowed — the pane still
  opens and the watcher logs it. Skips are logged once per distinct reason as
  `layout skipped: <reason>`; a skipped border clear is remembered and retried
  on the next pane lifecycle event (split or close), never per tick.
  `applyBorderStyles` is deliberately not foreign-guarded (last writer wins,
  self-corrects).
- `tmux display-message -p '#{session_id}'` is **not** a safe identity probe:
  without `TMUX_PANE` it returns whatever session tmux considers current, which
  may be the host session. Never use it to pick a kill target.

## Testing

```sh
npm test        # vitest — full suite must stay green (207 tests baseline)
npm run check   # tsc --noEmit
npm run build   # tsc -p tsconfig.build.json
```

- **`scripts/e2e-smoke.ts` is environment-blocked** (needs a staging env). It
  must stay byte-exact — do not modify it as a workaround.
- The live-verification pattern is a scratch harness driving compiled `dist/`
  modules against an isolated tmux server (`TMUX_TMPDIR`) and an isolated
  opencode daemon. Keep the real daemon out of tests at all costs.
- Watch-path tests must force an unstyled theme (`{"theme":"system"}` in the
  scratch `XDG_CONFIG_HOME`): `themeStyles` is not injectable through `CliDeps`,
  and a resolved theme makes the watcher write window options to the real tmux
  (`TMUX` is inherited from the user's shell).

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
- **`TMUX_TMPDIR` is ignored while `$TMUX` is set** (a shell inside a mux
  session inherits it), so a scratch tmux server needs BOTH
  `unset TMUX TMUX_PANE` and a private `TMUX_TMPDIR`; a nonexistent or
  unsuitable `TMUX_TMPDIR` silently falls back to `/tmp/tmux-<uid>`. Never run
  `tmux kill-server` in a probe — it destroys the user's live server; kill only
  through an explicit `-S <socket>` you created yourself.
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

- **Test gate**: no changes are committed or pushed unless `npm test` and
  `npm run check` pass cleanly. Failing tests block commits.
- Additive forward-compat: unknown config keys are ignored; unknown
  non-`--mux-` args pass through to opencode; unknown `--mux-*` flags are an
  error.
- **Client dependency lines**: `@opencode/client` tracks the newest 2.x
  (2.1.3, matching the current daemon), `@opencode/client-legacy` stays pinned
  to `npm:@opencode/client@2.0.5` for the legacy generation. Their *optional*
  `effect` peer disagrees (4.0.1 vs 4.0.0-rc.112), so `package.json` `overrides`
  pins `effect` to 4.0.1 under the legacy package: both promise clients are
  Effect-free at runtime and the override only satisfies npm's resolver —
  keep it if you bump either line, otherwise `npm install` fails with
  ERESOLVE.
- Theme table regen: `node scripts/generate-theme-table.mjs` (fetches the
  pinned `anomalyco/opencode` v2.0.5 tag) or `--from <dir>` for local assets.
  Idempotent — output must be byte-identical on re-run.
- Keep tests representative of the pane command shape when touching pane argv:
  mini is `["env", "BUN_CONFIG_HTTP_IDLE_TIMEOUT=0", "opencode", "mini", "-s", id]`,
  tui is `["opencode", "-s", id]` (there is no `tui` subcommand).
- Error messages are prefixed `opencode-mux:` and reference stderr.
- **Version variables**: on version bump, update both `src/version.ts` (`VERSION` constant) and the README version mention — these must always match `package.json` `version`. Forgetting either causes stale version reporting.
- **Release flow**: `npm version <x.y.z>` (identity-env vars set) creates the
  version commit + `v*` tag; push `main` and the tag — the tag push triggers
  `.github/workflows/publish.yml`, which publishes to npm via **trusted
  publishing** (OIDC, no tokens; provenance attached automatically). The npmjs.com
  trusted publisher must reference exactly this workflow filename (`publish.yml`).
  Publish is not done manually.