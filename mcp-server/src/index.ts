#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ensureDir, resolveNotesDir } from "./notes-dir";
import { registerTools } from "./tools";

async function main(): Promise<void> {
  const notesDir = resolveNotesDir(process.argv, process.env);
  ensureDir(notesDir);

  // stdout is the JSON-RPC channel for stdio transport — all logging goes to stderr.
  console.error(`[plain-notes-mcp] notes dir: ${notesDir}`);

  const server = new McpServer({ name: "plain-notes", version: "0.1.0" });
  registerTools(server, notesDir);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[plain-notes-mcp] connected over stdio");
}

main().catch((e) => {
  console.error("[plain-notes-mcp] fatal:", e);
  process.exit(1);
});
