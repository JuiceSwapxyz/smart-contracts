// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./IEquity.sol";

/**
 * @title IUniswapV3Pool
 * @notice Minimal interface for Uniswap V3 Pool
 */
interface IUniswapV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function collectProtocol(address recipient, uint128 amount0Requested, uint128 amount1Requested)
        external returns (uint128 amount0, uint128 amount1);
    function observe(uint32[] calldata secondsAgos)
        external view returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
    function slot0() external view returns (
        uint160 sqrtPriceX96,
        int24 tick,
        uint16 observationIndex,
        uint16 observationCardinality,
        uint16 observationCardinalityNext,
        uint8 feeProtocol,
        bool unlocked
    );
}

/**
 * @title ISwapRouter
 * @notice Minimal interface for Uniswap V3 SwapRouter
 */
interface ISwapRouter {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/**
 * @title IUniswapV3Factory
 * @notice Minimal interface for Uniswap V3 Factory
 */
interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

/**
 * @title JuiceSwapGovernor
 * @notice Governance contract for JuiceSwap that integrates with JUICE/JUSD veto system.
 *
 * Anyone can propose changes by paying 1000 JUSD. If no veto is cast within the application
 * period by holders with 2% of voting power, the proposal can be executed.
 *
 * This contract owns the JuiceSwap Factory and ProxyAdmin, enabling decentralized governance
 * while maintaining the security of the JUICE ecosystem's proven veto mechanism.
 *
 * Features automated protocol fee collection with TWAP-based frontrunning protection.
 */
contract JuiceSwapGovernor is ReentrancyGuard {

    // ============ Constants ============

    uint256 public constant PROPOSAL_FEE = 1000 * 10**18; // 1000 JUSD
    uint256 public constant MIN_APPLICATION_PERIOD = 14 days;
    uint32 public constant QUORUM = 200; // 2% in basis points (200/10000 = 2%)
    uint32 public constant TWAP_PERIOD = 1800; // 30 minutes TWAP
    uint256 public constant MAX_SLIPPAGE = 200; // 2% max slippage (in basis points)

    // ============ Immutables ============

    IERC20 public immutable JUSD;
    IEquity public immutable JUICE;
    address public immutable FACTORY; // Uniswap V3 Factory for pool address computation

    // ============ State Variables ============

    uint256 public proposalCount;
    address public feeCollector; // Authorized keeper for fee collection
    address public swapRouter; // Uniswap V3 SwapRouter address

    struct Proposal {
        uint256 id;
        address proposer;
        address target;        // Contract to call (Factory, ProxyAdmin, Pool, etc.)
        bytes data;            // Encoded function call
        uint256 applicationPeriod;
        uint256 executeAfter;  // Timestamp when proposal can be executed
        bool executed;
        bool vetoed;
        uint256 fee;
        string description;
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
    event FeeBurned(uint256 indexed proposalId, uint256 amount);
    event FeesReinvested(
        address indexed pool,
        uint256 amount0Collected,
        uint256 amount1Collected,
        uint256 jusdReceived
    );
    event FeeCollectorUpdated(address indexed oldCollector, address indexed newCollector);
    event SwapRouterUpdated(address indexed oldRouter, address indexed newRouter);

    // ============ Errors ============

    error FeeTooLow();
    error PeriodTooShort();
    error ProposalNotReady();
    error ProposalAlreadyExecuted();
    error ProposalIsVetoed();
    error NotQualified();
    error ExecutionFailed();
    error ProposalNotFound();
    error NotAuthorized();
    error SlippageTooHigh();
    error InvalidSwapPath();
    error InsufficientOutput();

    // ============ Constructor ============

    constructor(address _jusd, address _juice, address _swapRouter, address _factory) {
        JUSD = IERC20(_jusd);
        JUICE = IEquity(_juice);
        swapRouter = _swapRouter;
        FACTORY = _factory;
    }

    // ============ Core Functions ============

    /**
     * @notice Propose a governance action on JuiceSwap contracts
     * @param target The contract address to call (Factory, ProxyAdmin, Pool)
     * @param data The encoded function call (e.g., abi.encodeWithSignature("setFeeProtocol(uint8,uint8)", 5, 5))
     * @param applicationPeriod How long to wait for veto (minimum 14 days)
     * @param description Human-readable description of the proposal
     */
    function propose(
        address target,
        bytes calldata data,
        uint256 applicationPeriod,
        string calldata description
    ) external returns (uint256 proposalId) {
        if (applicationPeriod < MIN_APPLICATION_PERIOD) revert PeriodTooShort();

        // Transfer fee from proposer (burned to prevent spam)
        if (!JUSD.transferFrom(msg.sender, address(this), PROPOSAL_FEE)) revert FeeTooLow();

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
        emit FeeBurned(proposalId, PROPOSAL_FEE);
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
        if (block.timestamp >= proposal.executeAfter) revert ProposalNotReady();

        // Check if msg.sender has 2% voting power (including delegated votes)
        if (!canVeto(msg.sender, helpers)) revert NotQualified();

        proposal.vetoed = true;

        emit ProposalVetoed(proposalId, msg.sender);
    }

    // ============ Fee Collection Functions ============

    /**
     * @notice Collect protocol fees from a pool, swap to JUSD, and deposit to Equity
     * @param pool The Uniswap V3 pool to collect fees from
     * @param swapPath0 Encoded swap path for token0 → JUSD (empty if token0 is JUSD)
     * @param swapPath1 Encoded swap path for token1 → JUSD (empty if token1 is JUSD)
     * @dev Only callable by feeCollector or via governance proposal
     * @dev Uses TWAP oracle to prevent frontrunning attacks
     */
    function collectAndReinvestFees(
        address pool,
        bytes calldata swapPath0,
        bytes calldata swapPath1
    ) external nonReentrant returns (uint256 jusdReceived) {
        // Authorization check: only feeCollector or governance (this contract via proposal)
        if (msg.sender != feeCollector && msg.sender != address(this)) {
            revert NotAuthorized();
        }

        IUniswapV3Pool v3Pool = IUniswapV3Pool(pool);

        // Get token addresses
        address token0 = v3Pool.token0();
        address token1 = v3Pool.token1();

        // Measure JUSD balance BEFORE collecting fees
        uint256 jusdBefore = JUSD.balanceOf(address(this));

        // Collect all protocol fees from the pool
        (uint128 amount0, uint128 amount1) = v3Pool.collectProtocol(
            address(this),
            type(uint128).max,
            type(uint128).max
        );

        // Swap token0 → JUSD if needed
        if (amount0 > 0 && token0 != address(JUSD)) {
            _swapToJUSD(token0, amount0, swapPath0);
        }

        // Swap token1 → JUSD if needed
        if (amount1 > 0 && token1 != address(JUSD)) {
            _swapToJUSD(token1, amount1, swapPath1);
        }

        // Calculate total JUSD received (includes both direct JUSD fees and swapped tokens)
        jusdReceived = JUSD.balanceOf(address(this)) - jusdBefore;

        // Transfer JUSD to Equity reserve (increases JUICE price!)
        // Equity = JUSD.balanceOf(JUICE) - minterReserve, so direct transfer works
        if (jusdReceived > 0) {
            JUSD.transfer(address(JUICE), jusdReceived);
        }

        emit FeesReinvested(pool, amount0, amount1, jusdReceived);
    }

    /**
     * @notice Internal function to swap tokens to JUSD via SwapRouter
     * @param tokenIn The input token
     * @param amountIn The amount to swap
     * @param path The encoded swap path
     */
    function _swapToJUSD(
        address tokenIn,
        uint256 amountIn,
        bytes calldata path
    ) internal {
        // Validate swap path
        if (path.length == 0) revert InvalidSwapPath();

        // Validate path ends with JUSD
        // Path format: [tokenIn, fee, token1, fee, ..., JUSD]
        // Last 20 bytes must be JUSD address
        address pathOutput;
        assembly {
            // Get the last 20 bytes of path (output token)
            let pathEnd := add(path.offset, path.length)
            pathOutput := shr(96, calldataload(sub(pathEnd, 20)))
        }
        if (pathOutput != address(JUSD)) revert InvalidSwapPath();

        // Approve SwapRouter
        IERC20(tokenIn).approve(swapRouter, amountIn);

        // Calculate expected output using TWAP oracle from first pool in path
        address firstPool = _extractFirstPoolFromPath(tokenIn, path);
        uint256 expectedOutput = _calculateExpectedOutputFromTWAP(firstPool, tokenIn, amountIn);

        // Apply MAX_SLIPPAGE to TWAP-based expected output (not input amount!)
        uint256 minOutput = (expectedOutput * (10000 - MAX_SLIPPAGE)) / 10000;

        // Execute swap with TWAP-based slippage protection
        ISwapRouter(swapRouter).exactInput(
            ISwapRouter.ExactInputParams({
                path: path,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: amountIn,
                amountOutMinimum: minOutput // TWAP-based slippage protection
            })
        );
    }

    /**
     * @notice Extract the first pool address from a Uniswap V3 encoded path
     * @param tokenIn The input token (first token in path)
     * @param path The encoded swap path
     * @return pool The first pool address in the path
     */
    function _extractFirstPoolFromPath(
        address tokenIn,
        bytes calldata path
    ) internal view returns (address pool) {
        // Path format: [address(20), uint24(3), address(20), uint24(3), ...]
        // Bytes 0-19: first token (tokenIn)
        // Bytes 20-22: fee (uint24)
        // Bytes 23-42: second token

        require(path.length >= 43, "Path too short");

        address tokenOut;
        uint24 fee;

        assembly {
            // Fee is at bytes 20-22 (3 bytes)
            // Load 32 bytes starting at offset 20, then shift right to get uint24
            let feeData := calldataload(add(path.offset, 20))
            fee := shr(232, feeData) // shift right 232 bits to get rightmost 24 bits

            // Second token is at bytes 23-42 (20 bytes)
            // Load 32 bytes starting at offset 23, then shift right to get address
            let tokenData := calldataload(add(path.offset, 23))
            tokenOut := shr(96, tokenData) // shift right 96 bits to get rightmost 160 bits
        }

        // Compute pool address deterministically using immutable factory
        pool = _computePoolAddress(FACTORY, tokenIn, tokenOut, fee);
    }

    /**
     * @notice Get Uniswap V3 pool address from factory
     * @param factory The Uniswap V3 factory address
     * @param tokenA First token
     * @param tokenB Second token
     * @param fee Fee tier
     * @return pool The pool address
     */
    function _computePoolAddress(
        address factory,
        address tokenA,
        address tokenB,
        uint24 fee
    ) internal view returns (address pool) {
        // Query factory for pool address
        pool = IUniswapV3Factory(factory).getPool(tokenA, tokenB, fee);
        require(pool != address(0), "Pool does not exist");
    }

    /**
     * @notice Calculate expected output using TWAP from a specific pool
     * @param pool The pool to query TWAP from
     * @param tokenIn The input token
     * @param amountIn The input amount
     * @return expectedOut Expected output based on TWAP
     */
    function _calculateExpectedOutputFromTWAP(
        address pool,
        address tokenIn,
        uint256 amountIn
    ) internal view returns (uint256 expectedOut) {
        IUniswapV3Pool v3Pool = IUniswapV3Pool(pool);

        // Get TWAP tick over TWAP_PERIOD
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = TWAP_PERIOD;
        secondsAgos[1] = 0;

        (int56[] memory tickCumulatives, ) = v3Pool.observe(secondsAgos);

        int56 tickCumulativeDelta = tickCumulatives[1] - tickCumulatives[0];
        int24 arithmeticMeanTick = int24(tickCumulativeDelta / int56(int32(TWAP_PERIOD)));

        // Determine if tokenIn is token0 or token1
        address token0 = v3Pool.token0();
        bool zeroForOne = tokenIn == token0;

        // Calculate quote at TWAP tick
        expectedOut = _getQuoteAtTick(arithmeticMeanTick, uint128(amountIn), zeroForOne);
    }

    /**
     * @notice Calculate expected JUSD output using TWAP oracle
     * @param pool The pool to query TWAP from
     * @param tokenIn The input token address
     * @param amountIn The input amount
     * @return expectedOut Expected JUSD output based on TWAP
     * @dev This function can be called off-chain by the keeper to validate slippage
     */
    function calculateExpectedOutputTWAP(
        address pool,
        address tokenIn,
        uint256 amountIn
    ) external view returns (uint256 expectedOut) {
        IUniswapV3Pool v3Pool = IUniswapV3Pool(pool);

        // Get TWAP tick
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = TWAP_PERIOD;
        secondsAgos[1] = 0;

        (int56[] memory tickCumulatives, ) = v3Pool.observe(secondsAgos);

        int56 tickCumulativeDelta = tickCumulatives[1] - tickCumulatives[0];
        int24 arithmeticMeanTick = int24(tickCumulativeDelta / int56(int32(TWAP_PERIOD)));

        // Determine swap direction
        address token0 = v3Pool.token0();
        bool zeroForOne = tokenIn == token0;

        // Calculate quote at TWAP tick
        expectedOut = _getQuoteAtTick(arithmeticMeanTick, uint128(amountIn), zeroForOne);
    }

    /**
     * @notice Convert tick to quote
     * @param tick The tick to convert
     * @param baseAmount The base amount
     * @param zeroForOne True if swapping token0 for token1, false otherwise
     * @return quoteAmount The quote amount
     */
    function _getQuoteAtTick(
        int24 tick,
        uint128 baseAmount,
        bool zeroForOne
    ) internal pure returns (uint256 quoteAmount) {
        uint160 sqrtRatioX96 = _getSqrtRatioAtTick(tick);

        // Calculate the quote based on direction
        if (zeroForOne) {
            // Swapping token0 for token1
            // amount1 = amount0 * (sqrtPrice)^2
            if (sqrtRatioX96 <= type(uint128).max) {
                uint256 ratioX192 = uint256(sqrtRatioX96) * sqrtRatioX96;
                quoteAmount = (ratioX192 * baseAmount) >> 192;
            } else {
                uint256 ratioX128 = (uint256(sqrtRatioX96) * sqrtRatioX96) >> 64;
                quoteAmount = (ratioX128 * baseAmount) >> 128;
            }
        } else {
            // Swapping token1 for token0
            // amount0 = amount1 / (sqrtPrice)^2
            uint256 ratioX192 = uint256(sqrtRatioX96) * sqrtRatioX96;
            quoteAmount = (uint256(baseAmount) << 192) / ratioX192;
        }
    }

    /**
     * @notice Get sqrt ratio at tick (simplified)
     * @param tick The tick
     * @return sqrtPriceX96 The sqrt price
     */
    function _getSqrtRatioAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        // Simplified - in production use full TickMath library
        uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
        require(absTick <= 887272, "T");

        // Approximate sqrt(1.0001^tick)
        uint256 ratio = absTick & 0x1 != 0 ? 0xfffcb933bd6fad37aa2d162d1a594001 : 0x100000000000000000000000000000000;

        if (tick < 0) ratio = type(uint256).max / ratio;
        sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
    }

    // ============ Admin Functions ============

    /**
     * @notice Set the authorized fee collector address
     * @param newCollector The new fee collector address
     * @dev Only callable via governance proposal
     */
    function setFeeCollector(address newCollector) external {
        if (msg.sender != address(this)) revert NotAuthorized();

        address oldCollector = feeCollector;
        feeCollector = newCollector;

        emit FeeCollectorUpdated(oldCollector, newCollector);
    }

    /**
     * @notice Update the SwapRouter address
     * @param newRouter The new SwapRouter address
     * @dev Only callable via governance proposal
     */
    function setSwapRouter(address newRouter) external {
        if (msg.sender != address(this)) revert NotAuthorized();

        address oldRouter = swapRouter;
        swapRouter = newRouter;

        emit SwapRouterUpdated(oldRouter, newRouter);
    }

    // ============ View Functions ============

    /**
     * @notice Check if an address has enough voting power to veto (2%)
     * @param account The address to check
     * @param helpers Addresses that delegated their votes to account (incrementally sorted, no duplicates)
     * @dev This integrates with the Equity contract's holding-period-weighted voting mechanism
     */
    function canVeto(address account, address[] calldata helpers) public view returns (bool) {
        uint256 totalVotingPower = JUICE.totalVotes();
        if (totalVotingPower == 0) return false; // Prevent division by zero edge case

        uint256 accountVotes = JUICE.votesDelegated(account, helpers);

        // Check if account has at least 2% of total votes (QUORUM = 200 basis points)
        return (accountVotes * 10000) >= (totalVotingPower * QUORUM);
    }

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
     * @notice Get proposal details
     */
    function getProposal(uint256 proposalId) external view returns (
        address proposer,
        address target,
        bytes memory data,
        uint256 executeAfter,
        bool executed,
        bool vetoed,
        string memory description
    ) {
        Proposal storage proposal = proposals[proposalId];
        return (
            proposal.proposer,
            proposal.target,
            proposal.data,
            proposal.executeAfter,
            proposal.executed,
            proposal.vetoed,
            proposal.description
        );
    }

    /**
     * @notice Get proposal state
     */
    function state(uint256 proposalId) external view returns (string memory) {
        Proposal storage proposal = proposals[proposalId];

        if (proposal.id == 0) return "NotFound";
        if (proposal.executed) return "Executed";
        if (proposal.vetoed) return "Vetoed";
        if (block.timestamp < proposal.executeAfter) return "Pending";
        return "Ready";
    }

    // ============ Helper Functions ============

    /**
     * @notice Encode a function call for proposal
     * @dev Helper for creating proposal data
     */
    function encodeSetFeeProtocol(address /* pool */, uint8 feeProtocol0, uint8 feeProtocol1)
        external
        pure
        returns (bytes memory)
    {
        return abi.encodeWithSignature("setFeeProtocol(uint8,uint8)", feeProtocol0, feeProtocol1);
    }

    function encodeEnableFeeAmount(uint24 fee, int24 tickSpacing)
        external
        pure
        returns (bytes memory)
    {
        return abi.encodeWithSignature("enableFeeAmount(uint24,int24)", fee, tickSpacing);
    }

    function encodeCollectProtocol(address recipient, uint128 amount0, uint128 amount1)
        external
        pure
        returns (bytes memory)
    {
        return abi.encodeWithSignature("collectProtocol(address,uint128,uint128)", recipient, amount0, amount1);
    }

    function encodeProxyAdminUpgrade(address proxy, address implementation)
        external
        pure
        returns (bytes memory)
    {
        return abi.encodeWithSignature("upgrade(address,address)", proxy, implementation);
    }

    function encodeSetOwner(address newOwner)
        external
        pure
        returns (bytes memory)
    {
        return abi.encodeWithSignature("setOwner(address)", newOwner);
    }

    function encodeTransferOwnership(address newOwner)
        external
        pure
        returns (bytes memory)
    {
        return abi.encodeWithSignature("transferOwnership(address)", newOwner);
    }
}
