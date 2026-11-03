# Note folders

Group notes by domain in real, nested directories beneath the notes folder.

## Approach

Use filesystem directories, consistent with the app's plain Markdown storage.
Virtual folders would need separate metadata and would not carry into other editors.
Single-level folders would prevent grouping projects within a domain.

## Behavior

- Browse immediate child folders and notes, with breadcrumbs back to the root.
- Create a folder in the current location. New notes go into that location.
- Move the open note to an existing folder, including the root.
- Keep command-palette search global and show folder locations beside note titles.
- Discover existing nested Markdown files and reflect external file changes.
- MCP tools list, read, edit, search, and delete nested notes; provide folder creation,
  folder listing, and note moves. Existing root note IDs remain unchanged.
- Preserve contents and pins when moving. Refuse collisions and invalid locations.
- Folder renaming, folder deletion, and drag-and-drop are outside this change.

## UI direction

Keep the compact, keyboard-oriented note window, system typography, and existing
system light/dark themes.
Use a single-column folder browser because the window is narrow. Breadcrumbs explain
location; folder icons distinguish folders from notes. Use existing theme colors,
visible focus outlines, labeled controls, and explicit loading, empty, and error states.

## Verification

Exercise nested discovery, identical filenames in different folders, file content
preservation, collision rejection, invalid destinations, and external changes.
Run Rust tests, MCP integration tests, Svelte checks, and the frontend build.
Exercise the browser and move flow with a temporary note collection.
