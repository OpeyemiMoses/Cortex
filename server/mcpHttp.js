const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { registerTools } = require("../mcp/tools");

const server = new McpServer({ name: "cortex", version: "0.1.0" });
registerTools(server);

const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

// Connect once at module load — the transport/server pairing is stateless
// and reused across every request, matching the SDK's documented pattern.
let connected = false;
async function ensureConnected() {
  if (!connected) {
    await server.connect(transport);
    connected = true;
  }
}

function mountMcp(app, path = "/mcp") {
  app.post(path, async (req, res) => {
    try {
      await ensureConnected();
      // Ensure the request headers satisfy StreamableHTTPServerTransport's requirement
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
      info: "Send JSON-RPC 2.0 POST requests to this endpoint. A valid x402 payment header is required when payments are enabled."
    });
  });

  console.log(`Cortex: MCP endpoint mounted at ${path} (this is the A2MCP registration target)`);
}

module.exports = { mountMcp };
