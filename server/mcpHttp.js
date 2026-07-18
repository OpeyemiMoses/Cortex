const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { registerTools } = require("../mcp/tools");

function mountMcp(app, path = "/mcp") {
  app.post(path, async (req, res) => {
    try {
      // Fresh server + transport per request (stateless).
      // This is the correct pattern for a resource server that doesn't
      // need session resumability — each tools/call gets a clean handler.
      const server = new McpServer({ name: "cortex", version: "0.1.0" });
      registerTools(server);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      req.headers["accept"] = "application/json, text/event-stream";
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request failed:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "MCP request failed" });
      }
    }
  });

  app.get(path, (req, res) => {
    res.status(200).json({
      service: "cortex-mcp",
      version: "0.1.0",
      transport: "Streamable HTTP (POST /mcp)",
      info: "Send JSON-RPC 2.0 POST requests to this endpoint. A valid x402 payment header is required."
    });
  });

  console.log(`Cortex: MCP endpoint mounted at ${path}`);
}

module.exports = { mountMcp };

