require("dotenv").config();
const logBuffer = [];
const originalLog = console.log;
const originalError = console.error;
console.log = (...args) => {
  logBuffer.push("[LOG] " + args.join(" "));
  if (logBuffer.length > 500) logBuffer.shift();
  originalLog(...args);
};
console.error = (...args) => {
  logBuffer.push("[ERR] " + args.join(" "));
  if (logBuffer.length > 500) logBuffer.shift();
  originalError(...args);
};

const express = require("express");
const cors = require("cors");

const memoryRoutes = require("./routes/memory");
const { mountMcp } = require("./mcpHttp");

const app = express();
// Trust proxy is required to reconstruct the correct https:// protocol
// in the x402 payment challenges when running behind edge proxies (like Railway)
app.set("trust proxy", true);

app.get("/logs", (req, res) => {
  res.type("text/plain").send(logBuffer.join("\n"));
});

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Force Accept header for /mcp requests so MCP transport handles them
// correctly even if clients (like task-402-pay) do not send standard headers.
app.use((req, res, next) => {
  if (req.path.includes("mcp")) {
    req.headers["accept"] = "application/json, text/event-stream";
    if (req.rawHeaders) {
      const idx = req.rawHeaders.findIndex(h => h.toLowerCase() === "accept");
      if (idx !== -1) {
        req.rawHeaders[idx + 1] = "application/json, text/event-stream";
      } else {
        req.rawHeaders.push("Accept", "application/json, text/event-stream");
      }
    }
  }
  next();
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "cortex", version: "0.1.0", updated: "accept-fix-v2" });
});

const PAYMENTS_ENFORCED = process.env.PAYMENTS_ENFORCED === "true" || (process.env.PAYMENTS_ENFORCED !== "false" && !!process.env.PAY_TO_ADDRESS && !!process.env.OKX_API_KEY);

let realPaymentMw = null;

async function getPaymentMiddleware() {
  if (!PAYMENTS_ENFORCED) {
    console.log("Cortex: PAYMENTS_ENFORCED=false — all requests pass through unpaid.");
    return (req, res, next) => next();
  }

  const PAY_TO = process.env.PAY_TO_ADDRESS;
  if (!PAY_TO) {
    console.warn("[x402] PAY_TO_ADDRESS is missing — falling back to unpaywalled routes.");
    return (req, res, next) => next();
  }

  if (!process.env.OKX_API_KEY || !process.env.OKX_SECRET_KEY || !process.env.OKX_PASSPHRASE) {
    console.warn("[x402] OKX credentials missing — falling back to unpaywalled routes.");
    return (req, res, next) => next();
  }

  try {
    const { paymentMiddleware, x402ResourceServer } = require("@okxweb3/x402-express");
    const { ExactEvmScheme } = require("@okxweb3/x402-evm/exact/server");
    const { OKXFacilitatorClient } = require("@okxweb3/x402-core");

    const NETWORK = process.env.X402_NETWORK || "eip155:1952"; // X Layer Testnet by default

    const facilitatorClient = new OKXFacilitatorClient({
      apiKey: process.env.OKX_API_KEY,
      secretKey: process.env.OKX_SECRET_KEY,
      passphrase: process.env.OKX_PASSPHRASE
    });

    const resourceServer = new x402ResourceServer(facilitatorClient);
    resourceServer.register(NETWORK, new ExactEvmScheme());

    // Validate credentials/connectivity BEFORE handing back working middleware
    await resourceServer.initialize();

    console.log(`[x402] Payments ENABLED on network ${NETWORK}, paying to ${PAY_TO}`);

    const MCP_ACCEPTS = [{
      scheme: "exact",
      network: NETWORK,
      payTo: PAY_TO,
      price: process.env.X402_PRICE_MCP_CALL || "$0.3",
      extra: { decimals: 6 }
    }];

    return paymentMiddleware(
      {
        "POST /memory/write": {
          accepts: [{
            scheme: "exact",
            network: NETWORK,
            payTo: PAY_TO,
            price: "$0.3",
            extra: { decimals: 6 }
          }],
          description: "Cortex: write_memory — permanently store an agent memory object",
          mimeType: "application/json"
        },
        "GET /memory/recall/:id": {
          accepts: [{
            scheme: "exact",
            network: NETWORK,
            payTo: PAY_TO,
            price: "$0.3",
            extra: { decimals: 6 }
          }],
          description: "Cortex: recall_memory — retrieve and verify a stored memory",
          mimeType: "application/json"
        },
        "GET /memory/query": {
          accepts: [{
            scheme: "exact",
            network: NETWORK,
            payTo: PAY_TO,
            price: "$0.3",
            extra: { decimals: 6 }
          }],
          description: "Cortex: query_memory — search an agent's memory history",
          mimeType: "application/json"
        },
        "GET /memory/digest": {
          accepts: [{
            scheme: "exact",
            network: NETWORK,
            payTo: PAY_TO,
            price: "$0.3",
            extra: { decimals: 6 }
          }],
          description: "Cortex: get_memory_digest — generate a compressed summary of memory history",
          mimeType: "application/json"
        },
        "POST /mcp": {
          accepts: MCP_ACCEPTS,
          description: "Cortex Multi-Agent Memory & Digest MCP server",
          mimeType: "application/json"
        },
        "GET /mcp": {
          accepts: MCP_ACCEPTS,
          description: "Cortex Multi-Agent Memory & Digest MCP server",
          mimeType: "application/json"
        }
      },
      resourceServer
    );
  } catch (err) {
    console.error(`[x402] Failed to initialize payment facilitator (${err.message}) — falling back to unpaywalled routes.`);
    return (req, res, next) => next();
  }
}

const paymentMwReady = getPaymentMiddleware()
  .then((mw) => {
    realPaymentMw = mw;
  })
  .catch((err) => {
    console.error("[x402] Failed to initialize payment middleware:", err.message);
    realPaymentMw = (req, res, next) => next();
  });

app.use((req, res, next) => {
  if (realPaymentMw) return realPaymentMw(req, res, next);
  paymentMwReady.then(() => realPaymentMw(req, res, next)).catch(next);
});

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