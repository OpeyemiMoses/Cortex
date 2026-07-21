require("dotenv").config();

const express = require("express");
const cors = require("cors");

const memoryRoutes = require("./routes/memory");
const { mountMcp } = require("./mcpHttp");
const { extractPayerAddress } = require("./services/auth/paymentIdentity");
const { TOOL_REQUIRED_FIELDS } = require("../mcp/tools");

const app = express();
// Trust proxy is required to reconstruct the correct https:// protocol
// in the x402 payment challenges when running behind edge proxies (like Railway)
app.set("trust proxy", true);

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
  res.json({ status: "ok", service: "cortex", version: "0.1.0", updated: "price-fix-v1" });
});

const PAYMENTS_ENFORCED = process.env.PAYMENTS_ENFORCED === "true" || (process.env.PAYMENTS_ENFORCED !== "false" && !!process.env.PAY_TO_ADDRESS && !!process.env.OKX_API_KEY);

let realPaymentMw = null;

/**
 * Builds a stub 402 middleware for when the real OKX facilitator cannot be
 * reached. This ensures the endpoint stays structurally x402-compliant (the
 * PAYMENT-REQUIRED header is present and well-formed) even during facilitator
 * outages, so OKX review bots never see an unpaywalled 200.
 *
 * Payments cannot be verified in stub mode — this is a safety net only.
 */
