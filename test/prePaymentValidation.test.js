const assert = require("assert");
const http = require("http");
const express = require("express");
const { prePaymentValidator } = require("../server/middleware/prePaymentValidator");

async function runTests() {
  console.log("=== Running Pre-Payment Validation Tests ===");

  // Create a minimal test Express app mimicking server/index.js order
  const app = express();
  app.use(express.json());

  // Mount prePaymentValidator first
  app.use(prePaymentValidator);

  // Mock x402 payment middleware (simulating realPaymentMw returning 402 if unpaid)
  app.use((req, res, next) => {
    if (req.headers["payment-signature"]) {
      return next();
    }
    // Returns 402 challenge if payment middleware is reached
    return res.status(402).json({
      error: "Payment required",
      x402Version: 2,
      service: "mock-x402"
    });
  });

  // Mock downstream route handlers (if payment succeeds)
  app.post("/memory/write", (req, res) => res.status(201).json({ status: "written" }));
  app.get("/memory/write", (req, res) => res.status(201).json({ status: "written" }));
  app.post("/memory/recall", (req, res) => res.status(200).json({ status: "recalled" }));
  app.get("/memory/recall", (req, res) => res.status(200).json({ status: "recalled" }));
  app.get("/memory/recall/:id", (req, res) => res.status(200).json({ status: "recalled", id: req.params.id }));
  app.get("/memory/query", (req, res) => res.status(200).json({ status: "queried" }));
  app.post("/memory/query", (req, res) => res.status(200).json({ status: "queried" }));
  app.get("/memory/digest", (req, res) => res.status(200).json({ status: "digested" }));
  app.post("/memory/digest", (req, res) => res.status(200).json({ status: "digested" }));
  app.post("/mcp", (req, res) => res.status(200).json({ status: "mcp_called" }));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function request(method, path, body = null) {
    const url = new URL(path, baseUrl);
    const headers = {};
    if (body) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(url.toString(), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });

    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  }

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(err);
      failed++;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Test Suite 1: Write Memory validation BEFORE payment (Issue #1 in delisting)
  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n1. Write Memory Pre-Payment Tests:");

  await test("POST /memory/write with empty body returns 400 Bad Request (NOT 402)", async () => {
    const res = await request("POST", "/memory/write", {});
    assert.strictEqual(res.status, 400, `Expected 400, got ${res.status}`);
    assert.strictEqual(res.data.service, "cortex-write-memory");
    assert(res.data.error.includes("Invalid memory object"));
  });

  await test("POST /memory/write with missing content returns 400 Bad Request", async () => {
    const res = await request("POST", "/memory/write", {
      agent_id: "test-agent",
      type: "decision"
    });
    assert.strictEqual(res.status, 400, `Expected 400, got ${res.status}`);
    assert.strictEqual(res.data.service, "cortex-write-memory");
  });

  await test("POST /memory/write with invalid type returns 400 Bad Request", async () => {
    const res = await request("POST", "/memory/write", {
      agent_id: "test-agent",
      type: "invalid_type",
      content: "some content"
    });
    assert.strictEqual(res.status, 400, `Expected 400, got ${res.status}`);
  });

  await test("GET /memory/write with no query params returns 400 Bad Request (NOT 402)", async () => {
    const res = await request("GET", "/memory/write");
    assert.strictEqual(res.status, 400, `Expected 400, got ${res.status}`);
    assert.strictEqual(res.data.service, "cortex-write-memory");
  });

  await test("POST /memory/write with VALID parameters reaches payment middleware (returns 402 when unpaid)", async () => {
    const res = await request("POST", "/memory/write", {
      agent_id: "test-agent",
      type: "event",
      content: "Executed a trade for 100 USDC"
    });
    assert.strictEqual(res.status, 402, `Expected 402 for valid unpaid request, got ${res.status}`);
    assert.strictEqual(res.data.x402Version, 2);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test Suite 2: Recall Memory validation BEFORE payment (Issue #2 in delisting)
  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n2. Recall Memory Pre-Payment Tests:");

  await test("POST /memory/recall with empty body returns 400 Bad Request (NOT 402)", async () => {
    const res = await request("POST", "/memory/recall", {});
    assert.strictEqual(res.status, 400, `Expected 400, got ${res.status}`);
    assert.strictEqual(res.data.service, "cortex-recall-memory");
    assert.strictEqual(res.data.error, "missing_params");
  });

  await test("GET /memory/recall with no query params returns 400 Bad Request (NOT 402)", async () => {
    const res = await request("GET", "/memory/recall");
    assert.strictEqual(res.status, 400, `Expected 400, got ${res.status}`);
    assert.strictEqual(res.data.service, "cortex-recall-memory");
  });

  await test("POST /memory/recall with VALID id reaches payment middleware (returns 402 when unpaid)", async () => {
    const res = await request("POST", "/memory/recall", { id: "mem_abc123" });
    assert.strictEqual(res.status, 402, `Expected 402 for valid unpaid request, got ${res.status}`);
  });

  await test("GET /memory/recall/:id with VALID id in path reaches payment middleware (returns 402 when unpaid)", async () => {
    const res = await request("GET", "/memory/recall/mem_abc123");
    assert.strictEqual(res.status, 402, `Expected 402 for valid unpaid request, got ${res.status}`);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test Suite 3: Query & Digest & My-Agents Pre-Payment Tests
  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n3. Query, Digest & My-Agents Pre-Payment Tests:");

  await test("GET /memory/query without agent_id returns 400 Bad Request (NOT 402)", async () => {
    const res = await request("GET", "/memory/query");
    assert.strictEqual(res.status, 400, `Expected 400, got ${res.status}`);
    assert.strictEqual(res.data.service, "cortex-query-memory");
  });

  await test("GET /memory/query with invalid type returns 400 Bad Request", async () => {
    const res = await request("GET", "/memory/query?agent_id=my-agent&type=unknown_type");
    assert.strictEqual(res.status, 400, `Expected 400, got ${res.status}`);
    assert.strictEqual(res.data.service, "cortex-query-memory");
  });

  await test("GET /memory/query with valid agent_id reaches payment middleware (returns 402 when unpaid)", async () => {
    const res = await request("GET", "/memory/query?agent_id=my-agent");
    assert.strictEqual(res.status, 402, `Expected 402 for valid unpaid request, got ${res.status}`);
  });

  await test("GET /memory/digest without agent_id returns 400 Bad Request (NOT 402)", async () => {
    const res = await request("GET", "/memory/digest");
    assert.strictEqual(res.status, 400, `Expected 400, got ${res.status}`);
    assert.strictEqual(res.data.service, "cortex-memory-digest");
  });

  await test("GET /memory/digest with valid agent_id reaches payment middleware (returns 402 when unpaid)", async () => {
    const res = await request("GET", "/memory/digest?agent_id=my-agent");
    assert.strictEqual(res.status, 402, `Expected 402 for valid unpaid request, got ${res.status}`);
  });

  await test("GET /memory/my-agents with invalid wallet returns 400 Bad Request", async () => {
    const res = await request("GET", "/memory/my-agents?wallet=invalid_addr");
    assert.strictEqual(res.status, 400, `Expected 400, got ${res.status}`);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test Suite 4: MCP tools/call Pre-Payment Tests
  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n4. MCP Pre-Payment Tests:");

  await test("POST /mcp with tools/list returns 200 without payment charge", async () => {
    const res = await request("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.strictEqual(res.status, 200);
  });

  await test("POST /mcp with incomplete tools/call write_memory returns 200 isError without charging", async () => {
    const res = await request("POST", "/mcp", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "write_memory",
        arguments: { agent_id: "test" } // missing type and content
      }
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.result.isError, true);
    assert(res.data.result.content[0].text.includes("Missing required argument(s)"));
  });

  await test("POST /mcp with complete tools/call write_memory reaches payment middleware (returns 402)", async () => {
    const res = await request("POST", "/mcp", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "write_memory",
        arguments: { agent_id: "test", type: "event", content: "hello" }
      }
    });
    assert.strictEqual(res.status, 402);
  });

  server.close();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
