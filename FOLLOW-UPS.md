# Follow-ups

## Command palette (⌘K)

- Search inside notes, not just titles. The title index holds no note text, so either store the text in it, or match titles at once and fill in text matches in the background. Reading a note stored only in iCloud takes about 2 s.
- Duplicate a note; export a note to a file.
- Shortcuts for pin, copy and move to Trash.
- Recent notes reset on relaunch; they last for the session only.
- The ⌘P list now overlaps with the palette, which has "Connect to Claude" too. Fold ⌘P in.
- With nothing typed, the palette lists up to 24 rows. Group them under headings, or show formatting commands only once you type.

## Editor

- Emptying a note is never saved: `saveCurrent` skips empty content, so after select-all + delete (or "Clear checked tasks" on a note that is only checked tasks) the old text comes back on reopen. The check guards against wiping a note during load, so loosen it with care.
- Links in headings are lost on save: headings are saved as plain text.
- Links can't be opened from the editor (`openOnClick` is off). Add ⌘-click.

## Found along the way

- `create_note` names files by the second (`note-<seconds>.md`), so two notes created in the same second overwrite each other.
- Every keystroke saves the note and rewrites the title index; nothing debounces it.
- The MCP server deletes notes for good, while the app moves them to the Trash.
- The MCP server's list and search tools read every note in full, so they are slow when notes are stored only in iCloud.
- In `lib.rs` and the MCP server, a frontmatter line other than `pinned:` (for example `tags: x`) becomes the note's title.
- The note opened at boot can itself be stored only in iCloud, which adds about 2 s.
