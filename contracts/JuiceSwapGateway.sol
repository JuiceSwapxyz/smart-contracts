// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IJuiceSwapGateway} from "./interfaces/IJuiceSwapGateway.sol";
import {IStablecoinBridge} from "./interfaces/IStablecoinBridge.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IWrappedCBTC is IERC20 {
    function deposit() external payable;
    function withdraw(uint256 wad) external;
}

interface IEquity is IERC20 {
    function invest(uint256 amount, uint256 expectedShares) external returns (uint256);
    function redeem(address target, uint256 shares) external returns (uint256);
    function redeemFrom(
        address owner,
        address target,
        uint256 shares,
        uint256 expectedProceeds
    ) external returns (uint256);
    function calculateProceeds(uint256 shares) external view returns (uint256);
    function calculateShares(uint256 investment) external view returns (uint256);
}

interface IJuiceDollar {
    function isMinter(address minter) external view returns (bool);
}

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

interface IUniswapV3Factory {
    function feeAmountTickSpacing(uint24 fee) external view returns (int24);
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

interface INonfungiblePositionManager {
    function factory() external view returns (address);
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    function mint(
        MintParams calldata params
    ) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);

    struct IncreaseLiquidityParams {
        uint256 tokenId;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    function increaseLiquidity(
        IncreaseLiquidityParams calldata params
    ) external payable returns (uint128 liquidity, uint256 amount0, uint256 amount1);

    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    function decreaseLiquidity(
        DecreaseLiquidityParams calldata params
    ) external payable returns (uint256 amount0, uint256 amount1);

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);

    function positions(
        uint256 tokenId
    )
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        );

    function createAndInitializePoolIfNecessary(
        address token0,
        address token1,
        uint24 fee,
        uint160 sqrtPriceX96
    ) external payable returns (address pool);
}

/**
 * @title JuiceSwapGateway
 * @notice Gateway contract for Uniswap V3 fork that abstracts JUSD/svJUSD/JUICE/cBTC conversions
 * @dev This contract enables capital-efficient liquidity provision by:
 *      1. Automatically converting JUSD to svJUSD (interest-bearing) for pools
 *      2. Routing JUICE trades through the Equity contract instead of pools
 *      3. Wrapping native cBTC to WcBTC when needed
 *
 *      The frontend always shows JUSD, but all pools use svJUSD behind the scenes.
 *      This allows LPs to earn both swap fees AND savings interest simultaneously.
 *
 * @dev IMPORTANT: For Uniswap V3, liquidity positions are NFTs with concentrated liquidity.
 *      The addLiquidity/removeLiquidity functions are simplified wrappers.
 *      Advanced users should interact with the NonfungiblePositionManager directly.
 */
