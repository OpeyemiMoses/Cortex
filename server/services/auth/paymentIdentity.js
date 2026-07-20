const { decodePaymentSignatureHeader } = require("@okxweb3/x402-core");

/**
 * The x402 payment middleware verifies the caller's PAYMENT-SIGNATURE header
 * before a protected route is ever reached, but doesn't forward the payer's
 * address to req. Since the same (already-verified) header is still on the
 * request, decode it again here to recover the payer address — no new
 * signature, no marketplace/listing change, just reading what the payment
 * itself already proved.
 */
function extractPayerAddress(req) {
  const header = req.header("payment-signature") || req.header("PAYMENT-SIGNATURE");
  if (!header) {
    console.log("[payerExtract-debug] no payment-signature header; headers present:", Object.keys(req.headers).join(","));
    return null;
  }

  try {
    const payload = decodePaymentSignatureHeader(header);
    const from = payload?.payload?.authorization?.from;
    console.log("[payerExtract-debug] decoded payload:", JSON.stringify(payload));
    return typeof from === "string" ? from.toLowerCase() : null;
  } catch (err) {
    console.log("[payerExtract-debug] decode failed:", err.message, "raw header:", header);
    return null;
  }
}

module.exports = { extractPayerAddress };
