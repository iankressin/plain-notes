import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, noteIdToPath } from "./notes-dir";

// `type` (not `interface`) so these are assignable to the SDK's
// structuredContent type, which requires an index signature.
export type NoteMeta = {
  id: string;
  title: string;
  mtime: number; // unix seconds, matches the Rust backend
  pinned: boolean;
};

export type NoteFull = NoteMeta & {
  content: string;
};

export type SearchResult = {
  id: string;
  title: string;
  snippet: string;
  matchCount: number;
};

export type EditMode = "replace" | "append" | "str_replace";

function stripMdExt(name: string): string {
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

/**
 * Title + pinned extraction. Mirrors `extract_title_and_pinned` in
 * ../../src-tauri/src/lib.rs so notes display identically in the app.
 */
export function parseTitleAndPinned(content: string): { title: string; pinned: boolean } {
  let pinned = false;
  const lines = content.split(/\r?\n/);

  // Light frontmatter: only when line 1 is `---`, scan up to 6 following lines.
  if (lines.length > 0 && lines[0].trim() === "---") {
    for (let i = 1; i < lines.length && i <= 6; i++) {
      const raw = lines[i];
      const t = raw.trim();
      if (t.startsWith("pinned:") && raw.includes("true")) pinned = true;
      if (t === "---") break;
    }
  }

  // Title = first non-empty, non-frontmatter line, leading `#` stripped.
  for (const line of lines) {
    const t = line.trim();
    if (t === "" || t === "---" || t.startsWith("pinned:")) continue;
    const title = t.replace(/^#+/, "").trim();
    if (title) return { title, pinned };
  }
  return { title: "Untitled Note", pinned };
}

export async function listNotes(notesDir: string): Promise<NoteMeta[]> {
  ensureDir(notesDir);
  let entries: string[];
  try {
    entries = await fs.readdir(notesDir);
  } catch {
    return [];
  }

  const notes: NoteMeta[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const full = path.join(notesDir, name);
    try {
      const stat = await fs.stat(full);
      if (!stat.isFile()) continue;
      const content = await fs.readFile(full, "utf8");
      const { title, pinned } = parseTitleAndPinned(content);
      notes.push({
        id: stripMdExt(name),
        title,
        mtime: Math.floor(stat.mtimeMs / 1000),
        pinned,
      });
    } catch {
      // skip unreadable entries
    }
  }

  // Sort: pinned first, then newest mtime first (matches lib.rs comparator).
  notes.sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return b.mtime - a.mtime;
  });
  return notes;
}

export async function readNote(notesDir: string, id: string): Promise<NoteFull> {
  const file = noteIdToPath(notesDir, id);
  const content = await fs.readFile(file, "utf8"); // throws ENOENT if missing
  const stat = await fs.stat(file);
  const { title, pinned } = parseTitleAndPinned(content);
  return { id: stripMdExt(id), title, pinned, mtime: Math.floor(stat.mtimeMs / 1000), content };
}

export async function createNote(
  notesDir: string,
  opts: { title?: string; content?: string },
): Promise<NoteMeta> {
  ensureDir(notesDir);
  const epoch = Math.floor(Date.now() / 1000);

  let body: string;
  if (opts.title) {
    body = `# ${opts.title}\n\n${opts.content ?? ""}`;
  } else if (opts.content) {
    body = opts.content;
  } else {
    body = "# New Note\n\n"; // exact template used by the Rust create_note
  }

  // Collision-safe: exclusive create, suffixing -1/-2/... on EEXIST. (Fixes a
  // same-second overwrite race present in the Rust create_note.)
  let id = `note-${epoch}`;
  let suffix = 0;
  for (;;) {
    const file = path.join(notesDir, `${id}.md`);
    try {
      await fs.writeFile(file, body, { flag: "wx" });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "EEXIST") {
        suffix += 1;
        id = `note-${epoch}-${suffix}`;
        continue;
      }
      throw e;
    }
  }

  const { title, pinned } = parseTitleAndPinned(body);
  return { id, title, pinned, mtime: epoch };
}

export async function editNote(
  notesDir: string,
  args: { id: string; mode: EditMode; content?: string; find?: string; replace_with?: string },
): Promise<{ id: string; title: string; bytesWritten: number }> {
  const file = noteIdToPath(notesDir, args.id);

  let existing: string;
  try {
    existing = await fs.readFile(file, "utf8");
  } catch {
    throw new Error(`Note not found: ${args.id}`);
  }

  let next: string;
  if (args.mode === "replace") {
    if (args.content == null) throw new Error("mode 'replace' requires 'content'");
    next = args.content;
  } else if (args.mode === "append") {
    if (args.content == null) throw new Error("mode 'append' requires 'content'");
    const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    next = existing + sep + args.content;
  } else {
    // str_replace: require an exact, unique match to avoid ambiguous edits.
    if (args.find == null || args.replace_with == null) {
      throw new Error("mode 'str_replace' requires 'find' and 'replace_with'");
    }
    const count = existing.split(args.find).length - 1;
    if (count === 0) throw new Error(`'find' text not found in note ${args.id}`);
    if (count > 1) {
      throw new Error(
        `'find' text is ambiguous (${count} matches) in note ${args.id}; provide a longer unique string`,
      );
    }
    next = existing.replace(args.find, args.replace_with);
  }

  await fs.writeFile(file, next, "utf8");
  const { title } = parseTitleAndPinned(next);
  return { id: stripMdExt(args.id), title, bytesWritten: Buffer.byteLength(next, "utf8") };
}

export async function deleteNote(notesDir: string, id: string): Promise<{ id: string }> {
  const file = noteIdToPath(notesDir, id);
  try {
    await fs.unlink(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new Error(`Note not found: ${id}`);
    }
    throw e;
  }
  return { id: stripMdExt(id) };
}

export async function searchNotes(
  notesDir: string,
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  const metas = await listNotes(notesDir);
  const q = query.toLowerCase();
  const results: SearchResult[] = [];

  for (const m of metas) {
    let content: string;
    try {
      content = await fs.readFile(noteIdToPath(notesDir, m.id), "utf8");
    } catch {
      continue;
    }
    const hay = content.toLowerCase();
    const titleHits = m.title.toLowerCase().split(q).length - 1;
    const bodyHits = hay.split(q).length - 1;
    const matchCount = titleHits + bodyHits;
    if (matchCount === 0) continue;

    let snippet: string;
    const idx = hay.indexOf(q);
    if (idx >= 0) {
      const start = Math.max(0, idx - 60);
      const end = Math.min(content.length, idx + q.length + 60);
      snippet =
        (start > 0 ? "…" : "") +
        content.slice(start, end).replace(/\s+/g, " ").trim() +
        (end < content.length ? "…" : "");
    } else {
      snippet = m.title; // matched in title only
    }
    results.push({ id: m.id, title: m.title, snippet, matchCount });
  }

  results.sort((a, b) => b.matchCount - a.matchCount);
  return results.slice(0, limit);
}
