// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title FirstSqueezerNFT
 * @notice Campaign NFT for early JuiceSwap supporters
 * @dev Signature-based claiming verified by backend API
 *
 * Features:
 * - One mint per address (enforced by hasClaimed mapping)
 * - Campaign ends October 31, 2025 (hardcoded deadline)
 * - Mints directly to user upon successful claim
 * - Signature verification by trusted backend signer
 * - Static metadata URI for all tokens (IPFS)
 */
contract FirstSqueezerNFT is ERC721 {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    /// @notice Campaign end timestamp (October 31, 2025 23:59:59 UTC)
    uint256 public constant CAMPAIGN_END = 1761955199;

    /// @notice Backend API signer address (verifies campaign completion)
    address public immutable signer;

    /// @notice Base URI for token metadata (IPFS)
    string private _baseTokenURI;

    /// @notice Track claimed addresses (one NFT per address)
    mapping(address => bool) public hasClaimed;

    /// @notice Current token ID counter
    uint256 private _tokenIdCounter;

    /// @notice Emitted when an NFT is successfully claimed
    event NFTClaimed(address indexed claimer, uint256 indexed tokenId);

    /// @notice Campaign has ended
    error CampaignEnded();

    /// @notice Address has already claimed
    error AlreadyClaimed();

    /// @notice Invalid signature from backend
    error InvalidSignature();

    /**
     * @notice Initialize the First Squeezer NFT contract
     * @param _signer Backend API signer address
     * @param baseTokenURI IPFS base URI for metadata
     */
    constructor(address _signer, string memory baseTokenURI)
        ERC721("First Squeezer", "SQUEEZER")
    {
        require(_signer != address(0), "Invalid signer address");
        signer = _signer;
        _baseTokenURI = baseTokenURI;
    }

    /**
     * @notice Claim First Squeezer NFT
     * @dev Requires valid signature from backend API confirming campaign completion
     * @param signature Backend signature proving user completed Twitter + Discord verification
     */
    function claim(bytes memory signature) external {
        // Check campaign deadline
        if (block.timestamp > CAMPAIGN_END) revert CampaignEnded();

        // Check if already claimed
        if (hasClaimed[msg.sender]) revert AlreadyClaimed();

        // Verify signature from backend API
        bytes32 messageHash = keccak256(abi.encodePacked(msg.sender));
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
