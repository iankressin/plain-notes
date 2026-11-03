// Integration smoke test: spins up the real server over stdio via the MCP client
// SDK and exercises every tool + the path-safety boundary.
// Run with: bun run test/smoke.mjs   (from the mcp-server directory)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pn-mcp-smoke-"));

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name} ${detail}`);
  }
}
const textOf = (r) => (r.content ?? []).map((c) => c.text ?? "").join("\n");

// Default: run the TS source via bun. Set MCP_SERVER_CMD to a compiled binary
// path to smoke-test the shipped artifact instead.
const serverCmd = process.env.MCP_SERVER_CMD;
const transport = new StdioClientTransport(
  serverCmd
    ? { command: serverCmd, args: ["--notes-dir", tmp] }
    : { command: "bun", args: ["run", "src/index.ts", "--notes-dir", tmp] },
);
const client = new Client({ name: "smoke", version: "0.0.0" });

try {
  await client.connect(transport);
  console.log(`notes dir: ${tmp}`);

  // tools/list
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  check("lists 9 tools", names.length === 9, JSON.stringify(names));
  check(
    "expected tool names",
    JSON.stringify(names) ===
      JSON.stringify([
        "create_folder",
        "create_note",
        "delete_note",
        "edit_note",
        "list_folders",
        "list_notes",
        "move_note",
        "read_note",
        "search_notes",
      ]),
    JSON.stringify(names),
  );

  // annotations: clients use these to gate calls (auto-approve reads, confirm
  // destructive ops). Verify they survive the round-trip through a real client.
  const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations ?? {}]));
  check("list_notes is readOnly", byName.list_notes?.readOnlyHint === true);
  check("read_note is readOnly", byName.read_note?.readOnlyHint === true);
  check("search_notes is readOnly", byName.search_notes?.readOnlyHint === true);
  check("delete_note is destructive", byName.delete_note?.destructiveHint === true);
  check("delete_note is idempotent", byName.delete_note?.idempotentHint === true);
  check("edit_note is destructive", byName.edit_note?.destructiveHint === true);
  check("create_note not destructive", byName.create_note?.destructiveHint === false);

  // create_note
  const created = await client.callTool({
    name: "create_note",
    arguments: { title: "Grocery list", content: "- milk\n- eggs" },
  });
  const id = created.structuredContent?.id;
  check("create_note returns id", typeof id === "string" && id.startsWith("note-"), String(id));
  check("create_note title parsed", created.structuredContent?.title === "Grocery list");

  // list_notes
  const listed = await client.callTool({ name: "list_notes", arguments: {} });
  check("list_notes includes new note", (listed.structuredContent?.notes ?? []).some((n) => n.id === id));

  // read_note
  const read = await client.callTool({ name: "read_note", arguments: { id } });
  check("read_note returns content", textOf(read).includes("# Grocery list"));
  check("read_note body present", textOf(read).includes("- milk"));

  // edit_note append
  await client.callTool({
    name: "edit_note",
    arguments: { id, mode: "append", content: "- bread" },
  });
  const read2 = await client.callTool({ name: "read_note", arguments: { id } });
  check("append adds line", textOf(read2).includes("- bread"));

  // edit_note str_replace (unique)
  const sr = await client.callTool({
    name: "edit_note",
    arguments: { id, mode: "str_replace", find: "milk", replace_with: "oat milk" },
  });
  check("str_replace ok", sr.isError !== true, textOf(sr));
  const read3 = await client.callTool({ name: "read_note", arguments: { id } });
  check("str_replace applied", textOf(read3).includes("oat milk"));

  // edit_note str_replace ambiguous -> error
  const amb = await client.callTool({
    name: "edit_note",
    arguments: { id, mode: "str_replace", find: "-", replace_with: "*" },
  });
  check("ambiguous str_replace errors", amb.isError === true, textOf(amb));

  // search_notes
  const found = await client.callTool({ name: "search_notes", arguments: { query: "oat" } });
  check("search finds note", (found.structuredContent?.results ?? []).some((r) => r.id === id));

  // pinned frontmatter round-trips
  const pinned = await client.callTool({
    name: "create_note",
    arguments: { content: "---\npinned: true\n---\n# Important\n\nbody" },
  });
  const pid = pinned.structuredContent?.id;
  const listed2 = await client.callTool({ name: "list_notes", arguments: {} });
  const pinnedEntry = (listed2.structuredContent?.notes ?? []).find((n) => n.id === pid);
  check("pinned frontmatter parsed", pinnedEntry?.pinned === true);
  check("pinned title parsed", pinnedEntry?.title === "Important");

  const folder = await client.callTool({ name: "create_folder", arguments: { name: "Work" } });
  check("creates root folder", folder.structuredContent?.path === "Work", textOf(folder));
  const nestedFolder = await client.callTool({
    name: "create_folder", arguments: { parent: "Work", name: "Project A" },
  });
  check("creates nested folder", nestedFolder.structuredContent?.path === "Work/Project A");
  const duplicateFolder = await client.callTool({ name: "create_folder", arguments: { name: "Work" } });
  check("duplicate folder errors", duplicateFolder.isError === true);
  const folderList = await client.callTool({ name: "list_folders", arguments: {} });
  check("lists empty nested folders", folderList.structuredContent?.folders?.some((f) => f.path === "Work/Project A"));

  const nested = await client.callTool({
    name: "create_note", arguments: { folder: "Work/Project A", title: "Nested", content: "domain-specific text" },
  });
  const nestedId = nested.structuredContent?.id;
  check("creates note in selected folder", typeof nestedId === "string" && nestedId.startsWith("Work/Project A/note-"));
  check("returns note folder", nested.structuredContent?.folder === "Work/Project A");
  if (nestedId) {
    const nestedRead = await client.callTool({ name: "read_note", arguments: { id: nestedId } });
    check("reads nested note", textOf(nestedRead).includes("domain-specific text"));
    await client.callTool({ name: "edit_note", arguments: { id: nestedId, mode: "append", content: "more detail" } });
    const nestedSearch = await client.callTool({ name: "search_notes", arguments: { query: "more detail" } });
    check("search finds edited nested note", nestedSearch.structuredContent?.results?.some((r) => r.id === nestedId));
    const nestedDelete = await client.callTool({ name: "delete_note", arguments: { id: nestedId } });
    check("deletes nested note", nestedDelete.isError !== true && !fs.existsSync(path.join(tmp, `${nestedId}.md`)));
  }

  fs.mkdirSync(path.join(tmp, "Work/Project A"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "same.md"), "# Root duplicate");
  fs.writeFileSync(path.join(tmp, "Work/Project A/same.md"), "# Nested duplicate");
  const duplicates = await client.callTool({ name: "list_notes", arguments: {} });
  const duplicateIds = (duplicates.structuredContent?.notes ?? []).map((n) => n.id);
  check("duplicate filenames have distinct IDs", duplicateIds.includes("same") && duplicateIds.includes("Work/Project A/same"));
  const collision = await client.callTool({ name: "move_note", arguments: { id: "same", folder: "Work/Project A" } });
  check("move refuses collision", collision.isError === true);
  check("collision preserves both contents", fs.readFileSync(path.join(tmp, "same.md"), "utf8") === "# Root duplicate"
    && fs.readFileSync(path.join(tmp, "Work/Project A/same.md"), "utf8") === "# Nested duplicate");

  const moveContent = "---\npinned: true\n---\n# Move me\n\nExact bytes\n";
  fs.writeFileSync(path.join(tmp, "movable.md"), moveContent);
  const moved = await client.callTool({ name: "move_note", arguments: { id: "movable", folder: "Work/Project A" } });
  check("move returns new ID", moved.structuredContent?.id === "Work/Project A/movable", textOf(moved));
  check("move retains pin", moved.structuredContent?.pinned === true);
  check("move removes old path", !fs.existsSync(path.join(tmp, "movable.md")));
  if (moved.structuredContent?.id) {
    check("move preserves exact bytes", fs.readFileSync(path.join(tmp, "Work/Project A/movable.md"), "utf8") === moveContent);
    const sameFolder = await client.callTool({ name: "move_note", arguments: { id: "Work/Project A/movable", folder: "Work/Project A" } });
    check("move to current folder is harmless", sameFolder.isError !== true);
    const movedBack = await client.callTool({ name: "move_note", arguments: { id: "Work/Project A/movable", folder: "" } });
    check("move to root works", movedBack.structuredContent?.id === "movable");
  }
  for (const badFolder of ["../escape", "/outside", "Work/../Other", "Work\\Other", "Missing"]) {
    const bad = await client.callTool({ name: "create_note", arguments: { folder: badFolder } });
    check(`rejects folder ${JSON.stringify(badFolder)}`, bad.isError === true);
  }
  const invalidName = await client.callTool({ name: "create_folder", arguments: { name: "../escape" } });
  check("rejects invalid folder name", invalidName.isError === true);

  fs.symlinkSync(tmp, path.join(tmp, "loop"));
  fs.symlinkSync(path.join(tmp, "same.md"), path.join(tmp, "linked.md"));
  const linkedRead = await client.callTool({ name: "read_note", arguments: { id: "linked" } });
  check("refuses linked notes", linkedRead.isError === true);
  const linkedCreate = await client.callTool({ name: "create_note", arguments: { folder: "loop" } });
  check("refuses linked folders", linkedCreate.isError === true);
  const withoutLinks = await client.callTool({ name: "list_notes", arguments: {} });
  check("listing ignores links", !(withoutLinks.structuredContent?.notes ?? []).some((n) => n.id === "linked" || n.id.startsWith("loop/")));

  // path-safety: traversal ids must be rejected (isError), nothing read outside dir
  for (const badId of ["../secret", "../../etc/passwd", "note/../../x", ".."]) {
    const bad = await client.callTool({ name: "read_note", arguments: { id: badId } });
    check(`rejects traversal id ${JSON.stringify(badId)}`, bad.isError === true, textOf(bad));
  }

  // read non-existent -> isError
  const missing = await client.callTool({ name: "read_note", arguments: { id: "note-does-not-exist" } });
  check("missing note errors", missing.isError === true);

  // delete_note: removes the file and drops it from the listing
  const del = await client.callTool({ name: "delete_note", arguments: { id } });
  check("delete ok", del.isError !== true, textOf(del));
  const listed3 = await client.callTool({ name: "list_notes", arguments: {} });
  check("deleted note gone from list", !(listed3.structuredContent?.notes ?? []).some((n) => n.id === id));
  const readDeleted = await client.callTool({ name: "read_note", arguments: { id } });
  check("reading deleted note errors", readDeleted.isError === true);

  // delete non-existent / traversal -> isError, touches nothing
  const delMissing = await client.callTool({ name: "delete_note", arguments: { id } });
  check("delete missing errors", delMissing.isError === true);
  const delTraversal = await client.callTool({ name: "delete_note", arguments: { id: "../secret" } });
  check("delete rejects traversal id", delTraversal.isError === true, textOf(delTraversal));

  if (process.platform !== "win32") {
    fs.mkdirSync(path.join(tmp, "Project: A"));
    fs.writeFileSync(path.join(tmp, "Project: A/Notes & questions?.md"), "# External filename");
    const externalFolders = await client.callTool({ name: "list_folders", arguments: {} });
    check("lists existing folder names with punctuation", externalFolders.structuredContent?.folders?.some((f) => f.path === "Project: A"));
    const externalNotes = await client.callTool({ name: "list_notes", arguments: {} });
    check("existing folder names do not interrupt listing", externalNotes.structuredContent?.notes?.some((n) => n.id === "Project: A/Notes & questions?"));
    const externalRead = await client.callTool({ name: "read_note", arguments: { id: "Project: A/Notes & questions?" } });
    check("reads existing filenames with punctuation", textOf(externalRead).includes("# External filename"));
    const externalMove = await client.callTool({ name: "move_note", arguments: { id: "same", folder: "Project: A" } });
    check("moves into existing folder names with punctuation", externalMove.structuredContent?.id === "Project: A/same");
  }
} catch (e) {
  failures += 1;
  console.error("FATAL", e);
} finally {
  await client.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
