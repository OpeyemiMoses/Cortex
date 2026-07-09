const { ethers } = require("ethers");

const REGISTRY_ABI = [
  "function anchor(bytes32 memoryHash, bytes32 agentIdHash) external",
  "function verify(bytes32 memoryHash) external view returns (bool exists, bytes32 agentIdHash, address submitter, uint256 timestamp)"
];

let _contract = null;

/**
 * Converts a 64-char hex sha256 memory id into the bytes32 the contract expects.
 */
function idToBytes32(memoryId) {
  if (!/^[0-9a-f]{64}$/i.test(memoryId)) {
    throw new Error(`Memory id "${memoryId}" is not a 32-byte hex hash — cannot anchor on-chain.`);
  }
  return "0x" + memoryId;
}

function agentIdToHash(agentId) {
  return ethers.keccak256(ethers.toUtf8Bytes(agentId));
}

function getContract() {
  if (_contract) return _contract;

  const rpcUrl = process.env.XLAYER_RPC_URL;
  const privateKey = process.env.REGISTRY_DEPLOYER_PRIVATE_KEY;
  const address = process.env.REGISTRY_CONTRACT_ADDRESS;

  if (!rpcUrl || !privateKey || !address) {
    throw new Error(
      "On-chain registry not configured. Deploy contracts/CortexRegistry.sol first " +
      "(npx hardhat run scripts/deployRegistry.js --network xlayerTestnet), then set " +
      "XLAYER_RPC_URL, REGISTRY_DEPLOYER_PRIVATE_KEY, and REGISTRY_CONTRACT_ADDRESS in .env."
    );
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  _contract = new ethers.Contract(address, REGISTRY_ABI, wallet);
  return _contract;
}

/**
 * Anchors a memory's content hash on-chain. Note: the `submitter` recorded
 * on-chain is Cortex's own relayer wallet (since Cortex holds the key and
 * submits on the calling agent's behalf) — the agent's own id is recorded
 * as a keccak256 hash alongside it, not as the transaction sender.
 *
 * Idempotent by design: the contract reverts with "already anchored" if
 * this exact hash was anchored before (belt-and-suspenders — the storage
 * layer now mixes a timestamp+nonce into every hash specifically to avoid
 * this, but a retried request or genuine edge case could still collide).
 * Rather than fail the whole write over that, treat it as a non-fatal
 * outcome — the memory is provably anchored either way.
 */
async function anchor(agentId, memoryId) {
  const contract = getContract();
  const memoryHash = idToBytes32(memoryId);
  const agentIdHash = agentIdToHash(agentId);

  try {
    const tx = await contract.anchor(memoryHash, agentIdHash);
    const receipt = await tx.wait();
    return { onchain_tx_hash: receipt.hash };
  } catch (err) {
    const message = err?.reason || err?.shortMessage || err?.message || "";
    if (message.includes("already anchored")) {
      console.warn(`Memory ${memoryId} was already anchored on-chain — treating as success, not an error.`);
      return { onchain_tx_hash: null, already_anchored: true };
    }
    throw err;
  }
}

async function verify(memoryId) {
  const contract = getContract();
  const memoryHash = idToBytes32(memoryId);

  const [exists, agentIdHash, submitter, timestamp] = await contract.verify(memoryHash);
  if (!exists) return null;

  return {
    agentIdHash,
    submitter,
    timestamp: Number(timestamp) * 1000 // seconds -> ms
  };
}

module.exports = { anchor, verify, agentIdToHash, idToBytes32 };
