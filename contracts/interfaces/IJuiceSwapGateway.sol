// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IJuiceSwapGateway
 * @notice Interface for the JuiceSwap Gateway contract that abstracts JUSD/svJUSD/JUICE/cBTC conversions
 * @dev This gateway enables seamless token swaps by automatically handling:
 *      - JUSD ↔ svJUSD conversions (for interest-bearing liquidity)
 *      - JUICE ↔ JUSD conversions (via Equity contract)
 *      - cBTC ↔ WcBTC wrapping
 */
interface IJuiceSwapGateway {
    /**
     * @notice Emitted when a swap is executed through the gateway
     * @param user The address that initiated the swap
     * @param tokenIn The input token address (or address(0) for native cBTC)
     * @param tokenOut The output token address (or address(0) for native cBTC)
     * @param amountIn The amount of input tokens
     * @param amountOut The amount of output tokens received
     */
    event SwapExecuted(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    /**
     * @notice Emitted when liquidity is added through the gateway
     * @param user The address that provided liquidity
     * @param tokenA First token address
     * @param tokenB Second token address
     * @param amountA Amount of first token
     * @param amountB Amount of second token
     * @param liquidity LP tokens received
     */
    event LiquidityAdded(
        address indexed user,
        address indexed tokenA,
        address indexed tokenB,
        uint256 amountA,
        uint256 amountB,
        uint256 liquidity
    );

    /**
     * @notice Emitted when liquidity is removed through the gateway
     * @param user The address that removed liquidity
     * @param tokenA First token address
     * @param tokenB Second token address
     * @param amountA Amount of first token received
     * @param amountB Amount of second token received
     * @param liquidity LP tokens burned
     */
    event LiquidityRemoved(
        address indexed user,
        address indexed tokenA,
        address indexed tokenB,
        uint256 amountA,
        uint256 amountB,
        uint256 liquidity
    );

    /**
     * @notice Swaps an exact amount of input tokens for as many output tokens as possible
     * @param tokenIn The address of the input token (use address(0) for native cBTC)
     * @param tokenOut The address of the output token (use address(0) for native cBTC)
     * @param amountIn The amount of input tokens to swap
     * @param minAmountOut The minimum amount of output tokens to receive (slippage protection)
     * @param to The recipient address for output tokens
     * @param deadline Unix timestamp after which the transaction will revert
     * @return amountOut The actual amount of output tokens received
     */
    function swapExactTokensForTokens(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountOut);

    /**
     * @notice Adds liquidity to a token pair pool
     * @param tokenA The address of the first token (use address(0) for native cBTC)
     * @param tokenB The address of the second token
     * @param amountADesired The desired amount of tokenA to add
     * @param amountBDesired The desired amount of tokenB to add
     * @param amountAMin The minimum amount of tokenA to add (slippage protection)
     * @param amountBMin The minimum amount of tokenB to add (slippage protection)
     * @param to The recipient address for LP tokens
     * @param deadline Unix timestamp after which the transaction will revert
     * @return amountA Actual amount of tokenA added
     * @return amountB Actual amount of tokenB added
     * @return liquidity Amount of LP tokens received
     */
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountA, uint256 amountB, uint256 liquidity);

    /**
     * @notice Removes liquidity from a token pair pool
     * @param tokenA The address of the first token (use address(0) for native cBTC)
     * @param tokenB The address of the second token
     * @param liquidity The amount of LP tokens to burn
     * @param amountAMin The minimum amount of tokenA to receive (slippage protection)
     * @param amountBMin The minimum amount of tokenB to receive (slippage protection)
     * @param to The recipient address for withdrawn tokens
     * @param deadline Unix timestamp after which the transaction will revert
     * @return amountA Amount of tokenA received
     * @return amountB Amount of tokenB received
     */
    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB);

    /**
     * @notice Returns the equivalent amount of svJUSD for a given amount of JUSD
     * @param jusdAmount The amount of JUSD
     * @return svJusdAmount The equivalent amount of svJUSD
     */
    function jusdToSvJusd(uint256 jusdAmount) external view returns (uint256 svJusdAmount);

    /**
     * @notice Returns the equivalent amount of JUSD for a given amount of svJUSD
     * @param svJusdAmount The amount of svJUSD
     * @return jusdAmount The equivalent amount of JUSD
     */
    function svJusdToJusd(uint256 svJusdAmount) external view returns (uint256 jusdAmount);

    /**
     * @notice Returns the amount of JUSD received when redeeming JUICE
     * @param juiceAmount The amount of JUICE to redeem
     * @return jusdAmount The amount of JUSD received
     */
    function juiceToJusd(uint256 juiceAmount) external view returns (uint256 jusdAmount);

    /**
     * @notice Returns the amount of JUICE received when investing JUSD
     * @param jusdAmount The amount of JUSD to invest
     * @return juiceAmount The amount of JUICE received
     */
    function jusdToJuice(uint256 jusdAmount) external view returns (uint256 juiceAmount);
}
