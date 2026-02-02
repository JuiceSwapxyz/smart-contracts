// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title CompensationClaim
 * @notice Merkle-based airdrop contract for compensating users affected by interchain swap issues.
 * @dev Users can claim their allocated JUSD and TAPFREAK tokens using a Merkle proof.
 *      Each address can only claim once.
 */
contract CompensationClaim is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice JUSD token contract
    IERC20 public immutable jusd;

    /// @notice TAPFREAK token contract
    IERC20 public immutable tapfreak;

    /// @notice Merkle root for verifying claims
    bytes32 public merkleRoot;

    /// @notice Amount of JUSD each user can claim (in wei, 18 decimals)
    uint256 public jusdAmountPerClaim;

    /// @notice Amount of TAPFREAK each user can claim (in wei, 18 decimals)
    uint256 public tapfreakAmountPerClaim;

    /// @notice Tracks whether an address has already claimed
    mapping(address => bool) public hasClaimed;

    /// @notice Total number of claims made
    uint256 public totalClaims;

    /// @notice Deadline after which claims are no longer possible (0 = no deadline)
    uint256 public claimDeadline;

    /// @notice Emitted when a user successfully claims their compensation
    event Claimed(address indexed user, uint256 jusdAmount, uint256 tapfreakAmount);

    /// @notice Emitted when the merkle root is updated
    event MerkleRootUpdated(bytes32 oldRoot, bytes32 newRoot);

    /// @notice Emitted when claim amounts are updated
    event ClaimAmountsUpdated(uint256 jusdAmount, uint256 tapfreakAmount);

    /// @notice Emitted when tokens are withdrawn by owner
    event TokensWithdrawn(address token, uint256 amount);

    /// @notice Emitted when deadline is updated
    event DeadlineUpdated(uint256 newDeadline);

    error AlreadyClaimed();
    error InvalidProof();
    error ClaimPeriodEnded();
    error ClaimPeriodNotEnded();
    error InsufficientJusdBalance();
    error InsufficientTapfreakBalance();
    error ZeroAddress();

    /**
     * @notice Creates a new CompensationClaim contract
     * @param _jusd Address of the JUSD token contract
     * @param _tapfreak Address of the TAPFREAK token contract
     * @param _merkleRoot Initial merkle root for claim verification
     * @param _jusdAmount Amount of JUSD per claim (in wei)
     * @param _tapfreakAmount Amount of TAPFREAK per claim (in wei)
     * @param _claimDeadline Unix timestamp deadline (0 for no deadline)
     */
    constructor(
        address _jusd,
        address _tapfreak,
        bytes32 _merkleRoot,
        uint256 _jusdAmount,
        uint256 _tapfreakAmount,
        uint256 _claimDeadline
    ) Ownable(msg.sender) {
        if (_jusd == address(0) || _tapfreak == address(0)) revert ZeroAddress();

        jusd = IERC20(_jusd);
        tapfreak = IERC20(_tapfreak);
        merkleRoot = _merkleRoot;
        jusdAmountPerClaim = _jusdAmount;
        tapfreakAmountPerClaim = _tapfreakAmount;
        claimDeadline = _claimDeadline;
    }

    /**
     * @notice Claim compensation tokens using a Merkle proof
     * @param proof Merkle proof verifying the caller is in the whitelist
     */
    function claim(bytes32[] calldata proof) external nonReentrant {
        // Check deadline
        if (claimDeadline != 0 && block.timestamp > claimDeadline) {
            revert ClaimPeriodEnded();
        }

        // Check if already claimed
        if (hasClaimed[msg.sender]) {
            revert AlreadyClaimed();
        }

        // Verify Merkle proof
        bytes32 leaf = keccak256(abi.encodePacked(msg.sender));
        if (!MerkleProof.verify(proof, merkleRoot, leaf)) {
            revert InvalidProof();
        }

        // Check contract has sufficient balance
        if (jusd.balanceOf(address(this)) < jusdAmountPerClaim) {
            revert InsufficientJusdBalance();
        }
        if (tapfreak.balanceOf(address(this)) < tapfreakAmountPerClaim) {
            revert InsufficientTapfreakBalance();
        }

        // Mark as claimed
        hasClaimed[msg.sender] = true;
        totalClaims++;

        // Transfer tokens
        jusd.safeTransfer(msg.sender, jusdAmountPerClaim);
        tapfreak.safeTransfer(msg.sender, tapfreakAmountPerClaim);

        emit Claimed(msg.sender, jusdAmountPerClaim, tapfreakAmountPerClaim);
    }

    /**
     * @notice Check if an address can claim (is in whitelist and hasn't claimed)
     * @param user Address to check
     * @param proof Merkle proof for the address
     * @return eligible Whether the address can claim
     * @return reason Human-readable reason if cannot claim
     */
    function canClaim(
        address user,
        bytes32[] calldata proof
    ) external view returns (bool eligible, string memory reason) {
        if (claimDeadline != 0 && block.timestamp > claimDeadline) {
            return (false, "Claim period ended");
        }
        if (hasClaimed[user]) {
            return (false, "Already claimed");
        }
        bytes32 leaf = keccak256(abi.encodePacked(user));
        if (!MerkleProof.verify(proof, merkleRoot, leaf)) {
            return (false, "Not eligible");
        }
        if (jusd.balanceOf(address(this)) < jusdAmountPerClaim) {
            return (false, "Insufficient JUSD in contract");
        }
        if (tapfreak.balanceOf(address(this)) < tapfreakAmountPerClaim) {
            return (false, "Insufficient TAPFREAK in contract");
        }
        return (true, "Eligible to claim");
    }

    /**
     * @notice Verify if an address is in the merkle tree
     * @param user Address to verify
     * @param proof Merkle proof for the address
     * @return isValid Whether the proof is valid
     */
    function verifyProof(address user, bytes32[] calldata proof) external view returns (bool isValid) {
        bytes32 leaf = keccak256(abi.encodePacked(user));
        return MerkleProof.verify(proof, merkleRoot, leaf);
    }

    // ============ Owner Functions ============

    /**
     * @notice Update the merkle root (only owner)
     * @param _newRoot New merkle root
     */
    function setMerkleRoot(bytes32 _newRoot) external onlyOwner {
        bytes32 oldRoot = merkleRoot;
        merkleRoot = _newRoot;
        emit MerkleRootUpdated(oldRoot, _newRoot);
    }

    /**
     * @notice Update claim amounts (only owner)
     * @param _jusdAmount New JUSD amount per claim
     * @param _tapfreakAmount New TAPFREAK amount per claim
     */
    function setClaimAmounts(uint256 _jusdAmount, uint256 _tapfreakAmount) external onlyOwner {
        jusdAmountPerClaim = _jusdAmount;
        tapfreakAmountPerClaim = _tapfreakAmount;
        emit ClaimAmountsUpdated(_jusdAmount, _tapfreakAmount);
    }

    /**
     * @notice Update claim deadline (only owner)
     * @param _newDeadline New deadline timestamp (0 to remove deadline)
     */
    function setDeadline(uint256 _newDeadline) external onlyOwner {
        claimDeadline = _newDeadline;
        emit DeadlineUpdated(_newDeadline);
    }

    /**
     * @notice Withdraw unclaimed tokens after deadline (only owner)
     * @param token Token address to withdraw
     * @param amount Amount to withdraw
     */
    function withdrawTokens(address token, uint256 amount) external onlyOwner {
        // Only allow withdrawal after deadline (if set)
        if (claimDeadline != 0 && block.timestamp <= claimDeadline) {
            revert ClaimPeriodNotEnded();
        }
        IERC20(token).safeTransfer(owner(), amount);
        emit TokensWithdrawn(token, amount);
    }

    /**
     * @notice Emergency withdraw all tokens (only owner, bypasses deadline)
     * @dev Use with caution - this will prevent users from claiming
     */
    function emergencyWithdraw() external onlyOwner {
        uint256 jusdBalance = jusd.balanceOf(address(this));
        uint256 tapfreakBalance = tapfreak.balanceOf(address(this));

        if (jusdBalance > 0) {
            jusd.safeTransfer(owner(), jusdBalance);
            emit TokensWithdrawn(address(jusd), jusdBalance);
        }
        if (tapfreakBalance > 0) {
            tapfreak.safeTransfer(owner(), tapfreakBalance);
            emit TokensWithdrawn(address(tapfreak), tapfreakBalance);
        }
    }

    // ============ View Functions ============

    /**
     * @notice Get contract token balances
     * @return jusdBalance Current JUSD balance
     * @return tapfreakBalance Current TAPFREAK balance
     */
    function getBalances() external view returns (uint256 jusdBalance, uint256 tapfreakBalance) {
        return (jusd.balanceOf(address(this)), tapfreak.balanceOf(address(this)));
    }

    /**
     * @notice Calculate how many claims can still be made with current balance
     * @return possibleClaims Number of complete claims possible
     */
    function remainingClaimCapacity() external view returns (uint256 possibleClaims) {
        uint256 jusdClaims = jusdAmountPerClaim > 0
            ? jusd.balanceOf(address(this)) / jusdAmountPerClaim
            : type(uint256).max;
        uint256 tapfreakClaims = tapfreakAmountPerClaim > 0
            ? tapfreak.balanceOf(address(this)) / tapfreakAmountPerClaim
            : type(uint256).max;
        return jusdClaims < tapfreakClaims ? jusdClaims : tapfreakClaims;
    }
}
