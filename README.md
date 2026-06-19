# Plain Notes

A lightweight, floating Raycast Notes recreation backed by **plain .md files**.

- Toggle with **Option + N** (global hotkey)
- One note visible at a time (stack)
- Real `.md` files in `~/Documents/PlainNotes` (or your chosen folder)
- Fast keyboard-first flow

## Run

```bash
cd ~/Projects/plain-notes
pnpm tauri dev
```

The app creates the notes folder on first launch and works with any plain-text Markdown tools.

## Install (no dev server)

Build and install `Plain Notes.app` to `/Applications`, and register the bundled
MCP server with Claude Desktop + Claude Code:

```bash
./scripts/install.sh
```

Re-run it any time to ship a new build of **both** the UI and the MCP sidecar:

```bash
./scripts/reinstall.sh          # rebuild from the local checkout, then reinstall
./scripts/reinstall.sh --pull   # git pull --ff-only first, then rebuild
```

`reinstall.sh` is just the idempotent installer — the MCP server is registered at
a stable path (`/Applications/Plain Notes.app/...`), so reinstalling rebuilds,
replaces, and restarts the clients without re-registration drift.

Flags: `--pull`, `--notes-dir DIR` (default `~/Documents/PlainNotes`),
`--no-register`, `--no-restart`, `--skip-build`.

## Current Status (early slices)

- Floating always-on-top window (decorations removed, narrow default)
- Global shortcut toggle (Option+N / Alt+N)
- List + create + read/write notes (Rust commands)
- Title derived from first line of the .md
- Very basic browser toggle

Full feature parity (Tiptap rich editor, pins, export, auto-resize, ⌘K, history nav, etc.) is being built slice by slice.

See the plan in the session for details.

## Tech

Tauri 2 + Svelte 5 + Tailwind + (soon) Tiptap. All user data is plain files.

## Recommended IDE Setup

[VS Code](https://code.visualstudio.com/) + [Svelte](https://marketplace.visualstudio.com/items?itemName=svelte.svelte-vscode) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer).
