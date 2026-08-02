/**
 * Cortex A2A Provider Worker
 *
 * Runs as a background process within the Cortex HTTP server (launched from
 * server/index.js via `require('./a2aWorker')`).
 *
 * Responsibilities:
 *  1. Spin up a long-running `onchainos agent watch --role asp` listener so the
 *     Cortex ASP (agent #4961) receives job_created / job_accepted / job_disputed
 *     events from the OKX.AI marketplace over XMTP.
 *  2. On each event, call `onchainos agent next-action --role auto` to get the
 *     exact script to execute (the CLI owns the state-machine logic).
 *  3. Parse the returned script, execute each CLI command in order.
 *  4. When a `deliver` command is emitted by next-action, intercept it to:
 *     a. Execute the actual memory write via memoryService.
 *     b. Attach the result as the deliverable content.
 *
 * Environment variables required on Railway:
 *   OKX_A2A_AGENT_ID   — the ASP agent ID (4961)
 *   OKX_A2A_PRIVATE_KEY — XMTP private key for agent 4961
 *     (export from local machine: okx-a2a session gen-key ... or from onchainos agent identity)
 *
 * All other env vars (ARWEAVE_*, REDIS_URL, OKX_API_*, etc.) are already set.
 */

"use strict";

const { execFile, spawn } = require("child_process");
const path = require("path");
const memoryService = require("./services/memoryService");

// ─── Config ──────────────────────────────────────────────────────────────────

const ASP_AGENT_ID = process.env.OKX_A2A_AGENT_ID || "4961";
const ONCHAINOS_BIN = process.env.ONCHAINOS_BIN || "onchainos";

// How long (ms) to wait before restarting the watch loop after an error.
const RESTART_DELAY_MS = 15_000;

// ─── Utility: run a single onchainos command ─────────────────────────────────

/**
 * @param {string[]} args
 * @param {number}   timeoutMs
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function runOnchainos(args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    execFile(ONCHAINOS_BIN, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(`onchainos ${args[0]} failed (exit ${err.code}): ${stderr || err.message}`);
        e.stdout = stdout;
        e.stderr = stderr;
        return reject(e);
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

// ─── Parse serviceParams ──────────────────────────────────────────────────────

/**
 * Converts serviceParams into a structured object for memoryService.writeMemory().
 * Accepts either a JSON object string (e.g. from a task created with a raw
 * JSON --service-params body) or the flat "agentId: X; memoryType: Y; ..."
 * string the marketplace's natural-language param extraction produces.
 *
 * @param {string} raw
 * @returns {{ agent_id, type, content, visibility }}
 */
function parseServiceParams(raw) {
  const map = {};
  if (!raw) return map;

  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      Object.assign(map, JSON.parse(trimmed));
    } catch {
      // Not valid JSON despite the leading brace — fall through to the
      // semicolon-delimited parser below.
    }
  }

  if (Object.keys(map).length === 0) {
    raw.split(";").forEach((pair) => {
      const idx = pair.indexOf(":");
      if (idx < 0) return;
      const key = pair.slice(0, idx).trim();
      const val = pair.slice(idx + 1).trim();
      map[key] = val;
    });
  }

  return {
    agent_id:     map["agentId"]     || map["agent_id"]     || "",
    type:         map["memoryType"]  || map["type"]          || "event",
    content:      map["memoryContent"] || map["content"]     || "",
    visibility:   map["visibility"]  || "private",
    notify_email: map["notifyEmail"] || map["notify_email"] || map["email"] || undefined,
    metadata:     {},
    tags:         [],
  };
}

// ─── Handle a single system event envelope ───────────────────────────────────

/**
 * Runs `onchainos agent next-action` for an inbound envelope, parses the
 * returned script, and executes each command.
 *
 * @param {object} envelope  Parsed JSON from the watch stream.
 */
async function handleEvent(envelope) {
  const { agentId, message } = envelope;
  if (!message) return;

  const msgStr = JSON.stringify(message);
  console.log(`[a2aWorker] event=${message.event} job=${message.jobId} agent=${agentId}`);

  let nextActionOut;
  try {
    const { stdout } = await runOnchainos([
      "agent", "next-action",
      "--role", "auto",
      "--agentId", agentId || ASP_AGENT_ID,
      "--message", msgStr,
    ], 90_000);
    nextActionOut = stdout;
  } catch (err) {
    console.error("[a2aWorker] next-action error:", err.message);
    return;
  }

  // next-action returns a JSON object: { script: [{command, args, description}], ... }
  let plan;
  try {
    plan = JSON.parse(nextActionOut);
  } catch {
    // Sometimes next-action returns human-readable text (e.g. "nothing to do")
    console.log("[a2aWorker] next-action text response:", nextActionOut.slice(0, 200));
    return;
  }

  const steps = plan.script || plan.steps || [];
  if (!steps.length) {
    console.log("[a2aWorker] next-action: no steps returned.");
    return;
  }

  for (const step of steps) {
    const { command, args = [], description = "" } = step;
    console.log(`[a2aWorker] step: ${description || command} ${args.join(" ")}`);

    // Special intercept: if the CLI wants us to deliver, we write memory first.
    if (command === "onchainos" && args[0] === "agent" && args[1] === "deliver") {
      await executeDeliver(args, message);
      continue;
    }

    // All other steps: run verbatim.
    try {
      const parts = command === "onchainos" ? args : [command, ...args];
      const bin   = command === "onchainos" ? ONCHAINOS_BIN : command;
      await runOnchainos(parts, 90_000);
    } catch (err) {
      console.error(`[a2aWorker] step failed: ${err.message}`);
      // Continue to subsequent steps — a single failure shouldn't stall the job.
    }
  }
}