function buildStub402Middleware(NETWORK, PAY_TO) {
  // USD₮0 contract on X Layer mainnet (eip155:196)
  const ASSET = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
  const ROUTES = {
    "/memory/write":     { price: "300000", desc: "Cortex: write_memory — permanently store an agent memory object" },
    "/memory/recall":    { price: "300000", desc: "Cortex: recall_memory — retrieve and verify a stored memory" },
    "/memory/query":     { price: "300000", desc: "Cortex: query_memory — search an agent's memory history" },
    "/memory/digest":    { price: "300000", desc: "Cortex: get_memory_digest — generate a compressed summary of memory history" },
    "/memory/my-agents": { price: "300000", desc: "Cortex: list_my_agents — list all namespaced agent IDs" },
    "/mcp":              { price: "300000", desc: "Cortex Multi-Agent Memory & Digest MCP server" }
  };

  return (req, res, next) => {
    const routeKey = Object.keys(ROUTES).find(p =>
      req.path === p || req.path.startsWith(p + "/") || req.path.startsWith(p + "?")
    );
    if (!routeKey) return next();

    const config = ROUTES[routeKey];
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const challenge = {
      x402Version: 2,
      resource: {
        url: `${baseUrl}${req.path}`,
        description: config.desc,
        mimeType: "application/json"
      },
      accepts: [{
        scheme: "exact",
        network: NETWORK,
        asset: ASSET,
        amount: config.price,
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        extra: { name: "USD₮0", version: "1" }
      }]
    };
    const encoded = Buffer.from(JSON.stringify(challenge)).toString("base64");
    console.warn(`[x402-stub] Returning stub 402 for ${req.method} ${req.path} (facilitator unavailable)`);
    res.status(402)
      .set("PAYMENT-REQUIRED", encoded)
      .json({ error: "Payment required", x402Version: 2 });
  };
}

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

    // Retry initialization with backoff — cold starts on Railway can cause transient
    // DNS / network unavailability that resolves within seconds.
    const MAX_RETRIES = 5;
    const RETRY_DELAY_MS = 5000;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await resourceServer.initialize();
        break; // success — exit retry loop
      } catch (initErr) {
        if (attempt < MAX_RETRIES) {
          console.warn(`[x402] initialize() attempt ${attempt}/${MAX_RETRIES} failed (${initErr.message}). Retrying in ${RETRY_DELAY_MS}ms...`);
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        } else {
          console.error(`[x402] All ${MAX_RETRIES} initialize() attempts failed. Installing stub 402 middleware.`);
          return buildStub402Middleware(NETWORK, PAY_TO);
        }
      }
    }

    console.log(`[x402] Payments ENABLED on network ${NETWORK}, paying to ${PAY_TO}`);

    // Hardcoded to $0.3 per call for every route. IMPORTANT: this SDK's
    // `price` field takes a DOLLAR-denominated string and converts it to the
    // asset's base units itself (see parseMoneyToDecimal/defaultMoneyConversion
    // in @okxweb3/x402-evm) — it is NOT pre-converted base units. Passing
    // "300000" here previously caused the SDK to multiply it by the asset's
    // decimals again, requiring $300,000 per call instead of $0.3.
    const PRICE_ALL = "0.3";
    const PRICE_WRITE   = PRICE_ALL;
    const PRICE_RECALL  = PRICE_ALL;
    const PRICE_QUERY   = PRICE_ALL;
    const PRICE_DIGEST  = PRICE_ALL;
    const PRICE_AGENTS  = PRICE_ALL;
    const PRICE_MCP     = PRICE_ALL;

    console.log(`[x402] Resolved prices (USD) — write:${PRICE_WRITE} recall:${PRICE_RECALL} query:${PRICE_QUERY} digest:${PRICE_DIGEST} agents:${PRICE_AGENTS} mcp:${PRICE_MCP}`);


    const MCP_ACCEPTS = [{
      scheme: "exact",
      network: NETWORK,
      payTo: PAY_TO,
      price: PRICE_MCP,
      extra: { name: "USD₮0", version: "1" }
    }];

    return paymentMiddleware(
      {
        "POST /memory/write": {
          accepts: [{
            scheme: "exact",
            network: NETWORK,
            payTo: PAY_TO,
            price: PRICE_WRITE,
            extra: { name: "USD₮0", version: "1" }
          }],
          description: "Cortex: write_memory — permanently store an agent memory object. Requires a JSON body: agent_id (string), type (string), content (string), visibility (\"private\" | \"public\" | \"permissioned\").",
          mimeType: "application/json"
        },
        "GET /memory/write": {
          accepts: [{
            scheme: "exact",
            network: NETWORK,
            payTo: PAY_TO,
            price: PRICE_WRITE,
            extra: { name: "USD₮0", version: "1" }
          }],
          description: "Cortex: write_memory — permanently store an agent memory object. Requires query params or JSON body: agent_id (string), type (string), content (string), visibility (\"private\" | \"public\" | \"permissioned\").",
          mimeType: "application/json"
        },
        "POST /memory/recall": {
          accepts: [{
            scheme: "exact",
            network: NETWORK,
            payTo: PAY_TO,
            price: PRICE_RECALL,
            extra: { name: "USD₮0", version: "1" }
          }],
          description: "Cortex: recall_memory — retrieve and verify a stored memory. Requires a JSON body: id (string).",
          mimeType: "application/json"
        },
        "GET /memory/recall": {
          accepts: [{
            scheme: "exact",
            network: NETWORK,
            payTo: PAY_TO,
            price: PRICE_RECALL,
            extra: { name: "USD₮0", version: "1" }
          }],
          description: "Cortex: recall_memory — retrieve and verify a stored memory. Requires query param or JSON body: id (string).",
          mimeType: "application/json"
        },
        "GET /memory/recall/:id": {
          accepts: [{
            scheme: "exact",
            network: NETWORK,
            payTo: PAY_TO,
            price: PRICE_RECALL,
            extra: { name: "USD₮0", version: "1" }
          }],
          description: "Cortex: recall_memory — retrieve and verify a stored memory",
          mimeType: "application/json"
        },
        "POST /memory/query": {
          accepts: [{
            scheme: "exact",
            network: NETWORK,
            payTo: PAY_TO,
            price: PRICE_QUERY,
            extra: { name: "USD₮0", version: "1" }
          }],
          description: "Cortex: query_memory — search an agent's memory history. Requires agent_id (string).",
          mimeType: "application/json"
        },
        "GET /memory/query": {
          accepts: [{
            scheme: "exact",
            network: NETWORK,
            payTo: PAY_TO,
            price: PRICE_QUERY,
            extra: { name: "USD₮0", version: "1" }
          }],
          description: "Cortex: query_memory — search an agent's memory history. Requires agent_id (string).",
          mimeType: "application/json"
        },
        "POST /memory/digest": {
          accepts: [{
            scheme: "exact",
            network: NETWORK,
            payTo: PAY_TO,
            price: PRICE_DIGEST,
            extra: { name: "USD₮0", version: "1" }
          }],
          description: "Cortex: get_memory_digest — generate a compressed summary of memory history. Requires agent_id (string).",
          mimeType: "application/json"
        },
        "GET /memory/digest": {
          accepts: [{
            scheme: "exact",
            network: NETWORK,
            payTo: PAY_TO,
            price: PRICE_DIGEST,
            extra: { name: "USD₮0", version: "1" }
          }],
          description: "Cortex: get_memory_digest — generate a compressed summary of memory history. Requires agent_id (string).",
          mimeType: "application/json"
        },
        "POST /memory/my-agents": {
          accepts: [{
            scheme: "exact",
            network: NETWORK,
            payTo: PAY_TO,
            price: PRICE_AGENTS,
            extra: { name: "USD₮0", version: "1" }
          }],
          description: "Cortex: list_my_agents — list all namespaced agent IDs claimed/owned by an EVM wallet. Pass wallet (0x address) to look up any wallet directly; omitted, it uses the x402 payer's own wallet.",
          mimeType: "application/json"
        },
        "GET /memory/my-agents": {
          accepts: [{
            scheme: "exact",
            network: NETWORK,
            payTo: PAY_TO,
            price: PRICE_AGENTS,
            extra: { name: "USD₮0", version: "1" }
          }],
          description: "Cortex: list_my_agents — list all namespaced agent IDs claimed/owned by an EVM wallet. Pass wallet (0x address) to look up any wallet directly; omitted, it uses the x402 payer's own wallet.",
          mimeType: "application/json"
        },
        "POST /mcp": {
          accepts: MCP_ACCEPTS,
          description: "Cortex Multi-Agent Memory & Digest MCP server",
          mimeType: "application/json"
        }
        // GET /mcp is intentionally NOT payment-gated: mcpHttp.js's GET handler
        // always returns the same static info blob regardless of input — there
        // is no code path where it does real work, so (unlike GET /memory/write)
        // there's no legitimate case for charging it.
      },
      resourceServer
    );
  } catch (err) {
    // Module load error or unexpected failure — use stub, NOT silent pass-through.
    console.error(`[x402] Fatal initialization error (${err.message}). Installing stub 402 middleware.`);
    return buildStub402Middleware(
      process.env.X402_NETWORK || "eip155:196",
      process.env.PAY_TO_ADDRESS || ""
    );
  }
}

