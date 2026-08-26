# pi-tmux

Run visible, named [Pi](https://github.com/earendil-works/pi) subagents in tmux and control them from a parent Pi session.

`pi-tmux` keeps the interface explicit:

```text
start → prompt → get/read → wait → stop/resume
```

It supports Pi and tmux only. There are no runtime npm dependencies, background daemons, worktrees, or screen-scraping completion heuristics.

## Requirements

- Pi 0.84 or newer
- Node.js 22 or newer
- tmux
- A persistent parent Pi session running inside tmux

## Install

```sh
pi install npm:@jokerqianwei/pi-tmux@0.1.0
```

The extension adds the package's `bin/` directory to commands started by Pi and gives the parent Agent a hidden discovery hint. No separate skill installation is needed.

`pi install` does not add the CLI to your login shell. The parent Agent invokes it through Pi's `bash` tool. To use `pi-tmux` directly from an ordinary shell, also install the same package globally:

```sh
npm install -g @jokerqianwei/pi-tmux@0.1.0
```

To inspect the complete Agent workflow:

```sh
pi-tmux --skill
```

## Usage

Start a child and wait for its first result:

```sh
pi-tmux start reviewer \
  --title "Review current diff" \
  --task "Review the current diff and report actionable findings only." \
  --cwd "$PWD" \
  --wait
```

Start independent work before waiting:

```sh
pi-tmux start implementation-reviewer \
  --title "Implementation review" \
  --task "Review implementation correctness." \
  --cwd "$PWD"

pi-tmux start test-reviewer \
  --title "Test review" \
  --task "Review test coverage." \
  --cwd "$PWD"

pi-tmux wait implementation-reviewer
pi-tmux wait test-reviewer
```

Continue a settled child:

```sh
pi-tmux prompt reviewer "Now inspect error handling." --wait
```

Inspect or control the terminal:

```sh
pi-tmux get reviewer
pi-tmux read reviewer --lines 120
pi-tmux send-keys reviewer esc
```

Stop and restore the same Pi session:

```sh
pi-tmux stop reviewer
pi-tmux resume reviewer --prompt "Continue the review." --wait
```

## Commands

| Command | Purpose |
|---|---|
| `start` | Create a detached tmux window and start a named child Pi |
| `prompt` | Send text to an idle or settled child |
| `get` / `list` | Read structured lifecycle state |
| `read` | Capture recent terminal output |
| `wait` | Wait for a settled result without killing on timeout |
| `resume` | Restore the same child Pi session in a new window |
| `send-keys` | Send validated logical keys such as `esc` or `ctrl+c` |
| `stop` | Close the pane while preserving the Pi session |

Run `pi-tmux --help` for arguments and model overrides.

## Model selection

New children inherit the parent Pi provider, model, and thinking level. Override them explicitly when needed:

```sh
pi-tmux start reviewer \
  --title "Review" \
  --task "Review the current diff." \
  --provider openai-codex \
  --model gpt-5.6-sol \
  --thinking high
```

`resume` keeps the model stored in the child session unless an override is passed.

## Status and results

The child extension publishes Pi lifecycle events instead of inferring state from terminal text:

```text
idle · working · blocked · done · exited
```

Window names show the current state:

```text
·reviewer  ▶reviewer  ?reviewer  ✓reviewer
```

`read` is for terminal inspection. `wait` returns the final assistant message from the Pi session branch.

Runtime state is private to the current user:

```text
~/.pi/agent/runtime/pi-tmux/<parent-session-id>/<name>/
```

## Safety

- Child processes have the same operating-system permissions as the current user.
- Names and tmux targets are validated and scoped to the parent Pi session.
- Normal prompts are accepted only while a child is idle or done.
- Logical keys are allowlisted. Inspect a blocked pane before sending keys.
- `stop` preserves session history; it does not delete the child session.
- The package does not isolate Git writes. Run concurrent writers only when their file scopes cannot overlap.

## Development

```sh
npm test
node --check bin/pi-tmux
pi -e ./extensions/pi-tmux/index.ts --list-models
```

Architecture and implementation decisions are documented in [`docs/design.md`](docs/design.md).

## License

MIT
