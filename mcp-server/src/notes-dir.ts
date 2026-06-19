import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Note ids are filenames without the `.md` extension. We only ever accept ids
// (never raw paths) from clients, and confine every resolved path to the notes
// directory. This is the security boundary for the whole server.
const ID_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Resolve the notes directory.
 *
 * IMPORTANT: keep the default in sync with the Rust `get_notes_dir()` in
 * ../../src-tauri/src/lib.rs (currently `~/Documents/PlainNotes`). The Tauri
 * app should pass the authoritative path via `--notes-dir` when it registers
 * this server with a client, so this default is only a fallback for manual setups.
 */
export function resolveNotesDir(argv: string[], env: NodeJS.ProcessEnv): string {
  // 1. --notes-dir <path>  or  --notes-dir=<path>
  const flagIdx = argv.indexOf("--notes-dir");
  if (flagIdx !== -1 && argv[flagIdx + 1]) {
    return path.resolve(argv[flagIdx + 1]);
  }
  const inline = argv.find((a) => a.startsWith("--notes-dir="));
  if (inline) {
    return path.resolve(inline.slice("--notes-dir=".length));
  }

  // 2. PLAIN_NOTES_DIR env var
  const fromEnv = env.PLAIN_NOTES_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);

  // 3. default: ~/Documents/PlainNotes (mirrors dirs::document_dir() on macOS/Windows)
  const home = os.homedir();
  if (home) return path.join(home, "Documents", "PlainNotes");

  // 4. fallback: <cwd>/PlainNotes
  return path.join(process.cwd(), "PlainNotes");
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Resolve a client-supplied note id to an absolute path, confined to notesDir. */
export function noteIdToPath(notesDir: string, id: string): string {
  const bare = id.endsWith(".md") ? id.slice(0, -3) : id;
  if (!ID_RE.test(bare) || bare === "." || bare === "..") {
    throw new Error(`Invalid note id: ${JSON.stringify(id)}`);
  }
  const resolved = path.resolve(notesDir, `${bare}.md`);
  // Defense in depth: even if the regex is somehow bypassed, never escape notesDir.
  const rel = path.relative(notesDir, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Path escapes notes directory");
  }
  return resolved;
}
