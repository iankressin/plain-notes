# Follow-ups

## Command palette (⌘K)

- Task commands: clear checked tasks, move checked tasks to the bottom, uncheck all.
- Formatting commands: heading 1–3, bullet, numbered or task list, insert link.
- App commands: open the notes folder in Finder, reveal this note, Connect to Claude, quit.
- Search inside notes, not just titles. The title index holds no note text, so either store the text in it, or match titles at once and fill in text matches in the background. Reading a note stored only in iCloud takes about 2 s.
- Duplicate a note; export a note to a file.
- Shortcuts for pin, copy and move to Trash. Only "New note" has one (⌘N).
- Recent notes reset on relaunch; they last for the session only.
- The ⌘P list now overlaps with the palette. Fold it in once "Connect to Claude" has a palette command.

## Found along the way

- `create_note` names files by the second (`note-<seconds>.md`), so two notes created in the same second overwrite each other.
- Every keystroke saves the note and rewrites the title index; nothing debounces it.
- The MCP server deletes notes for good, while the app moves them to the Trash.
- The MCP server's list and search tools read every note in full, so they are slow when notes are stored only in iCloud.
- In `lib.rs` and the MCP server, a frontmatter line other than `pinned:` (for example `tags: x`) becomes the note's title.
- The note opened at boot can itself be stored only in iCloud, which adds about 2 s.
