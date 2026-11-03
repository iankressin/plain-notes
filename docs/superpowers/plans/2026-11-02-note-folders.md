# Note Folders Implementation Plan

**Goal:** Create nested folders and organize notes in the app and MCP integration.

**Architecture:** Filesystem directories are the source of truth. A focused Rust
storage module owns traversal and folder operations. The existing note index and
watcher cover all descendants. Svelte uses relative folder IDs for browsing and moves.

**Tech Stack:** Existing Rust/Tauri, Svelte 5, TypeScript, and Bun. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-02-note-folders-design.md`

## Global Constraints

- Preserve existing note content, pins, and root note IDs.
- Keep the current appearance and keyboard access.
- Moves never overwrite another note.
- Keep filesystem operations within the notes directory.
- Folder renaming, folder deletion, and drag-and-drop are outside this change.

## Review Focus

- Same filename in separate folders must retain distinct identity.
- Saving immediately before moving must not recreate the old note.
- Folder changes outside the app must refresh the browser.
- Failed moves must leave the note editable at its original location.
- Narrow windows, long folder names, and keyboard dialogs must stay usable.

### Task 1: Folder storage and native commands

**Files:** `src-tauri/src/note_files.rs`, `src-tauri/src/lib.rs`.
**Interfaces:** `FolderInfo { path, name }`, `NoteInfo.folder`; commands
`list_folders()`, `create_folder(parent, name)`, `move_note(path, folder)`;
optional `folder` on `create_note`.

- [x] Add failing tests for nested note validation and discovery.
- [x] Implement recursive discovery, folder validation/creation, exclusive note creation,
  and collision-safe moves in the storage module. Test contents, duplicate names,
  invalid destinations, and symbolic links using temporary directories.
- [x] Integrate commands, recursive indexing, and directory-change notifications.
- [x] Run `cargo test --manifest-path src-tauri/Cargo.toml` (14 tests passed).

### Task 2: MCP folder compatibility

**Files:** `mcp-server/src/notes-dir.ts`, `notes-store.ts`, `tools.ts`, `test/smoke.mjs`.
**Interfaces:** Folder paths and note IDs use `/` separators relative to the root;
the note ID excludes `.md`. Tools mirror native folder commands.

- [x] Extend the real MCP smoke test for nested create/read/edit/search/move/delete,
  folder listing, duplicate filenames, collisions, and invalid destinations. Observe failures.
- [x] Implement recursive discovery, validated relative IDs, and the three folder tools.
- [x] Run `bun run smoke` and `bun run typecheck` in `mcp-server`.

### Task 3: Folder browser and note moves

**Files:** `src/lib/NoteBrowser.svelte`, `src/lib/FolderDialog.svelte`,
`src/routes/+page.svelte`, `src/lib/CommandPalette.svelte`.
**Interfaces:** Consume Task 1 commands; show folder paths in global search.

- [x] Implement breadcrumbs, folder rows, new-folder entry, new-note action, and move dialog.
- [x] Serialize pending saves before moves and update current/recent paths after success.
- [x] Add palette commands and global title/folder search.
- [x] Run `pnpm check` and `pnpm build`; exercise narrow layouts and both themes.
- [x] Verify folder creation/navigation, nested notes, moves, errors, and Escape behavior.

### Task 4: Review and delivery

- [x] Review the full change with a fresh reviewer; address material findings.
- [x] Run final Rust, MCP, Svelte, and build checks.
- [x] Update usage documentation and record UI verification evidence.

## Verification

- Rust: 14 tests passed; formatting check passed.
- MCP: integration smoke test and TypeScript check passed.
- UI: 24 browser tests passed across light and dark themes at 340px width.
- Svelte: zero errors and zero warnings.
- Production frontend build: passed, with a bundle-size advisory.
- Whitespace check: passed.

Browser tests use real temporary files through the TypeScript store, with desktop
IPC simulated. Native filesystem operations are covered by Rust tests.

### UI action evidence

| Control or state | Verified result |
| --- | --- |
| Browse notes / Back to note | Opens the folder browser and returns to the editor. |
| Folder rows and breadcrumbs | Enters nested folders and returns to the root. |
| New folder / Create folder | Creates the folder at the current location; duplicate names show an error. |
| New note | Creates a file in the selected folder and opens it. |
| Move note / destination selector | Moves into a folder and back to the root; subsequent edits use the new path. |
| Cancel / Escape | Closes the dialog, restores focus, and keeps the app running. |
| Global search | Finds nested notes by title or folder name and opens the selected result. |
| Retry | Recovers from a listing error without losing the open note. |
| Empty folder | Shows the empty state and working creation controls. |
| Failed save or move | Shows an error and preserves the source note. |
| External move | Leaves the old view read-only; the note can be reopened at its new location. |
| Long folder names | Remain contained in the browser and dialog at 340px width. |
