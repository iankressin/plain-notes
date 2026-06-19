# plain-notes-mcp

A local [MCP](https://modelcontextprotocol.io) server, shipped inside the Plain Notes
app bundle, that lets LLM clients (Claude Desktop, Claude Code, Cursor) **create, read,
edit, and search** your markdown notes. It speaks **stdio** and is launched on demand by
the client, so it runs as its own process independent of the Plain Notes window.

It operates directly on the notes directory (default `~/Documents/PlainNotes`), mirroring
the app's conventions (filename `note-{epoch}.md`, title = first `#` line, `pinned:`
frontmatter), so notes created by the LLM and by the app are mutually readable.

## Tools

| Tool | Purpose |
|------|---------|
| `list_notes` | List notes (id, title, mtime, pinned), pinned-first then newest. |
| `read_note` | Read a note's markdown by id. |
| `create_note` | Create a note (optional title/content). Collision-safe filenames. |
| `edit_note` | `replace` / `append` / `str_replace` (unique-match) an existing note. |
| `delete_note` | Permanently delete a note by id (removes the file from disk). |
| `search_notes` | Case-insensitive title + body search with snippets. |

All access is confined to the notes directory: clients pass a note **id** (never a path),
and traversal attempts (`..`, absolute paths) are rejected. `delete_note` is permanent —
MCP clients gate each tool call behind user approval, so the deletion is human-confirmed.

## Develop & test

```sh
bun install
bun run dev          # run the server on stdio (logs to stderr)
bun run smoke        # full integration test over a real stdio MCP client
bun run typecheck    # tsc --noEmit
```

Inspect interactively with the MCP Inspector:

```sh
PLAIN_NOTES_DIR=/tmp/pn-test bunx @modelcontextprotocol/inspector bun run src/index.ts
```

## Build the shipped binary

Compiled to a self-contained executable (no system Node/Bun needed at runtime) and placed
where Tauri's `bundle.externalBin` expects it (`src-tauri/bin/`, target-triple suffixed):

```sh
bun run compile          # builds both macOS arches
# or per-arch:
bun run compile:arm64
bun run compile:x64
```

`pnpm tauri build` then bundles the matching binary into
`Plain Notes.app/Contents/MacOS/plain-notes-mcp`.

> **macOS signing:** the sidecar must be signed with the same Developer ID + hardened
> runtime as the app or notarization fails (Tauri issue #11992). If `tauri build` doesn't
> sign it automatically:
> ```sh
> codesign --force --options runtime --sign "Developer ID Application: …" \
>   "…/Plain Notes.app/Contents/MacOS/plain-notes-mcp"
> ```

## Register with an LLM client

**Easiest (Claude Desktop):** in Plain Notes, open the browse view (`Cmd/Ctrl+P`) and
click **Connect to Claude**. This merges the server into
`claude_desktop_config.json` (preserving any other servers, backing the file up first),
pointing at the bundled binary with the resolved `--notes-dir`. Then fully quit and reopen
Claude Desktop.

To register manually, or for other clients, point the client at the bundled binary.
`--notes-dir` is optional (defaults to `~/Documents/PlainNotes`); pass it to be explicit.

**Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json`
(then fully quit + reopen Claude):

```json
{
  "mcpServers": {
    "plain-notes": {
      "command": "/Applications/Plain Notes.app/Contents/MacOS/plain-notes-mcp",
      "args": ["--notes-dir", "~/Documents/PlainNotes"]
    }
  }
}
```

**Claude Code**:

```sh
claude mcp add plain-notes -s user -- "/Applications/Plain Notes.app/Contents/MacOS/plain-notes-mcp"
```

**Cursor** — `~/.cursor/mcp.json`, same `command`/`args` shape (supports `${userHome}`).

During development (before bundling), point `command` at the compiled binary in
`src-tauri/bin/plain-notes-mcp-aarch64-apple-darwin`, or at `bun` with
`args: ["run", "<abs path>/mcp-server/src/index.ts"]`.

## Keep in sync

The default notes-dir resolution mirrors `get_notes_dir()` in `../src-tauri/src/lib.rs`.
If that path ever changes (or becomes user-configurable), update `src/notes-dir.ts` to
match, or always pass `--notes-dir` at registration.
