// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./libraries/OracleLibrary.sol";
import "./interfaces/IUniswapV3Pool.sol";
import "./IEquity.sol";

/**
 * @title ISwapRouter
 * @notice Minimal interface for Uniswap V3 SwapRouter
 */
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/**
 * @title IUniswapV3Factory
 * @notice Minimal interface for Uniswap V3 Factory
 */
interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
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

    // ============ Immutables ============

    IERC20 public immutable JUSD;
    IEquity public immutable JUICE;
    address public immutable FACTORY; // Uniswap V3 Factory for pool address computation

    // ============ State Variables ============

    address public swapRouter; // Uniswap V3 SwapRouter address
    uint32 public twapPeriod; // TWAP observation period in seconds
    uint256 public maxSlippageBps; // Maximum allowed slippage in basis points (e.g., 200 = 2%)

    // ============ Events ============

    event FeesReinvested(
        address indexed pool,
        uint256 amount0Collected,
        uint256 amount1Collected,
        uint256 jusdReceived
    );
    event SwapRouterUpdated(address indexed oldRouter, address indexed newRouter);
    event ProtectionParamsUpdated(uint32 twapPeriod, uint256 maxSlippageBps);

    // ============ Errors ============

    error InvalidAddress();
    error InvalidParams();
    error PoolDoesNotExist();

    // ============ Constructor ============

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

    // ============ Fee Collection Functions ============

    /**
     * @notice Collect protocol fees from a pool, swap to JUSD, and deposit to Equity
     * @param pool The Uniswap V3 pool to collect fees from
     * @param feeTier0 Fee tier for token0→JUSD pool (0 if token0 is JUSD)
     * @param feeTier1 Fee tier for token1→JUSD pool (0 if token1 is JUSD)
     *
     * @dev PERMISSIONLESS - Anyone can call to help increase JUICE price
     * @dev Caller pays gas, JUICE holders benefit from increased equity
     * @dev This contract must be the protocol fee collector (Factory owner) for the pool
     * @dev collectProtocol() only succeeds if this contract has permission to collect fees
     * @dev All collected JUSD is sent directly to JUICE equity - no funds can be redirected
     * @dev Uses TWAP oracle (configurable period) to prevent frontrunning attacks
     * @dev Only supports single-hop swaps (token → JUSD directly)
     * @dev Requires tokenIn/JUSD pools to exist at the specified fee tiers
     */
    function collectAndReinvestFees(
        address pool,
        uint24 feeTier0,
        uint24 feeTier1
    ) external nonReentrant returns (uint256 jusdReceived) {
        IUniswapV3Pool v3Pool = IUniswapV3Pool(pool);

        address token0 = v3Pool.token0();
        address token1 = v3Pool.token1();

        uint256 jusdBefore = JUSD.balanceOf(address(this));

        (uint128 amount0, uint128 amount1) = v3Pool.collectProtocol(
            address(this),
            type(uint128).max,
            type(uint128).max
        );

        if (amount0 > 0 && token0 != address(JUSD) && feeTier0 != 0) {
            _swapSingleHopToJUSD(token0, amount0, feeTier0);
        }

        if (amount1 > 0 && token1 != address(JUSD) && feeTier1 != 0) {
            _swapSingleHopToJUSD(token1, amount1, feeTier1);
        }

        jusdReceived = JUSD.balanceOf(address(this)) - jusdBefore;

        // Equity = JUSD.balanceOf(JUICE) - minterReserve, so direct transfer works
        if (jusdReceived > 0) {
            JUSD.safeTransfer(address(JUICE), jusdReceived);
        }

        emit FeesReinvested(pool, amount0, amount1, jusdReceived);
    }

    /**
     * @notice Internal function to swap tokens to JUSD via single-hop SwapRouter call
     * @param tokenIn The input token
     * @param amountIn The amount to swap
     * @param feeTier The fee tier for the tokenIn/JUSD pool
     */
    function _swapSingleHopToJUSD(
        address tokenIn,
        uint256 amountIn,
        uint24 feeTier
    ) internal {
        address pool = _computePoolAddress(FACTORY, tokenIn, address(JUSD), feeTier);

        (int24 twapTick, ) = OracleLibrary.consult(pool, twapPeriod);

        uint256 expectedOutput = OracleLibrary.getQuoteAtTick(
            twapTick,
            uint128(amountIn),
            tokenIn,
            address(JUSD)
        );

        uint256 minOutput = (expectedOutput * (10000 - maxSlippageBps)) / 10000;

        IERC20(tokenIn).forceApprove(swapRouter, amountIn);  // SafeERC20 handles non-standard tokens

        ISwapRouter(swapRouter).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: address(JUSD),
                fee: feeTier,
                recipient: address(this),
                deadline: block.timestamp + 5 minutes,  // Buffer against miner timestamp manipulation
                amountIn: amountIn,
                amountOutMinimum: minOutput,
                sqrtPriceLimitX96: 0  // No price limit
            })
        );
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
     * @notice Calculate expected JUSD output for a single-hop swap using TWAP oracle
     * @param tokenIn The input token address
     * @param amountIn The input amount
     * @param feeTier The fee tier for the tokenIn/JUSD pool
     * @return expectedOut Expected JUSD output based on TWAP
     * @dev This function can be called off-chain to validate expected output before triggering collection
     */
    function calculateExpectedOutputTWAP(
        address tokenIn,
        uint256 amountIn,
        uint24 feeTier
    ) external view returns (uint256 expectedOut) {
        address pool = _computePoolAddress(FACTORY, tokenIn, address(JUSD), feeTier);

        (int24 twapTick, ) = OracleLibrary.consult(pool, twapPeriod);

        expectedOut = OracleLibrary.getQuoteAtTick(
            twapTick,
            uint128(amountIn),
            tokenIn,
            address(JUSD)
        );
    }

    // ============ Admin Functions ============

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
}
