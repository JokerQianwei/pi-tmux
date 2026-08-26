# Agent Instructions

## Commands

| Task | Command |
|---|---|
| Test | `npm test` |
| Check CLI syntax | `node --check bin/pi-tmux` |
| Check extension loading | `pi -e ./extensions/pi-tmux/index.ts --list-models` |
| Inspect package contents | `npm pack --dry-run` |

## Conventions

- Keep the package limited to Pi and tmux.
- Do not add runtime dependencies when Node and tmux already provide the primitive.
- Use Pi lifecycle events for state; never infer completion from pane text.
- Keep tmux targets explicit and preserve the no-focus background workflow.
- Update `pi-tmux --skill` and `README.md` when the command contract changes.
- Add Chinese comments only for non-obvious ownership, ordering, or safety rules.
