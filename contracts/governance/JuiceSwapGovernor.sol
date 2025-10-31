// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./IEquity.sol";

/**
 * @title JuiceSwapGovernor
 * @notice Governance contract for JuiceSwap that integrates with JUICE/JUSD veto system.
 *
 * Anyone can propose changes by paying 1000 JUSD. If no veto is cast within the application
 * period by holders with 2% of voting power, the proposal can be executed.
 *
 * This contract owns the JuiceSwap Factory and ProxyAdmin, enabling decentralized governance
 * while maintaining the security of the JUICE ecosystem's proven veto mechanism.
 */
contract JuiceSwapGovernor is ReentrancyGuard {

    // ============ Constants ============

    uint256 public constant PROPOSAL_FEE = 1000 * 10**18; // 1000 JUSD
    uint256 public constant MIN_APPLICATION_PERIOD = 14 days;
    uint32 public constant QUORUM = 200; // 2% in basis points (200/10000 = 2%)

    // ============ Immutables ============

    IERC20 public immutable JUSD;
    IEquity public immutable JUICE;

    // ============ State Variables ============

    uint256 public proposalCount;

    struct Proposal {
        uint256 id;
        address proposer;
        address target;        // Contract to call (Factory, ProxyAdmin, FeeCollector, Pool, etc.)
        bytes data;            // Encoded function call
        uint256 applicationPeriod;
        uint256 executeAfter;  // Timestamp when proposal can be executed
        bool executed;
        bool vetoed;
        uint256 fee;
        string description;
    }

    enum ProposalState {
        NotFound,
        Pending,
        Ready,
        Vetoed,
        Executed
    }

    mapping(uint256 => Proposal) public proposals;

    // ============ Events ============

    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        address indexed target,
        bytes data,
        uint256 executeAfter,
        string description
    );

    event ProposalExecuted(uint256 indexed proposalId, address indexed executor);
    event ProposalVetoed(uint256 indexed proposalId, address indexed vetoer);
    event ProposalFeeCollected(uint256 indexed proposalId, uint256 amount);

    // ============ Errors ============

    error PeriodTooShort();
    error ProposalNotReady();
    error VetoPeriodEnded();
    error ProposalAlreadyExecuted();
    error ProposalIsVetoed();
    error ExecutionFailed();
    error ProposalNotFound();
    error InvalidAddress();

    // ============ Constructor ============

    constructor(address _jusd, address _juice) {
        if (_jusd == address(0)) revert InvalidAddress();
        if (_juice == address(0)) revert InvalidAddress();

        JUSD = IERC20(_jusd);
        JUICE = IEquity(_juice);
    }

    // ============ Core Functions ============

    /**
     * @notice Propose a governance action on JuiceSwap contracts
     * @param target The contract address to call (Factory, ProxyAdmin, FeeCollector, Pool)
     * @param data The encoded function call (e.g., abi.encodeWithSignature("setFeeProtocol(uint8,uint8)", 5, 5))
     * @param applicationPeriod How long to wait for veto (minimum 14 days)
     * @param description Human-readable description of the proposal
     */
    function propose(
        address target,  // Unrestricted - veto mechanism provides security
        bytes calldata data,
        uint256 applicationPeriod,
        string calldata description
    ) external returns (uint256 proposalId) {
        if (target == address(0)) revert InvalidAddress();
        if (applicationPeriod < MIN_APPLICATION_PERIOD) revert PeriodTooShort();

        // Transfer fee from proposer directly to JUICE equity (increases JUICE price!)
        JUSD.transferFrom(msg.sender, address(JUICE), PROPOSAL_FEE);

        proposalId = ++proposalCount;
        uint256 executeAfter = block.timestamp + applicationPeriod;

        proposals[proposalId] = Proposal({
            id: proposalId,
            proposer: msg.sender,
            target: target,
            data: data,
            applicationPeriod: applicationPeriod,
            executeAfter: executeAfter,
            executed: false,
            vetoed: false,
            fee: PROPOSAL_FEE,
            description: description
        });

        emit ProposalCreated(proposalId, msg.sender, target, data, executeAfter, description);
        emit ProposalFeeCollected(proposalId, PROPOSAL_FEE);
    }

    /**
     * @notice Execute a proposal after the application period if not vetoed
     * @param proposalId The ID of the proposal to execute
     */
    function execute(uint256 proposalId) external nonReentrant {
        Proposal storage proposal = proposals[proposalId];

        if (proposal.id == 0) revert ProposalNotFound();
        if (proposal.executed) revert ProposalAlreadyExecuted();
        if (proposal.vetoed) revert ProposalIsVetoed();
        if (block.timestamp < proposal.executeAfter) revert ProposalNotReady();

        proposal.executed = true;

        // Execute the proposal
        (bool success, ) = proposal.target.call(proposal.data);
        if (!success) revert ExecutionFailed();

        emit ProposalExecuted(proposalId, msg.sender);
    }

    /**
     * @notice Veto a proposal (requires 2% voting power)
     * @param proposalId The ID of the proposal to veto
     * @param helpers Addresses that delegated their votes to msg.sender (incrementally sorted, no duplicates)
     *
     * @dev This integrates with JUICE voting power from the Equity contract.
     * The vetoer must have at least 2% of the total votes (holding-period-weighted).
     * You can include delegates who have delegated their votes to you.
     */
    function veto(uint256 proposalId, address[] calldata helpers) external {
        Proposal storage proposal = proposals[proposalId];

        if (proposal.id == 0) revert ProposalNotFound();
        if (proposal.executed) revert ProposalAlreadyExecuted();
        if (proposal.vetoed) revert ProposalIsVetoed();
        if (block.timestamp >= proposal.executeAfter) revert VetoPeriodEnded();

        // requires 2% voting power
        JUICE.checkQualified(msg.sender, helpers);

        proposal.vetoed = true;

        emit ProposalVetoed(proposalId, msg.sender);
    }

    // ============ View Functions ============

    /**
     * @notice Get voting power of an address (including delegated votes)
     * @param account The address to check
     * @param helpers Addresses that delegated their votes to account
     */
    function getVotingPower(address account, address[] calldata helpers) external view returns (uint256) {
        return JUICE.votesDelegated(account, helpers);
    }

    /**
     * @notice Get voting power percentage (in basis points)
     * @param account The address to check
     * @param helpers Addresses that delegated their votes to account
     */
    function getVotingPowerPercentage(address account, address[] calldata helpers) external view returns (uint256) {
        uint256 totalVotingPower = JUICE.totalVotes();
        if (totalVotingPower == 0) return 0;

        uint256 accountVotes = JUICE.votesDelegated(account, helpers);
        return (accountVotes * 10000) / totalVotingPower; // Returns basis points
    }

    /**
     * @notice Get proposal state
     */
    function state(uint256 proposalId) external view returns (ProposalState) {
        Proposal storage p = proposals[proposalId];

        if (p.id == 0) return ProposalState.NotFound;
        if (p.executed) return ProposalState.Executed;
        if (p.vetoed) return ProposalState.Vetoed;
        if (block.timestamp < p.executeAfter) return ProposalState.Pending;
        return ProposalState.Ready;
    }
}
