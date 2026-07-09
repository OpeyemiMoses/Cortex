const fs = require("fs");
const crypto = require("crypto");
const Arweave = require("arweave");
const { canonicalHash } = require("../../utils/hash");

/**
 * Host is configurable so the same code can point at:
 *  - arweave.net (real mainnet — costs real AR, permanent)
 *  - a local arlocal instance (localhost:1984 — free, in-memory, for dev)
 *
 * For the hackathon build/test loop, run arlocal locally and point
 * ARWEAVE_HOST=localhost / ARWEAVE_PORT=1984 / ARWEAVE_PROTOCOL=http
 * at it. See README "Local dev with arlocal" for the full setup —
 * this avoids spending real AR while iterating.
 */
const arweave = Arweave.init({
  host: process.env.ARWEAVE_HOST || "arweave.net",
  port: process.env.ARWEAVE_PORT || 443,
  protocol: process.env.ARWEAVE_PROTOCOL || "https",
  timeout: 20000
});

let _walletKey = null;

function loadWallet() {
  if (_walletKey) return _walletKey;

  // Prefer an inline JSON env var (used on platforms like Railway where
  // the gitignored keyfile isn't present on disk) over the file path.
  const walletJson = process.env.ARWEAVE_WALLET_JSON;
  if (walletJson) {
    _walletKey = JSON.parse(walletJson);
    return _walletKey;
  }

  const walletPath = process.env.ARWEAVE_WALLET_JSON_PATH;
  if (!walletPath || !fs.existsSync(walletPath)) {
    throw new Error(
      `Arweave wallet keyfile not found. Set ARWEAVE_WALLET_JSON_PATH to a local ` +
      `keyfile, or ARWEAVE_WALLET_JSON to the raw JWK JSON contents (used on ` +
      `platforms like Railway). Generate one with "npm run wallet:generate" if ` +
      `you don't have one yet, then fund it with AR (mainnet) or use the ` +
      `arlocal faucet (local dev) before writing memories.`
    );
  }

  _walletKey = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
  return _walletKey;
}

/**
 * Writes a memory payload as a tagged Arweave transaction.
 * Tags are what make `read()` possible without Cortex needing its own
 * database — anyone (including Cortex itself) can look up a memory by
 * its content-hash id via Arweave's public GraphQL endpoint.
 *
 * A per-write timestamp + random nonce are mixed in before hashing so two
 * writes with identical agent_id/type/content never collide on the same
 * id — two genuinely separate memories can have identical text (e.g. the
 * same decision made twice), and colliding ids would break the on-chain
 * registry's anchor() call, which rejects re-anchoring an existing hash.
 */
async function write(payload) {
  const written_at = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const storedPayload = { ...payload, written_at, _nonce: nonce };

  const id = canonicalHash(storedPayload);
  const key = loadWallet();
  const data = JSON.stringify(storedPayload);

  const tx = await arweave.createTransaction({ data }, key);
  tx.addTag("Content-Type", "application/json");
  tx.addTag("App-Name", "Cortex");
  tx.addTag("Cortex-Memory-Id", id);
  tx.addTag("Agent-Id", payload.agent_id);
  tx.addTag("Memory-Type", payload.type);

  await arweave.transactions.sign(tx, key);
  const response = await arweave.transactions.post(tx);

  if (response.status !== 200 && response.status !== 202) {
    throw new Error(`Arweave transaction post failed with status ${response.status}: ${JSON.stringify(response.data)}`);
  }

  return { id, arweave_tx_id: tx.id, written_at };
}

/**
 * Looks up a memory by its content-hash id via Arweave's GraphQL endpoint
 * (tag search on Cortex-Memory-Id), then fetches the transaction data.
 * Returns id + arweave_tx_id alongside the original payload fields so the
 * shape matches what write() returns — the internal `_nonce` used only
 * for hash uniqueness is stripped before returning.
 *
 * Note: on real mainnet, a freshly-posted transaction can take a few
 * minutes to be minable/queryable via GraphQL. arlocal confirms instantly,
 * which is another reason to develop against it first.
 */
async function read(id) {
  const graphqlEndpoint = `${process.env.ARWEAVE_PROTOCOL || "https"}://${process.env.ARWEAVE_HOST || "arweave.net"}${
    process.env.ARWEAVE_PORT && process.env.ARWEAVE_PORT !== "443" ? `:${process.env.ARWEAVE_PORT}` : ""
  }/graphql`;

  const query = `
    query($id: String!) {
      transactions(tags: [{ name: "Cortex-Memory-Id", values: [$id] }], first: 1) {
        edges { node { id } }
      }
    }
  `;

  const res = await fetch(graphqlEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { id } })
  });

  if (!res.ok) {
    throw new Error(`Arweave GraphQL query failed: ${res.status}`);
  }

  const json = await res.json();
  const edges = json?.data?.transactions?.edges || [];
  if (edges.length === 0) return null;

  const txId = edges[0].node.id;
  const txData = await arweave.transactions.getData(txId, { decode: true, string: true });
  const parsed = JSON.parse(txData);
  delete parsed._nonce;

  return { ...parsed, id, arweave_tx_id: txId };
}

module.exports = { write, read, canonicalHash };