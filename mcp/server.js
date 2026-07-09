#!/usr/bin/env node
/**
 * Cortex MCP server — LOCAL STDIO ONLY, for testing with MCP clients
 * (Claude Code, Cursor, etc.) on your own machine.
 *
 * This is NOT what you register with OKX.AI's A2MCP lane. Per OKX's own
 * docs (howtomcp.md), A2MCP requires a publicly reachable HTTPS MCP
 * endpoint — stdio only works process-to-process on one machine, the
 * internet can't reach it. The real registration target is
 * server/mcpHttp.js, mounted inside the deployed Express app at /mcp.
 *
 * Tool definitions live in mcp/tools.js and are shared between this file
 * and server/mcpHttp.js, so both interfaces stay identical.
 */
require("dotenv").config();
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { registerTools } = require("./tools");

const server = new McpServer({ name: "cortex", version: "0.1.0" });
registerTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Cortex MCP server running on stdio (local testing only — not the A2MCP endpoint).");
}

main().catch((err) => {
  console.error("Cortex MCP server failed to start:", err);
  process.exit(1);
});
