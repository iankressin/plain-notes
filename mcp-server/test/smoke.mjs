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
  check("lists 6 tools", names.length === 6, JSON.stringify(names));
  check(
    "expected tool names",
    JSON.stringify(names) ===
      JSON.stringify([
        "create_note",
        "delete_note",
        "edit_note",
        "list_notes",
        "read_note",
        "search_notes",
      ]),
    JSON.stringify(names),
  );

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
} catch (e) {
  failures += 1;
  console.error("FATAL", e);
} finally {
  await client.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
