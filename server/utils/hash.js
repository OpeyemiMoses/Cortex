const crypto = require("crypto");

/**
 * Canonical content hash for a memory payload — this becomes the
 * memory's permanent `id`. Sorting keys before hashing means the same
 * logical content always produces the same id regardless of key order.
 */
function canonicalHash(payload) {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

module.exports = { canonicalHash };
