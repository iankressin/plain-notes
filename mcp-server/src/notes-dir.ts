import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export function validSegment(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && !/[\x00-\x1f\x7f/\\]/.test(value);
}

function checkedPath(notesDir: string, relative: string): string {
  const parts = relative === "" ? [] : relative.split("/");
  if (!parts.every(validSegment)) throw new Error("Invalid notes location");
  let resolved = path.resolve(notesDir);
  for (const part of parts) {
    resolved = path.join(resolved, part);
    if (fs.lstatSync(resolved).isSymbolicLink()) {
      throw new Error("Symbolic links cannot be used as notes locations");
    }
  }
  return resolved;
}

export function folderToPath(notesDir: string, folder: string): string {
  const resolved = checkedPath(notesDir, folder);
  if (!fs.statSync(resolved).isDirectory()) throw new Error("Folder does not exist");
  return resolved;
}

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
  if (!bare || !bare.split("/").every(validSegment)) {
    throw new Error(`Invalid note id: ${JSON.stringify(id)}`);
  }
  const resolved = checkedPath(notesDir, `${bare}.md`);
  if (!fs.statSync(resolved).isFile()) throw new Error("Note does not exist");
  return resolved;
}