// ─── Deliver: write memory then submit the result ────────────────────────────

/**
 * Writes the memory requested in serviceParams, then calls
 * `onchainos agent deliver` with the result as deliverable content.
 *
 * @param {string[]} deliverArgs  The args array from the next-action deliver step.
 * @param {object}   message      The original system event message.
 */
async function executeDeliver(deliverArgs, message) {
  const serviceParams = message.serviceParams || "";
  const jobId         = message.jobId || "";

  let deliverableContent = "Memory written successfully.";
  let memoryRecord;

  try {
    const payload = parseServiceParams(serviceParams);
    if (!payload.agent_id || !payload.content) {
      throw new Error(`Missing required fields in serviceParams: "${serviceParams}"`);
    }
    memoryRecord = await memoryService.writeMemory(payload, { skipAuth: true });
    deliverableContent = JSON.stringify({
      status:          "ok",
      id:              memoryRecord.id,
      arweave_tx:      memoryRecord.arweave_tx_id,
      ipfs_cid:        memoryRecord.ipfs_cid,
      onchain_tx:      memoryRecord.onchain_tx_hash,
      onchain_tx_link: memoryRecord.onchain_tx_link,
      x402_tx_hash:    memoryRecord.x402_tx_hash,
      x402_tx_link:    memoryRecord.x402_tx_link,
      written_at:      memoryRecord.written_at,
    });
    console.log(`[a2aWorker] memory written: id=${memoryRecord.id}`);
  } catch (err) {
    console.error("[a2aWorker] writeMemory failed:", err.message);
    deliverableContent = JSON.stringify({ status: "error", message: err.message });
  }

  // Replace the --content arg in the deliver args with our actual result,
  // or append it if not present.
  const contentIdx = deliverArgs.indexOf("--content");
  const finalArgs  = [...deliverArgs];
  if (contentIdx >= 0) {
    finalArgs[contentIdx + 1] = deliverableContent;
  } else {
    finalArgs.push("--content", deliverableContent);
  }

  // Ensure --job-id is present.
  if (!finalArgs.includes("--job-id") && jobId) {
    finalArgs.push("--job-id", jobId);
  }

  try {
    await runOnchainos(finalArgs, 90_000);
    console.log(`[a2aWorker] deliver submitted for job ${jobId}`);
  } catch (err) {
    console.error("[a2aWorker] deliver failed:", err.message);
  }
}

// ─── Watch loop ───────────────────────────────────────────────────────────────

/**
 * Starts `onchainos agent watch --role asp --agentId <id> --json` as a
 * long-lived child process.  Each newline-delimited JSON object from stdout
 * is dispatched to handleEvent().
 *
 * The loop auto-restarts after RESTART_DELAY_MS if the child exits.
 */
function startWatchLoop() {
  console.log(`[a2aWorker] starting watch loop (agentId=${ASP_AGENT_ID})`);

  const child = spawn(ONCHAINOS_BIN, [
    "agent", "watch",
    "--role",    "asp",
    "--agentId", ASP_AGENT_ID,
    "--json",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let buffer = "";

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep partial last line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let envelope;
      try {
        envelope = JSON.parse(trimmed);
      } catch {
        // non-JSON status line — log and skip
        console.log("[a2aWorker] watch:", trimmed.slice(0, 120));
        continue;
      }
      // Fire-and-forget per envelope; errors are caught inside handleEvent.
      handleEvent(envelope).catch((err) =>
        console.error("[a2aWorker] handleEvent uncaught:", err.message)
      );
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) console.log("[a2aWorker] watch stderr:", text.slice(0, 200));
  });

  child.on("exit", (code, signal) => {
    console.warn(`[a2aWorker] watch exited (code=${code} signal=${signal}), restarting in ${RESTART_DELAY_MS / 1000}s…`);
    setTimeout(startWatchLoop, RESTART_DELAY_MS);
  });

  child.on("error", (err) => {
    console.error("[a2aWorker] watch spawn error:", err.message);
    setTimeout(startWatchLoop, RESTART_DELAY_MS);
  });
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

/**
 * Called once from server/index.js.  Waits for the HTTP server to be ready
 * before starting the watch loop so Railway health checks don't time out.
 */
function startA2AWorker() {
  // Small delay so the HTTP layer fully binds first.
  setTimeout(() => {
    console.log("[a2aWorker] initializing Cortex A2A provider daemon…");
    startWatchLoop();
  }, 5_000);
}

module.exports = { startA2AWorker };
