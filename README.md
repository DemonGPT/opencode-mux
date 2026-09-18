# opencode-mux

[![npm version](https://img.shields.io/npm/v/opencode-mux.svg)](https://www.npmjs.com/package/opencode-mux)
[![CI](https://github.com/DemonGPT/opencode-mux/actions/workflows/ci.yml/badge.svg)](https://github.com/DemonGPT/opencode-mux/actions/workflows/ci.yml)

A drop-in wrapper for [opencode](https://opencode.ai) that opens tmux panes for
subagent sessions automatically — and makes the whole layout look coherent no
matter what your tmux is configured to look like.

When a session running inside opencode-mux spawns a subagent, a new tmux pane
opens showing that session live. When the subagent finishes, the pane closes
itself. The subagent panes use opencode's `mini` frontend by default (configurable via `--pane-command` or `pane_command` in the config file) — no tab bar, no agent switcher.

```
┌──────────────────────────────────────────┬──────────────┐
│                                          │ subagent     │
│   main opencode session                  │ (mini UI)    │
│   (full TUI)                             ├──────────────┤
│                                          │ subagent     │
│                                          │ (mini UI)    │
└──────────────────────────────────────────┴──────────────┘
```

- **Drop-in** — run it exactly like `opencode`; every other argument is passed
  through unchanged.
- **Zero config intrusion** — never writes tmux `-g` options and never touches
  your `~/.tmux.conf`, `~/.config/opencode/cli.json`, or `tui.json`.
- **Coherent look** — pane borders are styled to match your active opencode
  theme, and the session opts are scoped to the mux session only.

## Requirements

| Tool | Version |
| ---- | ------- |
| Node.js | >= 20 |
| tmux | 3.x (tested on 3.7) |
| opencode | v2 (2.0.0–2.0.5 and 2.0.6+ both supported) |

## Install

```sh
npm install -g opencode-mux
```

To use it as your default `opencode`:

```sh
alias opencode="opencode-mux"
```

(binaries are `opencode-mux`, version `0.1.0`)

## Usage

```sh
opencode-mux [mux options] [opencode arguments...]
```

### Examples

```sh
# Just work in the current directory
opencode-mux

# Continue an existing session
opencode-mux -s ses_abc123

# Pass opencode's own flags through, with a tiled pane layout
opencode-mux --layout tiled --model fast

# Running inside an existing tmux session also works — subagent panes are
# opened in the session you're already in, and already-running subagents are
# adopted without a startup flash.
```

### Mux options

| Option | Description | Default |
| ------ | ----------- | ------- |
| `--config <path>` | Config file to use | `~/.config/opencode-mux.conf` |
| `--layout <name>` | Pane layout: `main-vertical`, `main-horizontal`, `tiled`, `even-horizontal`, `even-vertical` | `main-vertical` |
| `--main-pane-size <pct>` | Main pane size for `main-*` layouts, percent of the window | `60` |
| `--close <mode>` | Pane lifecycle: `auto` (close when the subagent finishes) or `keep` | `auto` |
| `--pane-command <cmd>` | Subagent pane frontend: `mini` (minimal UI) or `tui` (full TUI) | `mini` |
| `--grace <seconds>` | Delay before a finished subagent's pane closes | `1` |
| `--parent <id>` | Only spawn panes for children of this session | inferred from `-s`/`--session` |
| `--session-name <name>` | Owned tmux session name (when starting outside tmux) | `mux` |
| `-h`, `--help` | Show help | |
| `--version` | Print the version | |

Everything else (e.g. `--model`, `--agent`, `-i` prompts, a directory) is passed
through to opencode unchanged.

## Config file

`~/.config/opencode-mux.conf` (honors `XDG_CONFIG_HOME`) is optional and is
auto-created with defaults on first run. Keys are `key=value`, lines starting
with `#` are comments, and unknown keys are ignored for forward compatibility.

```ini
# opencode-mux configuration
session_name=mux
layout=main-vertical
main_pane_size=60
close_panes=auto
pane_command=mini
grace=1
parent=
```

Precedence: **CLI flags > config file > defaults**.

## How it works

- **Outside tmux**: opencode-mux creates a detached tmux session named
  `mux` (or `--session-name`), applies session-scoped `status off` and
  `mouse on`, re-executes itself inside, and attaches. When the main TUI
  exits, the owned session is cleaned up.
- **Inside tmux**: the wrapper runs as a watcher. It connects to the opencode
  server (same background service you're already using), listens for
  subagent-session events, opens a pane per child session via
  `opencode mini -s <id>`, styles the pane borders to match the active
  opencode theme, and closes panes once their session finishes (after the
  grace period).

## Features

### Subagent panes without the chrome

Subagent panes attach with `opencode mini`, the minimal frontend: no top tab
strip, no agent switcher or model panel — just the conversation and a one-line
footer. It streams live updates while the subagent works, accepts input, and
stays attached until the watcher closes the pane.

### Theme-matched borders

Pane borders follow your active opencode theme (`border.default`, falling back
to the border color). Paraphrased, it looks good no matter what anyone has
configured their setup to look like:

- Theme is resolved from your opencode config: project
  `.opencode/cli.json` → project `.opencode/tui.json` → global `cli.json` →
  global `tui.json` (first match wins; v2 object and legacy string forms both
  supported).
- Built-in themes come from a vendored table of all opencode v2.0.5 built-in
  themes; custom theme files are resolved from your config/theme dirs.
- A `system` theme or an unknown/unresolvable theme results in **no border
  styling** — never wrong colors.
- Config changes are re-applied live (checked on the watcher tick), and
  borders are cleared when the theme becomes unresolvable. Zero tmux calls
  while nothing changed.

### Never touches your setup

All tmux writes are runtime-scoped: window options are applied with `-w`
(pane-border colors) and session options with `-t <session>` (status/mouse).
No `-g`, no writes to `~/.tmux.conf`, no changes to your opencode configs.

## Requirements & compatibility

- Handles opencode's two v2 server generations transparently: 2.0.0–2.0.5
  (`/api/status`) and 2.0.6+ (`/api/info`).
- Depends on tmux; fails with a clear error if tmux or opencode v2 is missing.

## Development

```sh
npm install
npm run check   # typecheck (tsc --noEmit)
npm test        # vitest suite
npm run build   # tsc -p tsconfig.build.json → dist/
npm run smoke   # e2e smoke (needs a staging environment; blocked locally)
```

## License

MIT