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
 * The MCP endpoint (A2MCP target) is now GATED by the same x402 payment
 * middleware as the REST routes below, at a flat rate for all tool calls.
 *
 * Per OKX's Agent Payments Protocol whitepaper: when an agent hits a
 * priced endpoint (including via A2MCP), the SELLER'S OWN SERVER is
 * responsible for returning the 402 challenge — OKX.AI's marketplace does
 * not intercept or meter this on your behalf. So /mcp must be gated
 * directly, same as any other priced route.
 *
 * NOTE: this is a FLAT rate across all 4 MCP tools (write/recall/query/
 * digest), not per-tool pricing like the REST routes below. The SDK's
 * documented paymentMiddleware only supports static "METHOD /path"
 * route configs — it has no documented hook for pricing based on request
 * body contents (which is what would be needed to distinguish which MCP
 * tool is being called inside a single POST /mcp route). True per-tool
 * pricing on /mcp would require undocumented use of the SDK's internals
 * and was deliberately descoped for hackathon timeline safety — a single
 * flat price that works correctly beats fine-grained pricing that might
 * not. Revisit post-hackathon if OKX ships a documented way to do this.
 */
let paymentMiddlewareInstance = null;

if (PAYMENTS_ENFORCED) {
  /**
   * Real integration against OKX's Onchain OS Payment SDK
   * (docs: web3.okx.com/onchainos/dev-docs/payments/service-seller-sdk).
   * This replaces an earlier hand-rolled x402 implementation — the SDK
   * handles the facilitator connection and stablecoin conversion
   * internally, so there's no separate facilitator URL or asset contract
   * address to configure. You only need API credentials + a payout wallet.
   */
  const { paymentMiddleware, x402ResourceServer } = require("@okxweb3/x402-express");
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

  paymentMiddlewareInstance = paymentMiddleware(
    {
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
    },
    resourceServer
  );

  app.use(paymentMiddlewareInstance);

  console.log(`Cortex: x402 payments ENFORCED via OKX Onchain OS SDK on ${NETWORK} (including /mcp, flat rate)`);
} else {
  console.log("Cortex: PAYMENTS_ENFORCED=false — all requests pass through unpaid.");
}

/**
 * mountMcp is now called AFTER the payment middleware is registered above,
 * so a POST to /mcp passes through the 402 challenge/verification flow
 * before reaching the MCP transport handler.
 */
mountMcp(app, "/mcp");

app.use("/memory", memoryRoutes);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Cortex listening on port ${PORT}`);
});