// Protected path prefixes that must never be reachable without a valid payment.
const PROTECTED_PATH_PREFIXES = ["/memory/", "/mcp"];

const paymentMwReady = getPaymentMiddleware()
  .then((mw) => {
    realPaymentMw = mw;
  })
  .catch((err) => {
    console.error("[x402] Unhandled error in payment middleware init:", err.message);
    // Stub instead of pass-through — keeps the endpoint x402-compliant under all failures.
    realPaymentMw = buildStub402Middleware(
      process.env.X402_NETWORK || "eip155:196",
      process.env.PAY_TO_ADDRESS || ""
    );
  });

// /memory/my-agents discovery gate — different shape from the others above,
// because this route can succeed with ZERO explicit params: the x402
// payment itself supplies the caller's wallet. That's the route's normal,
// valid path, not an incomplete probe, so "no params" must NOT be treated
// as free discovery here — doing so would make the endpoint free for its
// primary use case. Instead, only pre-empt requests that are guaranteed to
// fail regardless of payment: an explicitly supplied but malformed wallet,
// or (when CALLER_AUTH_ENFORCED=true) no signature supplied at all.
app.use((req, res, next) => {
  if (req.path !== "/memory/my-agents") return next();

  // Merge query + body — don't assume params only arrive in req.body for
  // non-GET requests.
  const source = { ...(req.query || {}), ...(req.body || {}) };
  const normalized = memoryRoutes.normalize(source, {
    ...memoryRoutes.AUTH_ALIASES,
    ...memoryRoutes.MY_AGENTS_ALIASES
  });

  if (normalized.wallet && !memoryRoutes.WALLET_ADDRESS_RE.test(normalized.wallet)) {
    return res.status(400).json({
      service: "cortex-list-my-agents",
      error: "invalid_wallet",
      info: "wallet must be a 0x-prefixed, 40-hex-character EVM address."
    });
  }

  if (process.env.CALLER_AUTH_ENFORCED === "true" && !(normalized.auth_signature && normalized.auth_timestamp)) {
    return res.status(401).json({
      service: "cortex-list-my-agents",
      error: "missing_auth",
      info: "auth_signature and auth_timestamp are required when CALLER_AUTH_ENFORCED=true."
    });
  }

  next();
});

