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

/**
 * The MCP endpoint is mounted before the payment middleware below and is
 * NOT included in that middleware's route config — A2MCP calls go through
 * OKX.AI's own metering once listed, not through this app's own x402 gate.
 * (See mcp/server.js and server/mcpHttp.js for the full reasoning.)
 */
mountMcp(app, "/mcp");

const PAYMENTS_ENFORCED = process.env.PAYMENTS_ENFORCED === "true";

if (PAYMENTS_ENFORCED) {
  /**
   * Real integration against OKX's Onchain OS Payment SDK
   * (docs: web3.okx.com/onchainos/dev-docs/payments/service-seller-sdk).
   * This replaces an earlier hand-rolled x402 implementation — the SDK
   * handles the facilitator connection and stablecoin conversion
   * internally, so there's no separate facilitator URL or asset contract
   * address to configure. You only need API credentials + a payout wallet.
   *
   * NOTE — unverified: OKX's own docs examples only show static route
   * paths (e.g. "GET /generateImg"). Whether "GET /memory/recall/:id"
   * (a path param) matches the same way isn't shown in their docs. Test
   * this specific route once the SDK is actually installed — if dynamic
   * segments aren't supported by the middleware's route matching, recall
   * may need a workaround (e.g. a query param instead of a path param).
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

  app.use(
    paymentMiddleware(
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
        }
      },
      resourceServer
    )
  );

  console.log(`Cortex: x402 payments ENFORCED via OKX Onchain OS SDK on ${NETWORK}`);
} else {
  console.log("Cortex: PAYMENTS_ENFORCED=false — all requests pass through unpaid.");
}

app.use("/memory", memoryRoutes);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Cortex listening on port ${PORT}`);
});
