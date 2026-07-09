require("dotenv").config();
const express = require("express");
const cors = require("cors");

const memoryRoutes = require("./routes/memory");
const { mountMcp } = require("./mcpHttp");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "cortex", version: "0.1.0" });
});

const PAYMENTS_ENFORCED = process.env.PAYMENTS_ENFORCED === "true";

/**
 * The MCP endpoint (A2MCP target) is GATED by the same x402 payment
 * middleware as the REST routes below, at a flat rate for all tool calls.
 *
 * Per OKX's Agent Payments Protocol whitepaper: when an agent hits a
 * priced endpoint (including via A2MCP), the SELLER'S OWN SERVER returns
 * the 402 challenge — OKX.AI's marketplace does not intercept or meter
 * this separately. So /mcp must be gated directly, same as any other
 * priced route.
 *
 * IMPORTANT: MCP's Streamable HTTP transport uses a single POST /mcp for
 * EVERYTHING — the initial handshake (`initialize`), tool discovery
 * (`tools/list`), AND actual tool invocations (`tools/call`). Gating the
 * whole route blindly (an earlier version of this file did this) blocks
 * the handshake itself — an agent can't even discover what tools exist
 * without paying first, which breaks MCP Inspector and would break every
 * real agent trying to connect via OKX.AI.
 *
 * Fix: use the SDK's `onProtectedRequest` hook (on x402HTTPResourceServer,
 * via `paymentMiddlewareFromHTTPServer` — a lower-level entry point than
 * the docs' quickstart `paymentMiddleware`, found in the SDK's own type
 * definitions/JSDoc, not the public docs site) to inspect the parsed
 * JSON-RPC body and grant free access to `initialize` and `tools/list`,
 * while leaving `tools/call` (the only requests that do billable work)
 * subject to the normal 402 challenge.
 *
 * NOTE: this is still a FLAT rate across all 4 MCP tools (write/recall/
 * query/digest) once a tools/call request does require payment — true
 * per-tool pricing on /mcp would need per-request dynamic pricing, which
 * the SDK doesn't expose a documented hook for. Flat rate was chosen
 * deliberately for hackathon timeline safety.
 */
let paymentMiddlewareInstance = null;

if (PAYMENTS_ENFORCED) {
  const {
    paymentMiddlewareFromHTTPServer,
    x402ResourceServer,
    x402HTTPResourceServer
  } = require("@okxweb3/x402-express");
  const { ExactEvmScheme } = require("@okxweb3/x402-evm/exact/server");
  const { OKXFacilitatorClient } = require("@okxweb3/x402-core");

  const NETWORK = process.env.X402_NETWORK || "eip155:1952"; // X Layer testnet by default
  const PAY_TO = process.env.PAY_TO_ADDRESS;

  if (!PAY_TO) {
    throw new Error("PAY_TO_ADDRESS is required when PAYMENTS_ENFORCED=true.");
  }

  const facilitatorClient = new OKXFacilitatorClient({
    apiKey: process.env.OKX_API_KEY,
    secretKey: process.env.OKX_SECRET_KEY,
    passphrase: process.env.OKX_PASSPHRASE
  });

  const resourceServer = new x402ResourceServer(facilitatorClient);
  resourceServer.register(NETWORK, new ExactEvmScheme());

  const routes = {
    "POST /memory/write": {
      accepts: [{
        scheme: "exact",
        network: NETWORK,
        payTo: PAY_TO,
        price: process.env.X402_PRICE_WRITE_MEMORY || "$0.01"
      }],
      description: "Cortex: write_memory — permanently store an agent memory object",
      mimeType: "application/json"
    },
    "GET /memory/recall/:id": {
      accepts: [{
        scheme: "exact",
        network: NETWORK,
        payTo: PAY_TO,
        price: process.env.X402_PRICE_RECALL_MEMORY || "$0.001"
      }],
      description: "Cortex: recall_memory — retrieve and verify a stored memory",
      mimeType: "application/json"
    },
    "GET /memory/query": {
      accepts: [{
        scheme: "exact",
        network: NETWORK,
        payTo: PAY_TO,
        price: process.env.X402_PRICE_QUERY_MEMORY || "$0.005"
      }],
      description: "Cortex: query_memory — search an agent's memory history",
      mimeType: "application/json"
    },
    "POST /mcp": {
      accepts: [{
        scheme: "exact",
        network: NETWORK,
        payTo: PAY_TO,
        price: process.env.X402_PRICE_MCP_CALL || "$0.01"
      }],
      description: "Cortex: A2MCP tool call — flat rate covering write_memory, recall_memory, query_memory, and get_memory_digest",
      mimeType: "application/json"
    }
  };

  const httpServer = new x402HTTPResourceServer(resourceServer, routes);

  // Only actual tool invocations (tools/call) should be billable.
  // initialize and tools/list are handshake/discovery — free, or no agent
  // could ever connect long enough to find out what they'd be paying for.
  const FREE_MCP_METHODS = new Set(["initialize", "notifications/initialized", "tools/list", "ping"]);

  httpServer.onProtectedRequest(async (context, routeConfig) => {
    if (context.path !== "/mcp") {
      return; // not the MCP route — normal payment flow applies
    }

    const body = context.adapter.getBody();
    const method = body && typeof body === "object" ? body.method : undefined;

    if (method && FREE_MCP_METHODS.has(method)) {
      return { grantAccess: true };
    }

    // method === "tools/call" (or unrecognized) falls through to the
    // normal 402 challenge / payment verification flow below.
    return;
  });

  paymentMiddlewareInstance = paymentMiddlewareFromHTTPServer(httpServer);
  app.use(paymentMiddlewareInstance);

  console.log(`Cortex: x402 payments ENFORCED via OKX Onchain OS SDK on ${NETWORK} (including /mcp tools/call; initialize/tools/list are free)`);
} else {
  console.log("Cortex: PAYMENTS_ENFORCED=false — all requests pass through unpaid.");
}

/**
 * mountMcp is called AFTER the payment middleware is registered above, so
 * a POST to /mcp passes through the 402 challenge/verification flow
 * (and the onProtectedRequest hook above) before reaching the MCP
 * transport handler.
 */
mountMcp(app, "/mcp");

app.use("/memory", memoryRoutes);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Cortex listening on port ${PORT}`);
});