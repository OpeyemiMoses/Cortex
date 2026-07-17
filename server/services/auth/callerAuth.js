const { ethers } = require("ethers");

const FRESHNESS_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

class CallerAuthError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "CallerAuthError";
    this.statusCode = statusCode;
  }
}

function buildWriteMessage(agentId, timestamp) {
  return `Cortex Auth\nwrite_memory: ${agentId}\ntimestamp: ${timestamp}`;
}

function buildReadMessage(target, timestamp) {
  return `Cortex Auth\nread_memory: ${target}\ntimestamp: ${timestamp}`;
}

function buildListAgentsMessage(timestamp) {
  return `Cortex Auth\nlist_my_agents\ntimestamp: ${timestamp}`;
}

function isNamespaced(agentId) {
  if (typeof agentId !== "string" || !agentId.includes(":")) {
    return false;
  }
  const parts = agentId.split(":");
  try {
    return ethers.isAddress(parts[0]);
  } catch {
    return false;
  }
}

function parseNamespaced(agentId) {
  if (!isNamespaced(agentId)) {
    return { wallet: null, name: agentId };
  }
  const parts = agentId.split(":");
  const wallet = parts[0].toLowerCase();
  const name = parts.slice(1).join(":");
  return { wallet, name };
}

function getNamespacedId(agentId, recoveredWallet) {
  if (isNamespaced(agentId)) {
    return agentId;
  }
  return `${recoveredWallet.toLowerCase()}:${agentId}`;
}

function verifySignature(message, signature, timestamp) {
  if (!signature || !timestamp) {
    throw new CallerAuthError(
      "auth_signature and auth_timestamp are required when CALLER_AUTH_ENFORCED=true.",
      401
    );
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    throw new CallerAuthError("auth_timestamp must be a unix millisecond timestamp.", 401);
  }

  const age = Date.now() - ts;
  if (age > FRESHNESS_WINDOW_MS || age < -30_000) {
    throw new CallerAuthError(
      "auth_timestamp is stale or in the future — sign a fresh timestamp and retry.",
      401
    );
  }

  try {
    const recovered = ethers.verifyMessage(message, signature);
    return recovered.toLowerCase();
  } catch (err) {
    throw new CallerAuthError("auth_signature is not a valid signature for this message.", 401);
  }
}

module.exports = {
  FRESHNESS_WINDOW_MS,
  CallerAuthError,
  buildWriteMessage,
  buildReadMessage,
  buildListAgentsMessage,
  isNamespaced,
  parseNamespaced,
  getNamespacedId,
  verifySignature
};
