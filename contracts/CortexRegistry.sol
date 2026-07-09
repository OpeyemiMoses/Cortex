// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * CortexRegistry — deliberately minimal. It stores only what's needed to
 * prove a memory existed at a point in time and was submitted by Cortex's
 * relayer wallet on behalf of a given agent id. The actual memory content
 * lives on Arweave; this contract never sees it.
 *
 * Note on `agent`: because Cortex holds the wallet key and submits the
 * anchor transaction on behalf of whichever agent called write_memory,
 * `msg.sender` here is always Cortex's own relayer address — not the
 * calling agent's own wallet. The calling agent's identity (an arbitrary
 * string, e.g. "agent-1") is recorded as a hash so it can still be checked
 * without storing arbitrary-length strings on-chain.
 */
contract CortexRegistry {
    struct Anchor {
        bytes32 memoryHash;
        bytes32 agentIdHash;
        address submitter;
        uint256 timestamp;
        bool exists;
    }

    mapping(bytes32 => Anchor) private _anchors;

    event Anchored(
        bytes32 indexed memoryHash,
        bytes32 indexed agentIdHash,
        address indexed submitter,
        uint256 timestamp
    );

    /// @param memoryHash The content-hash id of the memory object (sha256, as bytes32).
    /// @param agentIdHash keccak256 hash of the calling agent's id string.
    function anchor(bytes32 memoryHash, bytes32 agentIdHash) external {
        require(!_anchors[memoryHash].exists, "CortexRegistry: already anchored");

        _anchors[memoryHash] = Anchor({
            memoryHash: memoryHash,
            agentIdHash: agentIdHash,
            submitter: msg.sender,
            timestamp: block.timestamp,
            exists: true
        });

        emit Anchored(memoryHash, agentIdHash, msg.sender, block.timestamp);
    }

    function verify(bytes32 memoryHash)
        external
        view
        returns (bool exists, bytes32 agentIdHash, address submitter, uint256 timestamp)
    {
        Anchor memory a = _anchors[memoryHash];
        return (a.exists, a.agentIdHash, a.submitter, a.timestamp);
    }
}
