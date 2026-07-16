/**
 * Remote MCP endpoint for A2MCP registration.
 *
 * Per OKX's own docs (web3.okx.com/onchainos/dev-docs/okxai/howtomcp.md):
 * A2MCP requires a publicly reachable HTTPS MCP server — this mounts one
 * at POST /mcp inside the same Express app as the REST API, so a single
 * Railway deployment serves both. This IS the endpoint you register with
 * OKX.AI, not mcp/server.js (that one's stdio-only, local testing).
 *
 * ⚠️ NOTE — unverified: `StreamableHTTPServerTransport` is the current
 * recommended remote MCP transport as of when this was written, but the
 * exact import path/class name can shift between @modelcontextprotocol/sdk
 * versions. If this import fails after `npm install`, check the installed
 * SDK version's own docs/exports for the current name — it may have moved,
 * or an older SDK version might only expose the previous SSE-based
 * transport instead.
 *
 * Also worth testing before registering: OKX's docs mention the official
 * MCP Inspector tool for debugging a remote MCP server before going live —
 * `npx @modelcontextprotocol/inspector` and point it at your deployed
 * /mcp URL.
 */
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { registerTools } = require("../mcp/tools");

function mountMcp(app, path = "/mcp") {
  app.post(path, async (req, res) => {
    try {
      // Stateless: a fresh server + transport per request. Simplest correct
      // setup for a resource server like this one, which doesn't need to
      // track session state across calls. See the SDK's own docs if you
      // want session resumability instead.
      const server = new McpServer({ name: "cortex", version: "0.1.0" });
      registerTools(server);

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        server.close();
      });

      await server.connect(transport);
      console.log("[cortex-mcp] req.headers before override:", req.headers);
      // Ensure the request headers satisfy StreamableHTTPServerTransport's requirement
      req.headers["accept"] = "application/json, text/event-stream";
      console.log("[cortex-mcp] req.headers after override:", req.headers);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request failed:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "MCP request failed" });
      }
    }
  });

  console.log(`Cortex: MCP endpoint mounted at ${path} (this is the A2MCP registration target)`);
}

module.exports = { mountMcp };