contract JuiceSwapGateway is IJuiceSwapGateway, ReentrancyGuard {
    IERC20 public immutable JUSD;
    IERC4626 public immutable SV_JUSD;
    IEquity public immutable JUICE;
    IWrappedCBTC public immutable WCBTC;
    ISwapRouter public immutable SWAP_ROUTER;
    INonfungiblePositionManager public immutable POSITION_MANAGER;
    IUniswapV3Factory public immutable FACTORY;

    /// @notice Configuration for a bridged stablecoin
    struct BridgeConfig {
        IStablecoinBridge bridge;
        uint8 decimals;
    }

    /// @notice Mapping of bridged stablecoin address to its bridge configuration
    mapping(address => BridgeConfig) public bridgeConfigs;
    /// @notice List of all supported bridged tokens (for enumeration)
    address[] public bridgedTokens;
    /// @notice Decimals of JUSD (cached for gas efficiency)
    uint8 public immutable JUSD_DECIMALS;

    address private constant NATIVE_TOKEN = address(0);
    uint24 public constant DEFAULT_FEE = 3000; // 0.3% default fee tier (immutable)
    int24 private constant MIN_TICK = -887272;
    int24 private constant MAX_TICK = 887272;

    error InvalidToken();
    error InvalidAmount();
    error InsufficientOutput();
    error TransferFailed();
    error DeadlineExpired();
    error DirectTransferNotAccepted();
    error NotNFTOwner(address caller, address owner);
    error InvalidFee(uint24 fee);
    error TokenMismatch(address expected0, address expected1, address provided0, address provided1);
    error InsufficientLiquidity(uint128 requested, uint128 available);
    error InvalidTokenPair(address tokenA, address tokenB);
    error JuiceCannotPairWithUsd(address usdToken);
    error InvalidTickRange(int24 tickLower, int24 tickUpper);
    error BridgedTokenAlreadyExists(address token);
    error BridgedTokenNotFound(address token);
    error InvalidBridgeConfig();
    error BridgeNotApprovedMinter(address bridge);
    error BridgeStopped(address bridge);
    error InvalidPrice();

    /**
     * @notice Initializes the JuiceSwap Gateway for Uniswap V3
     * @param _jusd The address of the JUSD token contract
     * @param _svJusd The address of the svJUSD vault contract (ERC-4626)
     * @param _juice The address of the JUICE (Equity) contract
     * @param _wcbtc The address of the Wrapped cBTC contract
     * @param _swapRouter The address of the Uniswap V3 SwapRouter contract
     * @param _positionManager The address of the NonfungiblePositionManager contract
     */
    constructor(
        address _jusd,
        address _svJusd,
        address _juice,
        address _wcbtc,
        address _swapRouter,
        address _positionManager
    ) {
        JUSD = IERC20(_jusd);
        SV_JUSD = IERC4626(_svJusd);
        JUICE = IEquity(_juice);
        WCBTC = IWrappedCBTC(_wcbtc);
        SWAP_ROUTER = ISwapRouter(_swapRouter);
        POSITION_MANAGER = INonfungiblePositionManager(_positionManager);
        FACTORY = IUniswapV3Factory(INonfungiblePositionManager(_positionManager).factory());
        JUSD_DECIMALS = IERC20Metadata(_jusd).decimals();

        // Pre-approve tokens for efficiency
        JUSD.approve(address(SV_JUSD), type(uint256).max);
        JUSD.approve(address(JUICE), type(uint256).max);
        IERC20(_svJusd).approve(_swapRouter, type(uint256).max);
        IERC20(_svJusd).approve(_positionManager, type(uint256).max);
        IERC20(_wcbtc).approve(_swapRouter, type(uint256).max);
        IERC20(_wcbtc).approve(_positionManager, type(uint256).max);
        IERC20(_juice).approve(_positionManager, type(uint256).max); // For JUICE liquidity pools
    }

    /**
     * @notice Swaps tokens with automatic conversion handling using Uniswap V3
     * @dev Frontend always uses JUSD addresses, but we convert to svJUSD for actual swaps
     */
    function swapExactTokensForTokens(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 minAmountOut,
        address to,
        uint256 deadline
    ) external payable nonReentrant returns (uint256 amountOut) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (amountIn == 0) revert InvalidAmount();

        // Optimization: Handle direct USD conversions without svJUSD roundtrip
        // This saves ~100k gas for JUSD <-> Bridged and JUSD/Bridged -> JUICE swaps
        bool isInputUsd = _isUsdToken(tokenIn);
        bool isOutputUsdOrJuice = _isUsdToken(tokenOut) || tokenOut == address(JUICE);

        if (isInputUsd && isOutputUsdOrJuice && tokenIn != tokenOut) {
            amountOut = _handleDirectUsdConversion(tokenIn, tokenOut, amountIn, to);
            if (amountOut < minAmountOut) revert InsufficientOutput();
            emit SwapExecuted(msg.sender, tokenIn, tokenOut, amountIn, amountOut);
            return amountOut;
        }

        // Use DEFAULT_FEE when fee is 0 (JUICE1-6 fix)
        uint24 effectiveFee = fee == 0 ? DEFAULT_FEE : fee;
        if (effectiveFee >= 1_000_000) revert InvalidFee(effectiveFee);

        // Step 1: Handle input token conversion
        (address actualTokenIn, uint256 actualAmountIn) = _handleTokenIn(tokenIn, amountIn);

        // Step 2: Handle output token conversion
        address actualTokenOut = _getActualToken(tokenOut);

        // Step 3: Execute swap through Uniswap V3 SwapRouter (skip if same token)
        // Note: The direct USD conversion above handles most same-token cases more efficiently
        uint256 actualAmountOut;
        if (actualTokenIn == actualTokenOut) {
            // Fallback for edge cases (shouldn't happen with USD tokens anymore)
            actualAmountOut = actualAmountIn;
        } else {
            ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
                tokenIn: actualTokenIn,
                tokenOut: actualTokenOut,
                fee: effectiveFee,
                recipient: address(this),
                amountIn: actualAmountIn,
                amountOutMinimum: 0, // Slippage checked after conversions
                sqrtPriceLimitX96: 0
            });
            actualAmountOut = SWAP_ROUTER.exactInputSingle(params);
        }

        // Step 4: Convert output token back to user-facing token
        amountOut = _handleTokenOut(tokenOut, actualAmountOut, to);

        if (amountOut < minAmountOut) revert InsufficientOutput();

        emit SwapExecuted(msg.sender, tokenIn, tokenOut, amountIn, amountOut);
        return amountOut;
    }

    /**
     * @notice Adds liquidity with automatic JUSD→svJUSD conversion and optional custom tick range
     * @dev If tickLower == tickUpper, creates a full-range position. Otherwise validates and uses custom ticks.
     */
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint24 fee,
        int24 tickLower,
        int24 tickUpper,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external payable nonReentrant returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        if (block.timestamp > deadline) revert DeadlineExpired();

        // JUICE liquidity restriction: cannot pair with USD-based tokens
        // (JUICE/svJUSD pool would be redundant since JUICE can be redeemed for JUSD)
        if (tokenA == address(JUICE) || tokenB == address(JUICE)) {
            address otherToken = tokenA == address(JUICE) ? tokenB : tokenA;
            if (
                otherToken == address(JUSD) ||
                otherToken == address(SV_JUSD) ||
                address(bridgeConfigs[otherToken].bridge) != address(0)
            ) {
                revert JuiceCannotPairWithUsd(otherToken);
            }
        }

        // Prevent invalid token pairs where both tokens convert to the same actual token
        // e.g., USDT + JUSD would both become svJUSD
        // Note: Use _getActualTokenForLiquidity since JUICE stays JUICE for liquidity
        if (_getActualTokenForLiquidity(tokenA) == _getActualTokenForLiquidity(tokenB)) {
            revert InvalidTokenPair(tokenA, tokenB);
        }

        // Use DEFAULT_FEE when fee is 0 (JUICE1-6 fix)
        uint24 effectiveFee = fee == 0 ? DEFAULT_FEE : fee;

        // Convert input tokens (JUICE stays JUICE for liquidity, not converted to svJUSD)
        (address actualTokenA, uint256 actualAmountADesired) = _handleTokenInForLiquidity(tokenA, amountADesired);
        (address actualTokenB, uint256 actualAmountBDesired) = _handleTokenInForLiquidity(tokenB, amountBDesired);

        // Cache token ordering comparison (JUICE1-11 fix)
        bool isAToken0 = actualTokenA < actualTokenB;

        // Ensure token0 < token1 (Uniswap V3 requirement)
        (address token0, address token1, uint256 amount0Desired, uint256 amount1Desired) = isAToken0
            ? (actualTokenA, actualTokenB, actualAmountADesired, actualAmountBDesired)
            : (actualTokenB, actualTokenA, actualAmountBDesired, actualAmountADesired);

        // Calculate minimum amounts for actual tokens (JUICE stays JUICE for liquidity)
        uint256 actualAmountAMin = _toActualMinAmountForLiquidity(tokenA, amountAMin);
        uint256 actualAmountBMin = _toActualMinAmountForLiquidity(tokenB, amountBMin);

        (uint256 amount0Min, uint256 amount1Min) = isAToken0
            ? (actualAmountAMin, actualAmountBMin)
            : (actualAmountBMin, actualAmountAMin);

        // Determine tick range: if tickLower == tickUpper (sentinel), use full range
        int24 actualTickLower;
        int24 actualTickUpper;
        if (tickLower == tickUpper) {
            (actualTickLower, actualTickUpper) = _getFullRangeTicks(effectiveFee);
        } else {
            _validateTicks(tickLower, tickUpper, effectiveFee);
            actualTickLower = tickLower;
            actualTickUpper = tickUpper;
        }

        INonfungiblePositionManager.MintParams memory params = INonfungiblePositionManager.MintParams({
            token0: token0,
            token1: token1,
            fee: effectiveFee,
            tickLower: actualTickLower,
            tickUpper: actualTickUpper,
            amount0Desired: amount0Desired,
            amount1Desired: amount1Desired,
            amount0Min: amount0Min,
            amount1Min: amount1Min,
            recipient: to,
            deadline: deadline
        });

        (uint256 tokenId, , uint256 amount0, uint256 amount1) = POSITION_MANAGER.mint(params);

        // Map back to A/B order (in pool token units)
        (uint256 poolAmountA, uint256 poolAmountB) = isAToken0 ? (amount0, amount1) : (amount1, amount0);
        liquidity = tokenId; // Return NFT tokenId as "liquidity"

        // Return excess tokens to user
        uint256 excessA = isAToken0
            ? (amount0Desired > amount0 ? amount0Desired - amount0 : 0)
            : (amount1Desired > amount1 ? amount1Desired - amount1 : 0);
        uint256 excessB = isAToken0
            ? (amount1Desired > amount1 ? amount1Desired - amount1 : 0)
            : (amount0Desired > amount0 ? amount0Desired - amount0 : 0);

        _returnExcess(tokenA, actualTokenA, excessA, msg.sender);
        _returnExcess(tokenB, actualTokenB, excessB, msg.sender);

        // Convert to user-facing amounts for return values and event
        amountA = _toUserAmountForLiquidity(tokenA, poolAmountA);
        amountB = _toUserAmountForLiquidity(tokenB, poolAmountB);

        // Verify final amounts meet user's minimums after all conversions
        if (amountA < amountAMin) revert InsufficientOutput();
        if (amountB < amountBMin) revert InsufficientOutput();

        emit LiquidityAdded(msg.sender, tokenA, tokenB, amountA, amountB, tokenId);
        return (amountA, amountB, liquidity);
    }

    /**
     * @notice Increases liquidity of an existing position with automatic JUSD→svJUSD conversion
     * @dev Requires NFT approval to Gateway. Returns NFT to sender after operation.
     */
    function increaseLiquidity(
        uint256 tokenId,
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        uint256 deadline
    ) external payable nonReentrant returns (uint256 amountA, uint256 amountB, uint128 liquidity) {
        if (block.timestamp > deadline) revert DeadlineExpired();

        // JUICE liquidity restriction: cannot pair with USD-based tokens
        if (tokenA == address(JUICE) || tokenB == address(JUICE)) {
            address otherToken = tokenA == address(JUICE) ? tokenB : tokenA;
            if (
                otherToken == address(JUSD) ||
                otherToken == address(SV_JUSD) ||
                address(bridgeConfigs[otherToken].bridge) != address(0)
            ) {
                revert JuiceCannotPairWithUsd(otherToken);
            }
        }

        // Verify NFT ownership
        address nftOwner = IERC721(address(POSITION_MANAGER)).ownerOf(tokenId);
        if (nftOwner != msg.sender) revert NotNFTOwner(msg.sender, nftOwner);

        // Validate tokens match position BEFORE any transfers (positions() is a view function)
        // Note: Use _getActualTokenForLiquidity since JUICE stays JUICE for liquidity
        (, , address posToken0, address posToken1, , , , , , , , ) = POSITION_MANAGER.positions(tokenId);
        address expectedTokenA = _getActualTokenForLiquidity(tokenA);
        address expectedTokenB = _getActualTokenForLiquidity(tokenB);

        bool tokensMatch = (expectedTokenA == posToken0 && expectedTokenB == posToken1) ||
            (expectedTokenA == posToken1 && expectedTokenB == posToken0);
        if (!tokensMatch) {
            revert TokenMismatch(posToken0, posToken1, expectedTokenA, expectedTokenB);
        }

        // Transfer NFT to this contract (only after validation passes)
        IERC721(address(POSITION_MANAGER)).transferFrom(msg.sender, address(this), tokenId);

        // Convert input tokens (JUICE stays JUICE for liquidity, JUSD/bridged USD → svJUSD)
        (address actualTokenA, uint256 actualAmountADesired) = _handleTokenInForLiquidity(tokenA, amountADesired);
        (address actualTokenB, uint256 actualAmountBDesired) = _handleTokenInForLiquidity(tokenB, amountBDesired);

        // Calculate minimum amounts for actual tokens (JUICE stays JUICE for liquidity)
        uint256 actualAmountAMin = _toActualMinAmountForLiquidity(tokenA, amountAMin);
        uint256 actualAmountBMin = _toActualMinAmountForLiquidity(tokenB, amountBMin);

        // Cache token ordering comparison
        bool isAToken0 = actualTokenA < actualTokenB;

        INonfungiblePositionManager.IncreaseLiquidityParams memory params = INonfungiblePositionManager
            .IncreaseLiquidityParams({
                tokenId: tokenId,
                amount0Desired: isAToken0 ? actualAmountADesired : actualAmountBDesired,
                amount1Desired: isAToken0 ? actualAmountBDesired : actualAmountADesired,
                amount0Min: isAToken0 ? actualAmountAMin : actualAmountBMin,
                amount1Min: isAToken0 ? actualAmountBMin : actualAmountAMin,
                deadline: deadline
            });

        uint256 amount0;
        uint256 amount1;
        (liquidity, amount0, amount1) = POSITION_MANAGER.increaseLiquidity(params);

        // Map back to A/B order
        (amountA, amountB) = isAToken0 ? (amount0, amount1) : (amount1, amount0);

        // Return excess tokens to user
        uint256 excessA = isAToken0
            ? (actualAmountADesired > amount0 ? actualAmountADesired - amount0 : 0)
            : (actualAmountADesired > amount1 ? actualAmountADesired - amount1 : 0);
        uint256 excessB = isAToken0
            ? (actualAmountBDesired > amount1 ? actualAmountBDesired - amount1 : 0)
            : (actualAmountBDesired > amount0 ? actualAmountBDesired - amount0 : 0);

        _returnExcess(tokenA, actualTokenA, excessA, msg.sender);
        _returnExcess(tokenB, actualTokenB, excessB, msg.sender);

        // Convert amounts back to user-facing token units for return values and event
        // (amountA/amountB are in svJUSD terms if user passed JUSD or bridged USD, or JUICE if JUICE liquidity)
        uint256 userAmountA = _toUserAmountForLiquidity(tokenA, amountA);
        uint256 userAmountB = _toUserAmountForLiquidity(tokenB, amountB);

        // Verify final amounts meet user's minimums after all conversions
        if (userAmountA < amountAMin) revert InsufficientOutput();
        if (userAmountB < amountBMin) revert InsufficientOutput();

        // Return NFT to user
        IERC721(address(POSITION_MANAGER)).safeTransferFrom(address(this), msg.sender, tokenId);

        emit LiquidityIncreased(msg.sender, tokenId, userAmountA, userAmountB, liquidity);
        return (userAmountA, userAmountB, liquidity);
    }

    /**
     * @notice Removes liquidity with automatic svJUSD→JUSD conversion
     * @dev Supports partial removal. Set liquidityToRemove to 0 to remove all liquidity.
     *      Requires NFT approval to Gateway. Returns NFT to sender after operation.
     */
    function removeLiquidity(
        uint256 tokenId,
        uint128 liquidityToRemove,
        address tokenA,
        address tokenB,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external nonReentrant returns (uint256 amountA, uint256 amountB) {
        if (block.timestamp > deadline) revert DeadlineExpired();

        // Verify NFT ownership to prevent theft
        address nftOwner = IERC721(address(POSITION_MANAGER)).ownerOf(tokenId);
        if (nftOwner != msg.sender) revert NotNFTOwner(msg.sender, nftOwner);

        // Get position info including actual tokens in the pool
        (, , address posToken0, address posToken1, , , , uint128 positionLiquidity, , , , ) = POSITION_MANAGER
            .positions(tokenId);

        // Use specified amount or full position liquidity
        uint128 liquidityAmount = liquidityToRemove == 0 ? positionLiquidity : liquidityToRemove;

        // Validate liquidity amount doesn't exceed position
        if (liquidityToRemove > positionLiquidity) {
            revert InsufficientLiquidity(liquidityToRemove, positionLiquidity);
        }

        // Transfer NFT to this contract
        IERC721(address(POSITION_MANAGER)).transferFrom(msg.sender, address(this), tokenId);

        // Determine if position has JUICE (JUICE liquidity pool) or svJUSD (swap-style pool)
        // This affects which conversion function to use
        bool positionHasJuice = posToken0 == address(JUICE) || posToken1 == address(JUICE);

        // Map user tokens to actual position tokens based on what the position contains
        address actualTokenA;
        address actualTokenB;
        if (positionHasJuice) {
            // JUICE liquidity pool: JUICE stays JUICE
            actualTokenA = _getActualTokenForLiquidity(tokenA);
            actualTokenB = _getActualTokenForLiquidity(tokenB);
        } else {
            // Swap-style pool: use swap token mapping (JUICE → svJUSD)
            actualTokenA = _getActualToken(tokenA);
            actualTokenB = _getActualToken(tokenB);
        }

        // Validate tokens match the position
        bool tokensMatch = (actualTokenA == posToken0 && actualTokenB == posToken1) ||
            (actualTokenA == posToken1 && actualTokenB == posToken0);
        if (!tokensMatch) {
            revert TokenMismatch(posToken0, posToken1, actualTokenA, actualTokenB);
        }

        // Calculate minimum amounts for actual tokens
        uint256 actualAmountAMin;
        uint256 actualAmountBMin;
        if (positionHasJuice) {
            actualAmountAMin = _toActualMinAmountForLiquidity(tokenA, amountAMin);
            actualAmountBMin = _toActualMinAmountForLiquidity(tokenB, amountBMin);
        } else {
            actualAmountAMin = _toActualMinAmount(tokenA, amountAMin);
            actualAmountBMin = _toActualMinAmount(tokenB, amountBMin);
        }

        // Determine token order
        bool isAToken0 = actualTokenA < actualTokenB;
        (uint256 amount0Min, uint256 amount1Min) = isAToken0
            ? (actualAmountAMin, actualAmountBMin)
            : (actualAmountBMin, actualAmountAMin);

        // Decrease liquidity (partial or full)
        INonfungiblePositionManager.DecreaseLiquidityParams memory decreaseParams = INonfungiblePositionManager
            .DecreaseLiquidityParams({
                tokenId: tokenId,
                liquidity: liquidityAmount,
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                deadline: deadline
            });

        (uint256 amount0, uint256 amount1) = POSITION_MANAGER.decreaseLiquidity(decreaseParams);

        // Collect tokens
        INonfungiblePositionManager.CollectParams memory collectParams = INonfungiblePositionManager.CollectParams({
            tokenId: tokenId,
            recipient: address(this),
            amount0Max: type(uint128).max,
            amount1Max: type(uint128).max
        });

        (amount0, amount1) = POSITION_MANAGER.collect(collectParams);

        // Map back to A/B order
        (uint256 actualAmountA, uint256 actualAmountB) = isAToken0 ? (amount0, amount1) : (amount1, amount0);

        // Convert back to user-facing tokens
        // Use appropriate handler based on position type
        if (positionHasJuice) {
            // JUICE liquidity pool: JUICE transferred directly
            amountA = _handleTokenOutForLiquidity(tokenA, actualAmountA, to);
            amountB = _handleTokenOutForLiquidity(tokenB, actualAmountB, to);
        } else {
            // Swap-style pool: convert svJUSD → user token (JUICE via invest)
            amountA = _handleTokenOut(tokenA, actualAmountA, to);
            amountB = _handleTokenOut(tokenB, actualAmountB, to);
        }

        // Verify final amounts meet user's minimums after all conversions (JUICE1-4 fix)
        if (amountA < amountAMin) revert InsufficientOutput();
        if (amountB < amountBMin) revert InsufficientOutput();

        // Return NFT to user
        IERC721(address(POSITION_MANAGER)).safeTransferFrom(address(this), msg.sender, tokenId);

        emit LiquidityRemoved(msg.sender, tokenA, tokenB, amountA, amountB, tokenId);
        return (amountA, amountB);
    }

    // ==================== View Functions ====================

    function jusdToSvJusd(uint256 jusdAmount) external view returns (uint256) {
        return _jusdToSvJusdAmount(jusdAmount);
    }

    function svJusdToJusd(uint256 svJusdAmount) external view returns (uint256) {
        return _svJusdToJusdAmount(svJusdAmount);
    }

    function juiceToJusd(uint256 juiceAmount) external view returns (uint256) {
        return JUICE.calculateProceeds(juiceAmount);
    }

    function jusdToJuice(uint256 jusdAmount) external view returns (uint256) {
        return JUICE.calculateShares(jusdAmount);
    }

    function bridgedToSvJusd(address bridgedToken, uint256 amount) external view returns (uint256) {
        BridgeConfig storage config = bridgeConfigs[bridgedToken];
        if (address(config.bridge) == address(0)) revert BridgedTokenNotFound(bridgedToken);
        uint256 jusdAmount = _bridgedToJusdAmount(amount, config.decimals);
        return SV_JUSD.convertToShares(jusdAmount);
    }

    function svJusdToBridged(address bridgedToken, uint256 svJusdAmount) external view returns (uint256) {
        BridgeConfig storage config = bridgeConfigs[bridgedToken];
        if (address(config.bridge) == address(0)) revert BridgedTokenNotFound(bridgedToken);
        uint256 jusdAmount = SV_JUSD.convertToAssets(svJusdAmount);
        return _jusdToBridgedAmount(jusdAmount, config.decimals);
    }

    function isBridgedToken(address token) external view returns (bool) {
        return address(bridgeConfigs[token].bridge) != address(0);
    }

    /**
     * @notice Returns comprehensive status information for a bridged token's bridge
     * @dev Useful for frontends to check if operations will succeed before attempting them
     * @param bridgedToken The bridged stablecoin address to check
     * @return status The bridge status containing mint/burn capacity and block reasons
     */
    function getBridgeStatus(address bridgedToken) external view returns (BridgeStatus memory status) {
        BridgeConfig storage config = bridgeConfigs[bridgedToken];

        // Check if token is supported
        if (address(config.bridge) == address(0)) {
            return
                BridgeStatus({
                    canMint: false,
                    canBurn: false,
                    mintCapacity: 0,
                    burnCapacity: 0,
                    mintBlockReason: "Token not supported",
                    burnBlockReason: "Token not supported"
                });
        }

        IStablecoinBridge bridge = config.bridge;

        // === MINT CHECKS (bridged token → JUSD) ===
        bool canMint = true;
        string memory mintReason = "";
        uint256 mintCapacity = 0;

        // Check if bridge is stopped (emergency governance action)
        if (bridge.stopped()) {
            canMint = false;
            mintReason = "Bridge stopped";
        }
        // Check if bridge is expired
        else if (block.timestamp > bridge.horizon()) {
            canMint = false;
            mintReason = "Bridge expired";
        }
        // Check mint limit
        else {
            uint256 minted = bridge.minted();
            uint256 limit = bridge.limit();
            if (minted >= limit) {
                canMint = false;
                mintReason = "Limit reached";
            } else {
                // Remaining capacity in JUSD (18 decimals)
                mintCapacity = limit - minted;
            }
        }

        // === BURN CHECKS (JUSD → bridged token) ===
        // Burn needs the bridge to have sufficient bridged token balance
        address usdToken = bridge.usd();
        uint256 bridgeBalance = IERC20(usdToken).balanceOf(address(bridge));

        bool canBurn = bridgeBalance > 0;
        string memory burnReason = canBurn ? "" : "Insufficient bridge liquidity";

        return
            BridgeStatus({
                canMint: canMint,
                canBurn: canBurn,
                mintCapacity: mintCapacity,
                burnCapacity: bridgeBalance, // In bridged token decimals
                mintBlockReason: mintReason,
                burnBlockReason: burnReason
            });
    }

    // ==================== Internal Functions ====================

    /**
     * @dev Handles input token conversion and returns the actual token to use in swaps
     */
    function _handleTokenIn(
        address token,
        uint256 amount
    ) internal returns (address actualToken, uint256 actualAmount) {
        if (token == NATIVE_TOKEN) {
            // Native cBTC → WcBTC
            if (msg.value != amount) revert InvalidAmount();
            WCBTC.deposit{value: amount}();
            return (address(WCBTC), amount);
        } else if (token == address(JUSD)) {
            // JUSD → svJUSD
            JUSD.transferFrom(msg.sender, address(this), amount);
            uint256 shares = SV_JUSD.deposit(amount, address(this));
            return (address(SV_JUSD), shares);
        } else if (token == address(JUICE)) {
            // JUICE → JUSD via Equity.redeemFrom() → svJUSD
            // Using redeemFrom() bypasses flash loan protection on Gateway address,
            // since the check is on `owner` (msg.sender/user), not on `target` (Gateway).
            // User must have approved Gateway for JUICE spending.
            uint256 jusdAmount = JUICE.redeemFrom(msg.sender, address(this), amount, 0);
            uint256 shares = SV_JUSD.deposit(jusdAmount, address(this));
            return (address(SV_JUSD), shares);
        }

        // Check if token is a bridged stablecoin
        BridgeConfig storage config = bridgeConfigs[token];
        if (address(config.bridge) != address(0)) {
            // Bridged USD (e.g., USDC.e, USDT.e, ctUSD) → JUSD (via Bridge) → svJUSD
            SafeERC20.safeTransferFrom(IERC20(token), msg.sender, address(this), amount);
            // Bridge mints JUSD (handles decimal conversion internally)
            config.bridge.mint(amount);
            // Convert bridged USD amount to JUSD amount (e.g., 6 decimals → 18 decimals)
            uint256 jusdAmount = _bridgedToJusdAmount(amount, config.decimals);
            // Deposit JUSD into savings vault
            uint256 shares = SV_JUSD.deposit(jusdAmount, address(this));
            return (address(SV_JUSD), shares);
        } else {
            // Other tokens - direct transfer
            SafeERC20.safeTransferFrom(IERC20(token), msg.sender, address(this), amount);
            if (IERC20(token).allowance(address(this), address(SWAP_ROUTER)) < amount) {
                SafeERC20.forceApprove(IERC20(token), address(SWAP_ROUTER), type(uint256).max);
            }
            if (IERC20(token).allowance(address(this), address(POSITION_MANAGER)) < amount) {
                SafeERC20.forceApprove(IERC20(token), address(POSITION_MANAGER), type(uint256).max);
            }
            return (token, amount);
        }
    }

    /**
     * @dev Handles input token conversion for liquidity operations
     * @notice Unlike _handleTokenIn, JUICE is NOT converted to svJUSD - it stays as JUICE.
     *         This allows users to add JUICE directly to liquidity pools.
     */
    function _handleTokenInForLiquidity(
        address token,
        uint256 amount
    ) internal returns (address actualToken, uint256 actualAmount) {
        if (token == NATIVE_TOKEN) {
            // Native cBTC → WcBTC
            if (msg.value != amount) revert InvalidAmount();
            WCBTC.deposit{value: amount}();
            return (address(WCBTC), amount);
        } else if (token == address(JUSD)) {
            // JUSD → svJUSD
            JUSD.transferFrom(msg.sender, address(this), amount);
            uint256 shares = SV_JUSD.deposit(amount, address(this));
            return (address(SV_JUSD), shares);
        } else if (token == address(JUICE)) {
            // JUICE stays JUICE for liquidity (NOT converted to svJUSD)
            // Note: JUICE is pre-approved to POSITION_MANAGER in constructor with max allowance
            SafeERC20.safeTransferFrom(IERC20(address(JUICE)), msg.sender, address(this), amount);
            return (address(JUICE), amount);
        }

        // Check if token is a bridged stablecoin
        BridgeConfig storage config = bridgeConfigs[token];
        if (address(config.bridge) != address(0)) {
            // Bridged USD (e.g., USDC.e, USDT.e, ctUSD) → JUSD (via Bridge) → svJUSD
            SafeERC20.safeTransferFrom(IERC20(token), msg.sender, address(this), amount);
            config.bridge.mint(amount);
            uint256 jusdAmount = _bridgedToJusdAmount(amount, config.decimals);
            uint256 shares = SV_JUSD.deposit(jusdAmount, address(this));
            return (address(SV_JUSD), shares);
        } else {
            // Other tokens - direct transfer
            SafeERC20.safeTransferFrom(IERC20(token), msg.sender, address(this), amount);
            if (IERC20(token).allowance(address(this), address(POSITION_MANAGER)) < amount) {
                SafeERC20.forceApprove(IERC20(token), address(POSITION_MANAGER), type(uint256).max);
            }
            return (token, amount);
        }
    }

    /**
     * @dev Handles output token conversion and sends to recipient
     */
    function _handleTokenOut(address token, uint256 actualAmount, address to) internal returns (uint256 userAmount) {
        if (token == NATIVE_TOKEN) {
            // WcBTC → Native cBTC
            WCBTC.withdraw(actualAmount);
            (bool success, ) = to.call{value: actualAmount}("");
            if (!success) revert TransferFailed();
            return actualAmount;
        } else if (token == address(JUSD)) {
            // svJUSD → JUSD
            uint256 jusdAmount = SV_JUSD.redeem(actualAmount, to, address(this));
            return jusdAmount;
        } else if (token == address(JUICE)) {
            // svJUSD → JUSD → JUICE
            uint256 jusdAmount = SV_JUSD.redeem(actualAmount, address(this), address(this));
            uint256 juiceAmount = JUICE.invest(jusdAmount, 0);
            SafeERC20.safeTransfer(IERC20(address(JUICE)), to, juiceAmount);
            return juiceAmount;
        }

        // Check if token is a bridged stablecoin
        BridgeConfig storage config = bridgeConfigs[token];
        if (address(config.bridge) != address(0)) {
            // svJUSD → JUSD → Bridged USD (e.g., USDC.e, USDT.e, ctUSD)
            uint256 jusdAmount = SV_JUSD.redeem(actualAmount, address(this), address(this));
            // Burn JUSD via bridge to get bridged USD sent to recipient
            config.bridge.burnAndSend(to, jusdAmount);
            // Return amount in bridged USD decimals
            return _jusdToBridgedAmount(jusdAmount, config.decimals);
        } else {
            // Other tokens - direct transfer
            SafeERC20.safeTransfer(IERC20(token), to, actualAmount);
            return actualAmount;
        }
    }

    /**
     * @dev Handles output token conversion for liquidity operations
     * @notice Unlike _handleTokenOut, JUICE is transferred directly (not converted from svJUSD)
     */
    function _handleTokenOutForLiquidity(
        address token,
        uint256 actualAmount,
        address to
    ) internal returns (uint256 userAmount) {
        if (token == NATIVE_TOKEN) {
            // WcBTC → Native cBTC
            WCBTC.withdraw(actualAmount);
            (bool success, ) = to.call{value: actualAmount}("");
            if (!success) revert TransferFailed();
            return actualAmount;
        } else if (token == address(JUSD)) {
            // svJUSD → JUSD
            uint256 jusdAmount = SV_JUSD.redeem(actualAmount, to, address(this));
            return jusdAmount;
        } else if (token == address(JUICE)) {
            // JUICE stays JUICE for liquidity - transfer directly
            SafeERC20.safeTransfer(IERC20(address(JUICE)), to, actualAmount);
            return actualAmount;
        }

        // Check if token is a bridged stablecoin
        BridgeConfig storage config = bridgeConfigs[token];
        if (address(config.bridge) != address(0)) {
            // svJUSD → JUSD → Bridged USD (e.g., USDC.e, USDT.e, ctUSD)
            uint256 jusdAmount = SV_JUSD.redeem(actualAmount, address(this), address(this));
            config.bridge.burnAndSend(to, jusdAmount);
            return _jusdToBridgedAmount(jusdAmount, config.decimals);
        } else {
            // Other tokens - direct transfer
            SafeERC20.safeTransfer(IERC20(token), to, actualAmount);
            return actualAmount;
        }
    }

    /**
     * @dev Returns the actual token address used in pools (for swaps)
     */
    function _getActualToken(address token) internal view returns (address) {
        if (token == NATIVE_TOKEN) return address(WCBTC);
        if (token == address(JUSD)) return address(SV_JUSD);
        if (token == address(JUICE)) return address(SV_JUSD); // JUICE swaps through equity
        // Check if token is a bridged stablecoin
        if (address(bridgeConfigs[token].bridge) != address(0)) return address(SV_JUSD);
        return token;
    }

    /**
     * @dev Returns the actual token address used in pools (for liquidity)
     * @notice Unlike _getActualToken, JUICE stays as JUICE for liquidity operations
     */
    function _getActualTokenForLiquidity(address token) internal view returns (address) {
        if (token == NATIVE_TOKEN) return address(WCBTC);
        if (token == address(JUSD)) return address(SV_JUSD);
        if (token == address(JUICE)) return address(JUICE); // JUICE stays JUICE for liquidity
        // Check if token is a bridged stablecoin
        if (address(bridgeConfigs[token].bridge) != address(0)) return address(SV_JUSD);
        return token;
    }

    /**
     * @dev Checks if a token is a USD-based token (JUSD or bridged stablecoin)
     */
    function _isUsdToken(address token) internal view returns (bool) {
        if (token == address(JUSD)) return true;
        if (address(bridgeConfigs[token].bridge) != address(0)) return true;
        return false;
    }

    /**
     * @dev Handles direct USD-to-USD conversions without svJUSD roundtrip
     * @notice This is an optimization for JUSD <-> Bridged and JUSD/Bridged -> JUICE swaps.
     *         Instead of: Input -> svJUSD -> JUSD -> Output
     *         We do:      Input -> JUSD -> Output (skipping vault deposit/redeem)
     * @param tokenIn The input token (JUSD or bridged stablecoin)
     * @param tokenOut The output token (JUSD, bridged stablecoin, or JUICE)
     * @param amountIn The input amount in tokenIn decimals
     * @param to The recipient address
     * @return amountOut The output amount in tokenOut decimals
     */
    function _handleDirectUsdConversion(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        address to
    ) internal returns (uint256 amountOut) {
        uint256 jusdAmount;

        // Step 1: Convert input to JUSD (if not already JUSD)
        if (tokenIn == address(JUSD)) {
            SafeERC20.safeTransferFrom(JUSD, msg.sender, address(this), amountIn);
            jusdAmount = amountIn;
        } else {
            // Bridged token input -> mint JUSD via bridge
            BridgeConfig storage configIn = bridgeConfigs[tokenIn];
            SafeERC20.safeTransferFrom(IERC20(tokenIn), msg.sender, address(this), amountIn);
            configIn.bridge.mint(amountIn);
            jusdAmount = _bridgedToJusdAmount(amountIn, configIn.decimals);
        }

        // Step 2: Convert JUSD to output token
        if (tokenOut == address(JUSD)) {
            SafeERC20.safeTransfer(JUSD, to, jusdAmount);
            return jusdAmount;
        } else if (tokenOut == address(JUICE)) {
            // JUSD -> JUICE via Equity.invest()
            // Note: JUSD already approved to JUICE in constructor
            uint256 juiceAmount = JUICE.invest(jusdAmount, 0);
            SafeERC20.safeTransfer(IERC20(address(JUICE)), to, juiceAmount);
            return juiceAmount;
        } else {
            // JUSD -> Bridged token via bridge.burnAndSend()
            // Note: JUSD already approved to bridge in registerBridgedToken()
            BridgeConfig storage configOut = bridgeConfigs[tokenOut];
            configOut.bridge.burnAndSend(to, jusdAmount);
            return _jusdToBridgedAmount(jusdAmount, configOut.decimals);
        }
    }

    /**
     * @dev Converts JUSD amount to svJUSD shares
     */
    function _jusdToSvJusdAmount(uint256 jusdAmount) internal view returns (uint256) {
        return SV_JUSD.convertToShares(jusdAmount);
    }

    /**
     * @dev Converts svJUSD shares to JUSD amount
     */
    function _svJusdToJusdAmount(uint256 svJusdAmount) internal view returns (uint256) {
        return SV_JUSD.convertToAssets(svJusdAmount);
    }

    /**
     * @dev Converts bridged token amount to JUSD amount (e.g., 6 decimals → 18 decimals)
     * @notice For tokens with fewer decimals than JUSD (e.g., USDC/USDT with 6 decimals),
     *         this is a lossless multiplication. For tokens with more decimals than JUSD
     *         (rare edge case), this rounds DOWN which favors the protocol on deposits.
     * @param bridgedAmount The amount in bridged token decimals
     * @param bridgedDecimals The decimal count of the bridged token
     * @return The equivalent amount in JUSD decimals (18)
     */
    function _bridgedToJusdAmount(uint256 bridgedAmount, uint8 bridgedDecimals) internal view returns (uint256) {
        if (bridgedDecimals < JUSD_DECIMALS) {
            // Scale up: lossless (e.g., 1_000000 USDC → 1_000000000000000000 JUSD)
            return bridgedAmount * 10 ** (JUSD_DECIMALS - bridgedDecimals);
        } else if (bridgedDecimals > JUSD_DECIMALS) {
            // Scale down: intentional floor division (rare case, favors protocol)
            return bridgedAmount / 10 ** (bridgedDecimals - JUSD_DECIMALS);
        }
        return bridgedAmount;
    }

    /**
     * @dev Converts JUSD amount to bridged token amount (e.g., 18 decimals → 6 decimals)
     * @notice Rounds DOWN (floor) intentionally to favor the protocol on withdrawals.
     *         This is standard DeFi practice: users receive slightly less on outbound transfers.
     *         Maximum precision loss per conversion: 10^(JUSD_DECIMALS - bridgedDecimals) - 1 wei
     *         Example for 6-decimal tokens: max loss is 999999999999 wei ≈ 0.000000999999 JUSD
     * @param jusdAmount The amount in JUSD decimals (18)
     * @param bridgedDecimals The decimal count of the bridged token
     * @return The equivalent amount in bridged token decimals (rounded down)
     */
    function _jusdToBridgedAmount(uint256 jusdAmount, uint8 bridgedDecimals) internal view returns (uint256) {
        if (JUSD_DECIMALS > bridgedDecimals) {
            // Scale down: intentional floor division (favors protocol on withdrawals)
            return jusdAmount / 10 ** (JUSD_DECIMALS - bridgedDecimals);
        } else if (JUSD_DECIMALS < bridgedDecimals) {
            // Scale up: lossless (rare case)
            return jusdAmount * 10 ** (bridgedDecimals - JUSD_DECIMALS);
        }
        return jusdAmount;
    }

    /**
     * @dev Converts bridged token amount to svJUSD shares
     * @notice Two-step conversion: bridged → JUSD (lossless for 6-decimal tokens) → svJUSD shares.
     *         The svJUSD conversion uses ERC4626 convertToShares which may introduce
     *         additional rounding based on the vault's share price.
     * @param bridgedAmount The amount in bridged token decimals
     * @param bridgedDecimals The decimal count of the bridged token
     * @return The equivalent amount in svJUSD shares
     */
    function _bridgedToSvJusdAmount(uint256 bridgedAmount, uint8 bridgedDecimals) internal view returns (uint256) {
        uint256 jusdAmount = _bridgedToJusdAmount(bridgedAmount, bridgedDecimals);
        return SV_JUSD.convertToShares(jusdAmount);
    }

    /**
     * @dev Converts user-facing min amount to actual token min amount
     */
    function _toActualMinAmount(address userToken, uint256 minAmount) internal view returns (uint256) {
        if (userToken == address(JUSD)) {
            return _jusdToSvJusdAmount(minAmount);
        }
        if (userToken == address(JUICE)) {
            // Convert JUICE amount to JUSD equivalent, then to svJUSD
            uint256 jusdEquivalent = JUICE.calculateProceeds(minAmount);
            return _jusdToSvJusdAmount(jusdEquivalent);
        }
        // Check if token is a bridged stablecoin
        BridgeConfig storage config = bridgeConfigs[userToken];
        if (address(config.bridge) != address(0)) {
            return _bridgedToSvJusdAmount(minAmount, config.decimals);
        }
        return minAmount;
    }

    /**
     * @dev Converts user-facing min amount to actual token min amount for liquidity operations
     * @notice Unlike _toActualMinAmount, JUICE stays as JUICE (no conversion)
     */
    function _toActualMinAmountForLiquidity(address userToken, uint256 minAmount) internal view returns (uint256) {
        if (userToken == address(JUSD)) {
            return _jusdToSvJusdAmount(minAmount);
        }
        if (userToken == address(JUICE)) {
            // JUICE stays JUICE for liquidity - no conversion needed
            return minAmount;
        }
        // Check if token is a bridged stablecoin
        BridgeConfig storage config = bridgeConfigs[userToken];
        if (address(config.bridge) != address(0)) {
            return _bridgedToSvJusdAmount(minAmount, config.decimals);
        }
        return minAmount;
    }

    /**
     * @dev Converts actual token amount back to user-facing token amount (for swaps)
     */
    function _toUserAmount(address userToken, uint256 actualAmount) internal view returns (uint256) {
        if (userToken == address(JUSD)) {
            return _svJusdToJusdAmount(actualAmount);
        }
        if (userToken == address(JUICE)) {
            // Convert svJUSD to JUSD equivalent, then estimate JUICE
            uint256 jusdAmount = _svJusdToJusdAmount(actualAmount);
            return JUICE.calculateShares(jusdAmount);
        }
        // Check if token is a bridged stablecoin
        BridgeConfig storage config = bridgeConfigs[userToken];
        if (address(config.bridge) != address(0)) {
            uint256 jusdAmount = _svJusdToJusdAmount(actualAmount);
            return _jusdToBridgedAmount(jusdAmount, config.decimals);
        }
        return actualAmount;
    }

    /**
     * @dev Converts actual token amount back to user-facing token amount (for liquidity)
     * @notice Unlike _toUserAmount, JUICE stays as JUICE (no conversion needed)
     */
    function _toUserAmountForLiquidity(address userToken, uint256 actualAmount) internal view returns (uint256) {
        if (userToken == address(JUSD)) {
            return _svJusdToJusdAmount(actualAmount);
        }
        if (userToken == address(JUICE)) {
            // JUICE stays JUICE for liquidity - no conversion needed
            return actualAmount;
        }
        // Check if token is a bridged stablecoin
        BridgeConfig storage config = bridgeConfigs[userToken];
        if (address(config.bridge) != address(0)) {
            uint256 jusdAmount = _svJusdToJusdAmount(actualAmount);
            return _jusdToBridgedAmount(jusdAmount, config.decimals);
        }
        return actualAmount;
    }

    /**
     * @dev Calculates full-range ticks for a given fee tier
     */
    function _getFullRangeTicks(uint24 fee) internal view returns (int24 tickLower, int24 tickUpper) {
        int24 tickSpacing = FACTORY.feeAmountTickSpacing(fee);
        if (tickSpacing == 0) revert InvalidFee(fee);

        tickLower = (MIN_TICK / tickSpacing) * tickSpacing;
        tickUpper = (MAX_TICK / tickSpacing) * tickSpacing;

        return (tickLower, tickUpper);
    }

    /**
     * @dev Validates custom tick range for concentrated liquidity positions
     * @param tickLower The lower bound of the position's tick range
     * @param tickUpper The upper bound of the position's tick range
     * @param fee The fee tier to determine tick spacing
     */
    function _validateTicks(int24 tickLower, int24 tickUpper, uint24 fee) internal view {
        if (tickLower >= tickUpper) revert InvalidTickRange(tickLower, tickUpper);

        int24 tickSpacing = FACTORY.feeAmountTickSpacing(fee);
        if (tickSpacing == 0) revert InvalidFee(fee);

        // Ticks must be aligned to tickSpacing
        if (tickLower % tickSpacing != 0) revert InvalidTickRange(tickLower, tickUpper);
        if (tickUpper % tickSpacing != 0) revert InvalidTickRange(tickLower, tickUpper);

        // Ticks must be within valid range
        if (tickLower < MIN_TICK || tickUpper > MAX_TICK) {
            revert InvalidTickRange(tickLower, tickUpper);
        }
    }

    /**
     * @dev Returns excess tokens to user after adding liquidity
     */
    function _returnExcess(address userToken, address actualToken, uint256 excessAmount, address to) internal {
        if (excessAmount == 0) return;

        if (userToken == address(JUSD) && actualToken == address(SV_JUSD)) {
            // Convert excess svJUSD back to JUSD
            SV_JUSD.redeem(excessAmount, to, address(this));
        } else if (userToken == NATIVE_TOKEN && actualToken == address(WCBTC)) {
            // Convert excess WcBTC back to native cBTC
            WCBTC.withdraw(excessAmount);
            (bool success, ) = to.call{value: excessAmount}("");
            if (!success) revert TransferFailed();
        } else if (userToken == address(JUICE) && actualToken == address(JUICE)) {
            // JUICE liquidity: return excess JUICE directly
            SafeERC20.safeTransfer(IERC20(address(JUICE)), to, excessAmount);
        } else if (actualToken == address(SV_JUSD)) {
            // Check if userToken is a bridged stablecoin
            BridgeConfig storage config = bridgeConfigs[userToken];
            if (address(config.bridge) != address(0)) {
                // Convert excess svJUSD back to bridged USD via JUSD
                uint256 jusdAmount = SV_JUSD.redeem(excessAmount, address(this), address(this));
                config.bridge.burnAndSend(to, jusdAmount);
            } else if (userToken == address(JUICE)) {
                // JUICE swap input: return excess as JUSD (can't convert back to JUICE due to flash loan protection)
                SV_JUSD.redeem(excessAmount, to, address(this));
            } else {
                // Unreachable: if actualToken is svJUSD, userToken must be JUSD, bridged token, or JUICE
                revert InvalidToken();
            }
        } else if (actualToken != address(0)) {
            // Return excess tokens directly
            SafeERC20.safeTransfer(IERC20(actualToken), to, excessAmount);
        }
    }

    /**
     * @dev Babylonian square root implementation
     */
    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }

    /**
     * @dev Multiplies sqrtPriceX96 by sqrt(factor/1e18) for price conversion
     * @notice Used when token0 is JUSD-based and converts to svJUSD
     */
    function _mulSqrtPrice(uint160 sqrtPriceX96, uint256 factor) internal pure returns (uint160) {
        // We need to compute: sqrtPriceX96 * sqrt(factor / 1e18)
        // = sqrtPriceX96 * sqrt(factor) / sqrt(1e18)
        // = sqrtPriceX96 * sqrt(factor) / 1e9
        uint256 sqrtFactor = _sqrt(factor);
        uint256 result = (uint256(sqrtPriceX96) * sqrtFactor) / 1e9;
        if (result > type(uint160).max) revert InvalidPrice();
        return uint160(result);
    }

    /**
     * @dev Divides sqrtPriceX96 by sqrt(factor/1e18) for price conversion
     * @notice Used when token1 is JUSD-based and converts to svJUSD
     */
    function _divSqrtPrice(uint160 sqrtPriceX96, uint256 factor) internal pure returns (uint160) {
        // We need to compute: sqrtPriceX96 / sqrt(factor / 1e18)
        // = sqrtPriceX96 * sqrt(1e18) / sqrt(factor)
        // = sqrtPriceX96 * 1e9 / sqrt(factor)
        uint256 sqrtFactor = _sqrt(factor);
        if (sqrtFactor == 0) revert InvalidPrice();
        uint256 result = (uint256(sqrtPriceX96) * 1e9) / sqrtFactor;
        if (result > type(uint160).max) revert InvalidPrice();
        return uint160(result);
    }

    /**
     * @dev Converts user-facing sqrtPriceX96 to actual pool sqrtPriceX96
     * @notice Handles the svJUSD/JUSD share price ratio for price adjustment
     *         sqrtPriceX96 = sqrt(token1/token0) * 2^96
     *         When token0 converts to svJUSD: price increases (multiply by sqrt(sharePrice))
     *         When token1 converts to svJUSD: price decreases (divide by sqrt(sharePrice))
     */
    function _convertSqrtPrice(
        address userTokenA,
        address userTokenB,
        uint160 sqrtPriceX96
    ) internal view returns (uint160) {
        address actualTokenA = _getActualTokenForLiquidity(userTokenA);
        address actualTokenB = _getActualTokenForLiquidity(userTokenB);

        // Determine token ordering (Uniswap requires token0 < token1)
        bool isAToken0 = actualTokenA < actualTokenB;
        address userToken0 = isAToken0 ? userTokenA : userTokenB;
        address userToken1 = isAToken0 ? userTokenB : userTokenA;

        bool token0Converts = _isUsdToken(userToken0);
        bool token1Converts = _isUsdToken(userToken1);

        // No conversion needed if neither token is JUSD-based
        if (!token0Converts && !token1Converts) {
            return sqrtPriceX96;
        }

        // Both tokens converting to svJUSD is invalid (would be same token)
        if (token0Converts && token1Converts) {
            revert InvalidTokenPair(userTokenA, userTokenB);
        }

        // sharePrice = JUSD per svJUSD (e.g., 1.05e18 means 1 svJUSD = 1.05 JUSD)
        uint256 sharePrice = SV_JUSD.convertToAssets(1e18);

        if (token0Converts) {
            // token0 is JUSD-based → becomes more valuable in svJUSD terms → price increases
            return _mulSqrtPrice(sqrtPriceX96, sharePrice);
        } else {
            // token1 is JUSD-based → becomes more valuable in svJUSD terms → price decreases
            return _divSqrtPrice(sqrtPriceX96, sharePrice);
        }
    }

    // ==================== Bridge Registration (Permissionless) ====================

    /**
     * @notice Registers a bridged stablecoin that can be converted to JUSD via its bridge
     * @dev Permissionless - anyone can register a bridge IF it's an approved JUSD minter.
     *      The security comes from JUSD governance: bridges must go through the veto period
     *      before they can mint JUSD, so only governance-approved bridges can be registered.
     *      The bridged token address is derived from bridge.usd().
     * @param bridge The StablecoinBridge contract for this token
     */
    function registerBridgedToken(address bridge) external {
        if (bridge == address(0)) revert InvalidBridgeConfig();

        IStablecoinBridge bridgeContract = IStablecoinBridge(bridge);
        address token = bridgeContract.usd();

        if (token == address(0)) revert InvalidBridgeConfig();
        if (bridgeConfigs[token].bridge != IStablecoinBridge(address(0))) {
            revert BridgedTokenAlreadyExists(token);
        }
        if (bridgeContract.JUSD() != address(JUSD)) revert InvalidBridgeConfig();

        // Critical: Bridge must be approved JUSD minter (via JUSD governance veto system)
        // This ensures only governance-approved bridges can be registered
        if (!IJuiceDollar(address(JUSD)).isMinter(bridge)) revert BridgeNotApprovedMinter(bridge);

        // Check if bridge is stopped (emergency governance action)
        if (bridgeContract.stopped()) revert BridgeStopped(bridge);

        uint8 decimals = IERC20Metadata(token).decimals();
        bridgeConfigs[token] = BridgeConfig({bridge: IStablecoinBridge(bridge), decimals: decimals});
        bridgedTokens.push(token);

        // Approve bridged token to bridge for mint operations
        IERC20(token).approve(bridge, type(uint256).max);
        // Approve JUSD to bridge for burn operations
        JUSD.approve(bridge, type(uint256).max);

        emit BridgedTokenRegistered(token, bridge, msg.sender, decimals);
    }

    /**
     * @notice Returns all supported bridged tokens
     */
    function getBridgedTokens() external view returns (address[] memory) {
        return bridgedTokens;
    }

    // ==================== Pool Creation ====================

    /**
     * @notice View function to check if a pool exists for a token pair
     * @dev Converts user tokens to actual pool tokens before checking
     */
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool, bool exists) {
        address actualTokenA = _getActualTokenForLiquidity(tokenA);
        address actualTokenB = _getActualTokenForLiquidity(tokenB);
        uint24 effectiveFee = fee == 0 ? DEFAULT_FEE : fee;

        pool = FACTORY.getPool(actualTokenA, actualTokenB, effectiveFee);
        exists = pool != address(0);
    }

    /**
     * @notice Creates and initializes a new pool if it doesn't exist
     * @dev Converts user-facing tokens to actual pool tokens and adjusts price accordingly
     */
    function createPool(
        address tokenA,
        address tokenB,
        uint24 fee,
        uint160 sqrtPriceX96
    ) external nonReentrant returns (address pool) {
        // Validate tokens
        if (tokenA == tokenB) revert InvalidTokenPair(tokenA, tokenB);

        // JUICE restriction for liquidity pools
        if (tokenA == address(JUICE) || tokenB == address(JUICE)) {
            address otherToken = tokenA == address(JUICE) ? tokenB : tokenA;
            if (_isUsdToken(otherToken) || otherToken == address(SV_JUSD)) {
                revert JuiceCannotPairWithUsd(otherToken);
            }
        }

        // Prevent redundant pools (both tokens map to svJUSD)
        address actualTokenA = _getActualTokenForLiquidity(tokenA);
        address actualTokenB = _getActualTokenForLiquidity(tokenB);
        if (actualTokenA == actualTokenB) {
            revert InvalidTokenPair(tokenA, tokenB);
        }

        // Use default fee if 0
        uint24 effectiveFee = fee == 0 ? DEFAULT_FEE : fee;
        if (effectiveFee >= 1_000_000) revert InvalidFee(effectiveFee);

        // Ensure token ordering (token0 < token1)
        (address token0, address token1) = actualTokenA < actualTokenB
            ? (actualTokenA, actualTokenB)
            : (actualTokenB, actualTokenA);

        // Convert price if needed
        uint160 actualSqrtPriceX96 = _convertSqrtPrice(tokenA, tokenB, sqrtPriceX96);
        if (actualSqrtPriceX96 == 0) revert InvalidPrice();

        // Create and initialize pool
        pool = POSITION_MANAGER.createAndInitializePoolIfNecessary(token0, token1, effectiveFee, actualSqrtPriceX96);

        emit PoolCreated(msg.sender, tokenA, tokenB, token0, token1, effectiveFee, pool);

        return pool;
    }

    /**
     * @notice Creates a pool and adds initial liquidity in a single transaction
     * @dev Combines createPool() and addLiquidity() for gas efficiency
     */
    function createPoolAndAddLiquidity(
        address tokenA,
        address tokenB,
        uint24 fee,
        uint160 sqrtPriceX96,
        int24 tickLower,
        int24 tickUpper,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external payable nonReentrant returns (address pool, uint256 amountA, uint256 amountB, uint256 liquidity) {
        if (block.timestamp > deadline) revert DeadlineExpired();

        // Validate tokens
        if (tokenA == tokenB) revert InvalidTokenPair(tokenA, tokenB);

        // JUICE liquidity restriction
        if (tokenA == address(JUICE) || tokenB == address(JUICE)) {
            address otherToken = tokenA == address(JUICE) ? tokenB : tokenA;
            if (_isUsdToken(otherToken) || otherToken == address(SV_JUSD)) {
                revert JuiceCannotPairWithUsd(otherToken);
            }
        }

        // Get actual tokens and validate
        address actualTokenA = _getActualTokenForLiquidity(tokenA);
        address actualTokenB = _getActualTokenForLiquidity(tokenB);
        if (actualTokenA == actualTokenB) {
            revert InvalidTokenPair(tokenA, tokenB);
        }

        // Use default fee if 0
        uint24 effectiveFee = fee == 0 ? DEFAULT_FEE : fee;
        if (effectiveFee >= 1_000_000) revert InvalidFee(effectiveFee);

        // Token ordering
        bool isAToken0 = actualTokenA < actualTokenB;
        (address token0, address token1) = isAToken0 ? (actualTokenA, actualTokenB) : (actualTokenB, actualTokenA);

        // Create pool if necessary
        uint160 actualSqrtPriceX96 = _convertSqrtPrice(tokenA, tokenB, sqrtPriceX96);
        if (actualSqrtPriceX96 == 0) revert InvalidPrice();

        pool = POSITION_MANAGER.createAndInitializePoolIfNecessary(token0, token1, effectiveFee, actualSqrtPriceX96);

        emit PoolCreated(msg.sender, tokenA, tokenB, token0, token1, effectiveFee, pool);

        // Convert input tokens
        (, uint256 actualAmountADesired) = _handleTokenInForLiquidity(tokenA, amountADesired);
        (, uint256 actualAmountBDesired) = _handleTokenInForLiquidity(tokenB, amountBDesired);

        // Calculate minimums
        uint256 actualAmountAMin = _toActualMinAmountForLiquidity(tokenA, amountAMin);
        uint256 actualAmountBMin = _toActualMinAmountForLiquidity(tokenB, amountBMin);

        (uint256 amount0Desired, uint256 amount1Desired) = isAToken0
            ? (actualAmountADesired, actualAmountBDesired)
            : (actualAmountBDesired, actualAmountADesired);

        (uint256 amount0Min, uint256 amount1Min) = isAToken0
            ? (actualAmountAMin, actualAmountBMin)
            : (actualAmountBMin, actualAmountAMin);

        // Tick range
        int24 actualTickLower;
        int24 actualTickUpper;
        if (tickLower == tickUpper) {
            (actualTickLower, actualTickUpper) = _getFullRangeTicks(effectiveFee);
        } else {
            _validateTicks(tickLower, tickUpper, effectiveFee);
            actualTickLower = tickLower;
            actualTickUpper = tickUpper;
        }

        // Mint position
        INonfungiblePositionManager.MintParams memory params = INonfungiblePositionManager.MintParams({
            token0: token0,
            token1: token1,
            fee: effectiveFee,
            tickLower: actualTickLower,
            tickUpper: actualTickUpper,
            amount0Desired: amount0Desired,
            amount1Desired: amount1Desired,
            amount0Min: amount0Min,
            amount1Min: amount1Min,
            recipient: to,
            deadline: deadline
        });

        (uint256 tokenId, , uint256 amount0, uint256 amount1) = POSITION_MANAGER.mint(params);

        // Map back to A/B order (in pool token units)
        (uint256 poolAmountA, uint256 poolAmountB) = isAToken0 ? (amount0, amount1) : (amount1, amount0);
        liquidity = tokenId;

        // Return excess tokens
        uint256 excessA = isAToken0
            ? (amount0Desired > amount0 ? amount0Desired - amount0 : 0)
            : (amount1Desired > amount1 ? amount1Desired - amount1 : 0);
        uint256 excessB = isAToken0
            ? (amount1Desired > amount1 ? amount1Desired - amount1 : 0)
            : (amount0Desired > amount0 ? amount0Desired - amount0 : 0);

        _returnExcess(tokenA, actualTokenA, excessA, msg.sender);
        _returnExcess(tokenB, actualTokenB, excessB, msg.sender);

        // Convert to user-facing amounts for return values and event
        amountA = _toUserAmountForLiquidity(tokenA, poolAmountA);
        amountB = _toUserAmountForLiquidity(tokenB, poolAmountB);

        // Verify final amounts meet user's minimums after all conversions
        if (amountA < amountAMin) revert InsufficientOutput();
        if (amountB < amountBMin) revert InsufficientOutput();

        emit LiquidityAdded(msg.sender, tokenA, tokenB, amountA, amountB, tokenId);

        return (pool, amountA, amountB, liquidity);
    }

    /**
     * @dev Required to receive native cBTC from WcBTC.withdraw()
     */
    receive() external payable {
        // Only accept cBTC from WcBTC contract
        if (msg.sender != address(WCBTC)) revert DirectTransferNotAccepted();
    }
}
