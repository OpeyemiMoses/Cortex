/**
 * Helper to construct X Layer transaction explorer links.
 * Supports both X Layer Mainnet (eip155:196) and X Layer Testnet (eip155:1952).
 */

function getExplorerTxLink(txHash) {
  if (!txHash || typeof txHash !== "string" || !txHash.startsWith("0x")) {
    return null;
  }

  const network = (process.env.X402_NETWORK || "").toLowerCase();
  const chainId = String(process.env.XLAYER_CHAIN_ID || "");
  const rpcUrl = (process.env.XLAYER_RPC_URL || "").toLowerCase();

  const isTestnet =
    network.includes("1952") ||
    network.includes("test") ||
    chainId === "1952" ||
    rpcUrl.includes("test");

  const baseUrl = isTestnet
    ? "https://www.okx.com/web3/explorer/xlayer-test/tx/"
    : "https://www.okx.com/web3/explorer/xlayer/tx/";

  return `${baseUrl}${txHash}`;
}

module.exports = { getExplorerTxLink };
