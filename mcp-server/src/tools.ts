import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as store from "./notes-store";

/**
 * Register the six note tools. SDK 1.x contract: `inputSchema` is a ZodRawShape
 * (a plain field map, NOT z.object(...)); the handler receives the already-parsed
 * args object.
 *
 * Every tool also declares MCP `annotations` (readOnlyHint / destructiveHint /
 * idempotentHint). These are the machine-readable signal clients use to decide
 * how to gate a call: without them a client must treat each tool as potentially
 * unsafe and demand interactive approval — which stalls forever for destructive
 * ops in non-interactive/bridged sessions. `openWorldHint: false` everywhere
 * because all tools operate solely on the local notes directory.
 */
export function registerTools(server: McpServer, notesDir: string): void {
  server.registerTool(
    "list_notes",
    {
      title: "List notes",
      description:
        "List all notes (id, title, last-modified unix seconds, pinned), sorted pinned-first then newest-first.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const notes = await store.listNotes(notesDir);
      const text = notes.length
        ? notes.map((n) => `- ${n.id} — ${n.title}${n.pinned ? " 📌" : ""}`).join("\n")
        : "No notes yet.";
      return { content: [{ type: "text", text }], structuredContent: { notes } };
    },
  );

  server.registerTool(
    "read_note",
    {
      title: "Read note",
      description: "Read the full markdown content of a note by its id (filename without .md).",
      inputSchema: { id: z.string().describe("Note id, e.g. note-1718700000") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      try {
        const note = await store.readNote(notesDir, id);
        return { content: [{ type: "text", text: note.content }], structuredContent: note };
      } catch {
        return { content: [{ type: "text", text: `Note not found: ${id}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "create_note",
    {
      title: "Create note",
      description:
        "Create a new note. With no title/content, creates an empty '# New Note'. The title becomes the first heading line. Returns the new note id.",
      inputSchema: {
        title: z.string().optional().describe("Optional title; becomes the first '# ' heading."),
        content: z.string().optional().describe("Optional markdown body."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false, // only ever adds a new file; never overwrites
        idempotentHint: false, // each call creates a distinct note
        openWorldHint: false,
      },
    },
    async ({ title, content }) => {
      try {
        const note = await store.createNote(notesDir, { title, content });
        return {
          content: [{ type: "text", text: `Created note ${note.id} — ${note.title}` }],
          structuredContent: note,
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Failed to create note: ${(e as Error)?.message ?? e}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "edit_note",
    {
      title: "Edit note",
      description:
        "Edit an existing note. mode='replace' overwrites the whole file; mode='append' adds to the end; mode='str_replace' replaces an exact, unique substring (fails if 'find' matches zero or multiple times).",
      inputSchema: {
        id: z.string().describe("Note id (filename without .md)."),
        mode: z.enum(["replace", "append", "str_replace"]),
        content: z.string().optional().describe("New content for mode 'replace' or 'append'."),
        find: z.string().min(1).optional().describe("Exact substring to find (mode 'str_replace')."),
        replace_with: z.string().optional().describe("Replacement text (mode 'str_replace')."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true, // 'replace' overwrites existing content
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const res = await store.editNote(notesDir, args);
        return {
          content: [{ type: "text", text: `Edited note ${res.id} (${res.bytesWritten} bytes) — ${res.title}` }],
          structuredContent: res,
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Failed to edit note: ${(e as Error)?.message ?? e}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "delete_note",
    {
      title: "Delete note",
      description:
        "Permanently delete a note by its id. This cannot be undone (the file is removed from disk).",
      inputSchema: { id: z.string().describe("Note id (filename without .md).") },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true, // removes the file from disk
        idempotentHint: true, // deleting an already-deleted id leaves the same end state
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      try {
        const res = await store.deleteNote(notesDir, id);
        return { content: [{ type: "text", text: `Deleted note ${res.id}` }], structuredContent: res };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Failed to delete note: ${(e as Error)?.message ?? e}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search notes",
      description:
        "Search notes by title and body (case-insensitive substring). Returns matching note ids with snippets.",
      inputSchema: {
        query: z.string().min(1).describe("Search text."),
        limit: z.number().int().min(1).max(50).default(20).describe("Max results (1-50)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      const results = await store.searchNotes(notesDir, query, limit ?? 20);
      const text = results.length
        ? results.map((r) => `- ${r.id} — ${r.title}\n  ${r.snippet}`).join("\n")
        : `No matches for "${query}".`;
      return { content: [{ type: "text", text }], structuredContent: { results } };
    },
  );
}
