// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title JuicerNFT
 * @notice Campaign NFT for active JuiceSwap users (post-launch loyalty drop).
 * @dev Signature-based claiming verified by the backend API; structurally
 *      identical to `FirstSqueezerNFT`, only the eligibility rules enforced
 *      off-chain by the signer differ.
 *
 * Eligibility (enforced server-side; the contract trusts the backend signer):
 *  - >= 10 confirmed JuiceSwap swaps from this address
 *  - >= $5 active deposit in JUSD savings
 *  - >= $5 active lending position denominated in JUSD
 *
 * Features:
 *  - One mint per address (enforced by `hasClaimed` mapping)
 *  - Campaign window bounded by immutable start/end timestamps
 *  - Signature verification by trusted backend signer
 *  - Static metadata URI (IPFS) shared by all minted tokens
 */
contract JuicerNFT is ERC721 {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    /// @notice Campaign start timestamp
    uint256 public immutable CAMPAIGN_START;

    /// @notice Campaign end timestamp
    uint256 public immutable CAMPAIGN_END;

    /// @notice Backend API signer address (verifies eligibility)
    address public immutable signer;

    /// @notice Base URI for token metadata (IPFS)
    string private _baseTokenURI;

    /// @notice Track claimed addresses (one NFT per address)
    mapping(address => bool) public hasClaimed;

    /// @notice Current token ID counter
    uint256 private _tokenIdCounter;

    /// @notice Emitted when an NFT is successfully claimed
    event NFTClaimed(address indexed claimer, uint256 indexed tokenId);

    /// @notice Campaign has not started yet
    error CampaignNotStarted();

    /// @notice Campaign has ended
    error CampaignEnded();

    /// @notice Address has already claimed
    error AlreadyClaimed();

    /// @notice Invalid signature from backend
    error InvalidSignature();

    /**
     * @notice Initialize the Juicer NFT contract
     * @param _signer Backend API signer address
     * @param baseTokenURI IPFS base URI for metadata
     * @param _campaignStart Campaign start timestamp
     * @param _campaignEnd Campaign end timestamp
     */
    constructor(
        address _signer,
        string memory baseTokenURI,
        uint256 _campaignStart,
        uint256 _campaignEnd
    ) ERC721("Juicer", "JUICER") {
        require(_signer != address(0), "Invalid signer address");
        require(_campaignStart < _campaignEnd, "Invalid campaign period");
        require(_campaignEnd > block.timestamp, "Campaign already ended");

        signer = _signer;
        _baseTokenURI = baseTokenURI;
        CAMPAIGN_START = _campaignStart;
        CAMPAIGN_END = _campaignEnd;
    }

    /**
     * @notice Claim Juicer NFT
     * @dev Requires valid signature from backend API confirming all eligibility conditions
     *      (>=10 swaps, >=$5 JUSD savings, >=$5 JUSD lending).
     * @param signature Backend signature proving the user satisfies the conditions
     */
    function claim(bytes memory signature) external {
        // Check campaign has started
        if (block.timestamp < CAMPAIGN_START) revert CampaignNotStarted();

        // Check campaign deadline
        if (block.timestamp > CAMPAIGN_END) revert CampaignEnded();

        // Check if already claimed
        if (hasClaimed[msg.sender]) revert AlreadyClaimed();

        // Verify signature from backend API
        bytes32 messageHash = keccak256(abi.encodePacked(address(this), block.chainid, msg.sender));
        bytes32 ethSignedHash = messageHash.toEthSignedMessageHash();
        address recovered = ethSignedHash.recover(signature);

        if (recovered != signer) revert InvalidSignature();

        // Mark as claimed
        hasClaimed[msg.sender] = true;

        // Increment token ID and mint
        _tokenIdCounter++;
        _safeMint(msg.sender, _tokenIdCounter);

        emit NFTClaimed(msg.sender, _tokenIdCounter);
    }

    /**
     * @notice Get token URI for a specific token
     * @dev All tokens share the same static metadata URI
     * @param tokenId Token ID to query
     * @return Token metadata URI
     */
    function tokenURI(uint256 tokenId)
        public
        view
        override
        returns (string memory)
    {
        _requireOwned(tokenId);
        return _baseTokenURI;
    }

    /**
     * @notice Get total number of NFTs minted
     * @return Total supply
     */
    function totalSupply() external view returns (uint256) {
        return _tokenIdCounter;
    }

    /**
     * @notice Base URI for computing tokenURI
     * @return Base URI string
     */
    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }
}
