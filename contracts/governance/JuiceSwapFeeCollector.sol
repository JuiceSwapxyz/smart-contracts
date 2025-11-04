// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "./libraries/OracleLibrary.sol";
import "./libraries/Path.sol";
import "./interfaces/IUniswapV3Pool.sol";
import "./IEquity.sol";

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
    function setOwner(address _owner) external;
    function enableFeeAmount(uint24 fee, int24 tickSpacing) external;
}

/**
 * @title JuiceSwapFeeCollector
 * @notice Automated protocol fee collection for JuiceSwap with TWAP-based frontrunning protection.
 *
 * This contract collects protocol fees from Uniswap V3 pools, swaps them to JUSD using
 * TWAP oracle price validation, and deposits the JUSD to JUICE Equity to increase the
 * JUICE token price. It is owned and controlled by JuiceSwapGovernor.
 */
contract JuiceSwapFeeCollector is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Path for bytes;
    using BytesLib for bytes;

    IERC20 public immutable JUSD;
    IEquity public immutable JUICE;
    address public immutable FACTORY; // Uniswap V3 Factory for pool address computation

    address public swapRouter; // Uniswap V3 SwapRouter address
    uint32 public twapPeriod; // TWAP observation period in seconds
    uint256 public maxSlippageBps; // Maximum allowed slippage in basis points (e.g., 200 = 2%)

    mapping(address => bool) public authorizedCollectors; // Addresses authorized to collect fees

    event FeesReinvested(
        address indexed pool,
        uint256 amount0Collected,
        uint256 amount1Collected,
        uint256 jusdReceived
    );
    event SwapRouterUpdated(address indexed oldRouter, address indexed newRouter);
    event ProtectionParamsUpdated(uint32 twapPeriod, uint256 maxSlippageBps);
    event CollectorAuthorizationChanged(address indexed collector, bool authorized);
    event FactoryOwnerUpdated(address indexed newOwner);
    event FeeAmountEnabled(uint24 indexed fee, int24 indexed tickSpacing);

    error InvalidAddress();
    error InvalidParams();
    error PoolDoesNotExist();
    error Unauthorized();
    error InvalidPath();

    constructor(
        address _jusd,
        address _juice,
        address _swapRouter,
        address _factory,
        address _owner
    ) Ownable(_owner) {
        if (_jusd == address(0)) revert InvalidAddress();
        if (_juice == address(0)) revert InvalidAddress();
        if (_swapRouter == address(0)) revert InvalidAddress();
        if (_factory == address(0)) revert InvalidAddress();
        if (_owner == address(0)) revert InvalidAddress();

        JUSD = IERC20(_jusd);
        JUICE = IEquity(_juice);
        swapRouter = _swapRouter;
        FACTORY = _factory;

        // Initialize protection parameters (30 minutes TWAP, 2% max slippage)
        twapPeriod = 1800;
        maxSlippageBps = 200;
    }

    /**
     * @notice Collect protocol fees from a pool, swap to JUSD, and deposit to Equity
     * @param pool The Uniswap V3 pool to collect fees from
     * @param path0 Encoded swap path for token0→JUSD (empty bytes if token0 is JUSD)
     * @param path1 Encoded swap path for token1→JUSD (empty bytes if token1 is JUSD)
     *
     * @dev Only authorized collectors can call this function (managed by JuiceSwapGovernor via veto system).
     * This contract must be the factory owner to successfully call collectProtocol() on pools. All collected
     * JUSD is sent directly to JUICE equity and cannot be redirected.
     *
     * Supports single and multi-hop swaps with TWAP oracle protection to prevent frontrunning attacks.
     * Path format: abi.encodePacked(tokenIn, fee, tokenMid, fee, ..., JUSD). TWAP validation protects
     * against malicious routing even from compromised collectors.
     */
    function collectAndReinvestFees(
        address pool,
        bytes calldata path0,
        bytes calldata path1
    ) external nonReentrant returns (uint256 jusdReceived) {
        if (!authorizedCollectors[msg.sender]) revert Unauthorized();
        IUniswapV3Pool v3Pool = IUniswapV3Pool(pool);

        address token0 = v3Pool.token0();
        address token1 = v3Pool.token1();

        uint256 jusdBefore = JUSD.balanceOf(address(this));

        (uint128 amount0, uint128 amount1) = v3Pool.collectProtocol(
            address(this),
            type(uint128).max,
            type(uint128).max
        );

        // Swap token0 to JUSD if needed (path0.length > 0 means swap is required)
        if (amount0 > 0 && token0 != address(JUSD) && path0.length > 0) {
            _swapToJUSD(path0, amount0, token0);
        }

        // Swap token1 to JUSD if needed (path1.length > 0 means swap is required)
        if (amount1 > 0 && token1 != address(JUSD) && path1.length > 0) {
            _swapToJUSD(path1, amount1, token1);
        }

        jusdReceived = JUSD.balanceOf(address(this)) - jusdBefore;

        // Equity = JUSD.balanceOf(JUICE) - minterReserve, so direct transfer works
        if (jusdReceived > 0) {
            JUSD.safeTransfer(address(JUICE), jusdReceived);
        }

        emit FeesReinvested(pool, amount0, amount1, jusdReceived);
    }

    /**
     * @notice Internal function to swap tokens to JUSD via encoded path
     * @param path Encoded swap path (single or multi-hop)
     *             Single-hop: abi.encodePacked(tokenIn, fee, JUSD)
     *             Multi-hop:  abi.encodePacked(tokenIn, fee, tokenMid, fee, ..., JUSD)
     * @param amountIn The amount to swap
     * @param expectedToken The token expected to be at the start of the path
     *
     * @dev Uses TWAP oracles across all hops for manipulation protection. Uniswap's exactInput()
     * efficiently handles both single and multi-hop swaps.
     */
    function _swapToJUSD(bytes memory path, uint256 amountIn, address expectedToken) internal {
        // Validate path ends with JUSD
        _validatePath(path);

        // Get first token from path
        (address tokenIn, , ) = path.decodeFirstPool();

        // Validate path starts with expected token
        if (tokenIn != expectedToken) revert InvalidPath();

        // Calculate expected output using TWAP across all hops
        uint256 expectedOutput = calculateExpectedOutputMultiHop(path, amountIn);

        // Apply slippage tolerance
        uint256 minOutput = (expectedOutput * (10000 - maxSlippageBps)) / 10000;

        // Approve router to spend tokens
        IERC20(tokenIn).forceApprove(swapRouter, amountIn);

        // Execute multi-hop swap
        ISwapRouter(swapRouter).exactInput(
            ISwapRouter.ExactInputParams({
                path: path,
                recipient: address(this),
                deadline: block.timestamp + 5 minutes,
                amountIn: amountIn,
                amountOutMinimum: minOutput
            })
        );
    }

    /**
     * @notice Validate that a swap path ends with JUSD
     * @param path The encoded swap path
     * @dev Reverts if path doesn't end with JUSD address
     */
    function _validatePath(bytes memory path) internal view {
        // Path format: token0 (20) + fee (3) + token1 (20) + fee (3) + ... + tokenN (20)
        // Minimum path length: 20 + 3 + 20 = 43 bytes
        if (path.length < 43) revert InvalidPath();

        // Use Uniswap's audited BytesLib to extract last token
        address lastToken = path.toAddress(path.length - 20);

        if (lastToken != address(JUSD)) revert InvalidPath();
    }

    /**
     * @notice Calculate expected JUSD output for any swap path using TWAP oracle
     * @param path The encoded swap path (single or multi-hop)
     *             Single-hop: abi.encodePacked(tokenIn, fee, JUSD)
     *             Multi-hop:  abi.encodePacked(tokenIn, fee, tokenMid, fee, ..., JUSD)
     * @param amountIn The input amount
     * @return expectedOut Expected JUSD output based on TWAP across all hops
     *
     * @dev This function can be called off-chain to validate expected output before triggering collection.
     * Works for both single-hop and multi-hop paths.
     */
    function calculateExpectedOutputMultiHop(
        bytes memory path,
        uint256 amountIn
    ) public view returns (uint256 expectedOut) {
        expectedOut = amountIn;
        bytes memory remainingPath = path;

        // Iterate through each hop in the path
        while (true) {
            bool hasMore = remainingPath.hasMultiplePools();

            // Decode current pool
            (address tokenIn, address tokenOut, uint24 fee) = remainingPath.decodeFirstPool();

            // Get pool address
            address pool = _computePoolAddress(FACTORY, tokenIn, tokenOut, fee);

            // Get TWAP tick for this pool
            (int24 twapTick, ) = OracleLibrary.consult(pool, twapPeriod);

            // Calculate expected output for this hop
            expectedOut = OracleLibrary.getQuoteAtTick(
                twapTick,
                SafeCast.toUint128(expectedOut),
                tokenIn,
                tokenOut
            );

            // If no more pools, we're done
            if (!hasMore) break;

            // Move to next hop
            remainingPath = remainingPath.skipToken();
        }
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
        pool = IUniswapV3Factory(factory).getPool(tokenA, tokenB, fee);
        if (pool == address(0)) revert PoolDoesNotExist();
    }

    /**
     * @notice Update TWAP period and slippage protection parameters
     * @param _twapPeriod New TWAP observation period in seconds (min 5 minutes)
     * @param _maxSlippageBps New maximum slippage in basis points (max 10%)
     * @dev Only callable by owner (governance)
     */
    function setProtectionParams(uint32 _twapPeriod, uint256 _maxSlippageBps) external onlyOwner {
        if (_twapPeriod < 300) revert InvalidParams(); // Minimum 5 minutes
        if (_maxSlippageBps > 1000) revert InvalidParams(); // Maximum 10%

        twapPeriod = _twapPeriod;
        maxSlippageBps = _maxSlippageBps;

        emit ProtectionParamsUpdated(_twapPeriod, _maxSlippageBps);
    }

    /**
     * @notice Update the SwapRouter address
     * @param newRouter The new SwapRouter address
     * @dev Only callable by owner (governance)
     */
    function setSwapRouter(address newRouter) external onlyOwner {
        if (newRouter == address(0)) revert InvalidAddress();

        address oldRouter = swapRouter;
        swapRouter = newRouter;

        emit SwapRouterUpdated(oldRouter, newRouter);
    }

    /**
     * @notice Authorize or deauthorize a fee collector address
     * @param collector The address to authorize/deauthorize
     * @param authorized True to authorize, false to revoke authorization
     *
     * @dev Only callable by owner (JuiceSwapGovernor). Managed via governance veto system
     * (14-day period, 1000 JUSD fee, 2% veto threshold).
     */
    function setCollectorAuthorization(address collector, bool authorized) external onlyOwner {
        if (collector == address(0)) revert InvalidAddress();

        authorizedCollectors[collector] = authorized;

        emit CollectorAuthorizationChanged(collector, authorized);
    }

    /**
     * @notice Transfer factory ownership to a new address
     * @param _owner The new factory owner address
     *
     * @dev Only callable by owner (JuiceSwapGovernor). Use this to transfer factory control
     * if needed (emergency or upgrade).
     */
    function setFactoryOwner(address _owner) external onlyOwner {
        if (_owner == address(0)) revert InvalidAddress();

        IUniswapV3Factory(FACTORY).setOwner(_owner);

        emit FactoryOwnerUpdated(_owner);
    }

    /**
     * @notice Enable a new fee tier on the factory
     * @param fee The fee amount in hundredths of a bip (e.g., 500 = 0.05%)
     * @param tickSpacing The tick spacing for the fee tier
     *
     * @dev Only callable by owner (JuiceSwapGovernor). Fee tiers can never be removed once enabled.
     */
    function enableFeeAmount(uint24 fee, int24 tickSpacing) external onlyOwner {
        IUniswapV3Factory(FACTORY).enableFeeAmount(fee, tickSpacing);

        emit FeeAmountEnabled(fee, tickSpacing);
    }
}