// MCP discovery gate — same principle, JSON-RPC shaped. The MCP transport
// (mcpHttp.js) reports tool errors — including "missing required argument"
// validation failures — inside the JSON-RPC response body (isError: true),
// never as an HTTP status. The payment SDK only skips settlement when
// res.statusCode >= 400, so without this gate EVERY failed tools/call (all 5
// tools share this one endpoint) would still get charged. Confirmed by
// testing: an incomplete write_memory call returns HTTP 200 with the error
// embedded in the body. Anything that isn't a well-formed, fully-argued
// tools/call is answered for free here, before the paywall ever sees it.
app.use((req, res, next) => {
  if (req.path !== "/mcp" || req.method !== "POST") return next();

  const body = req.body;
  const rpcId = body && body.id !== undefined ? body.id : null;

  if (!body || body.method !== "tools/call") {
    // Handshake / tools-list / anything else that isn't a real tool
    // invocation yet — no business action requested, so no charge.
    return res.status(200).json({
      jsonrpc: "2.0",
      id: rpcId,
      result: {
        content: [{
          type: "text",
          text: "Cortex MCP: send a tools/call request with { name, arguments } to run a tool. A valid x402 payment header is required once the required arguments are included."
        }]
      }
    });
  }

  const toolName = body.params && body.params.name;
  const args = (body.params && body.params.arguments) || {};
  const required = TOOL_REQUIRED_FIELDS[toolName];

  if (required) {
    const missing = required.filter((key) => args[key] === undefined || args[key] === "");
    if (missing.length > 0) {
      return res.status(200).json({
        jsonrpc: "2.0",
        id: rpcId,
        result: {
          content: [{
            type: "text",
            text: `Missing required argument(s) for ${toolName}: ${missing.join(", ")}. A valid x402 payment header is required once they're included.`
          }],
          isError: true
        }
      });
    }
  }
  // Unknown tool name falls through unchanged — the real MCP handler already
  // produces the correct "tool not found" error for that case.

  next();
});

app.use((req, res, next) => {
  if (realPaymentMw) return realPaymentMw(req, res, next);

  // Payment middleware still initializing — block protected paths to prevent
  // any free access during the startup window.
  if (PAYMENTS_ENFORCED && PROTECTED_PATH_PREFIXES.some(p =>
    req.path === p.slice(0, -1) || req.path.startsWith(p)
  )) {
    return res.status(503).json({ error: "Service starting up, please retry in a few seconds." });
  }

  paymentMwReady.then(() => realPaymentMw(req, res, next)).catch(next);
});

// Runs only for requests that already cleared the payment middleware above
// (or that didn't need to). Recovers the payer's wallet address from the
// same PAYMENT-SIGNATURE header the middleware already verified, so routes
// can identify "whose wallet paid for this call" without a second,
// hand-rolled signature scheme.
app.use((req, res, next) => {
  req.payerAddress = extractPayerAddress(req);
  next();
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

// ─── A2A provider daemon ──────────────────────────────────────────────────────
// Starts the XMTP watch loop so Agent #4961 can receive marketplace tasks.
// Only active when OKX_A2A_AGENT_ID is set (i.e. on Railway, not local dev).
if (process.env.OKX_A2A_AGENT_ID) {
  const { startA2AWorker } = require("./a2aWorker");
  startA2AWorker();
} else {
  console.log("[a2aWorker] OKX_A2A_AGENT_ID not set — A2A daemon disabled (local dev mode).");
}
