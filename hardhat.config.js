require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/**
 * Chain IDs and default RPCs verified against X Layer's official docs
 * (web3.okx.com/xlayer/docs) as of this writing:
 *   Mainnet: chainId 196  — https://rpc.xlayer.tech
 *   Testnet: chainId 1952 — https://testrpc.xlayer.tech/terigon
 * Native gas token on both is OKB. Get free testnet OKB from the X Layer
 * faucet (0.01 OKB/day) before deploying to testnet.
 */
/**
 * Chain IDs and default RPCs verified against X Layer's official docs
 * (web3.okx.com/xlayer/docs) as of this writing:
 *   Mainnet: chainId 196  — https://rpc.xlayer.tech
 *   Testnet: chainId 1952 — https://testrpc.xlayer.tech/terigon
 * Native gas token on both is OKB. Get free testnet OKB from the X Layer
 * faucet (0.01 OKB/day) before deploying to testnet.
 */

/**
 * Auto-adds the 0x prefix if it's missing, and trims whitespace/quotes —
 * a bare or malformed key here silently produces accounts: [], which
 * hardhat/ethers surfaces later as a confusing "factory runner does not
 * support sending transactions" error instead of a clear one at config time.
 */
function deployerAccounts() {
  let key = process.env.REGISTRY_DEPLOYER_PRIVATE_KEY;
  if (!key) return [];

  key = key.trim().replace(/^["']|["']$/g, "");
  if (!key) return [];
  if (!key.startsWith("0x")) key = `0x${key}`;

  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    console.warn(
      `WARNING: REGISTRY_DEPLOYER_PRIVATE_KEY doesn't look like a valid 32-byte hex key ` +
      `(got length ${key.length}). Deployment will likely fail with an unhelpful ethers error.`
    );
  }

  return [key];
}

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 }
    }
  },
  networks: {
    xlayerTestnet: {
      url: process.env.XLAYER_RPC_URL || "https://testrpc.xlayer.tech/terigon",
      chainId: 1952,
      accounts: deployerAccounts()
    },
    xlayerMainnet: {
      url: process.env.XLAYER_RPC_URL || "https://rpc.xlayer.tech",
      chainId: 196,
      accounts: deployerAccounts()
    }
  }
};
