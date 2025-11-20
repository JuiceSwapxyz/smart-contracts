// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IJuiceSwapGateway} from "./interfaces/IJuiceSwapGateway.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

interface IWrappedCBTC is IERC20 {
    function deposit() external payable;
    function withdraw(uint256 wad) external;
}

interface IEquity is IERC20 {
    function invest(uint256 amount, uint256 expectedShares) external returns (uint256);
    function redeem(address target, uint256 shares) external returns (uint256);
    function calculateProceeds(uint256 shares) external view returns (uint256);
    function calculateShares(uint256 investment) external view returns (uint256);
}

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

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

interface INonfungiblePositionManager {
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

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);

    struct IncreaseLiquidityParams {
        uint256 tokenId;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    function increaseLiquidity(IncreaseLiquidityParams calldata params)
        external
        payable
        returns (uint128 liquidity, uint256 amount0, uint256 amount1);

    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1);

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);

    function positions(uint256 tokenId)
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
contract JuiceSwapGateway is IJuiceSwapGateway, Ownable, ReentrancyGuard, Pausable {
    IERC20 public immutable JUSD;
    IERC4626 public immutable SV_JUSD;
    IEquity public immutable JUICE;
    IWrappedCBTC public immutable WCBTC;
    ISwapRouter public immutable SWAP_ROUTER;
    INonfungiblePositionManager public immutable POSITION_MANAGER;

    address private constant NATIVE_TOKEN = address(0);
    uint24 public defaultFee = 3000; // 0.3% default fee tier

    error InvalidToken();
    error InvalidAmount();
    error InsufficientOutput();
    error TransferFailed();
    error DeadlineExpired();
    error DirectTransferNotAccepted();

    event TokenRescued(address indexed token, address indexed to, uint256 amount);
    event NativeRescued(address indexed to, uint256 amount);
    event DefaultFeeUpdated(uint24 oldFee, uint24 newFee);

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
    ) Ownable(msg.sender) {
        JUSD = IERC20(_jusd);
        SV_JUSD = IERC4626(_svJusd);
        JUICE = IEquity(_juice);
        WCBTC = IWrappedCBTC(_wcbtc);
        SWAP_ROUTER = ISwapRouter(_swapRouter);
        POSITION_MANAGER = INonfungiblePositionManager(_positionManager);

        // Pre-approve tokens for efficiency
        JUSD.approve(address(SV_JUSD), type(uint256).max);
        JUSD.approve(address(JUICE), type(uint256).max);
        IERC20(_svJusd).approve(_swapRouter, type(uint256).max);
        IERC20(_svJusd).approve(_positionManager, type(uint256).max);
        IERC20(_wcbtc).approve(_swapRouter, type(uint256).max);
        IERC20(_wcbtc).approve(_positionManager, type(uint256).max);
    }

    /**
     * @notice Swaps tokens with automatic conversion handling using Uniswap V3
     * @dev Frontend always uses JUSD addresses, but we convert to svJUSD for actual swaps
     */
    function swapExactTokensForTokens(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address to,
        uint256 deadline
    ) external payable nonReentrant whenNotPaused returns (uint256 amountOut) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (amountIn == 0) revert InvalidAmount();

        // Step 1: Handle input token conversion
        (address actualTokenIn, uint256 actualAmountIn) = _handleTokenIn(tokenIn, amountIn);

        // Step 2: Handle output token conversion
        address actualTokenOut = _getActualToken(tokenOut);

        // Step 3: Execute swap through Uniswap V3 SwapRouter
        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: actualTokenIn,
            tokenOut: actualTokenOut,
            fee: defaultFee,
            recipient: address(this),
            deadline: deadline,
            amountIn: actualAmountIn,
            amountOutMinimum: 0, // We check slippage after conversion
            sqrtPriceLimitX96: 0
        });

        uint256 actualAmountOut = SWAP_ROUTER.exactInputSingle(params);

        // Step 4: Convert output token back to user-facing token
        amountOut = _handleTokenOut(tokenOut, actualAmountOut, to);

        if (amountOut < minAmountOut) revert InsufficientOutput();

        emit SwapExecuted(msg.sender, tokenIn, tokenOut, amountIn, amountOut);
        return amountOut;
    }

    /**
     * @notice Adds liquidity with automatic JUSD→svJUSD conversion
     * @dev For Uniswap V3, this creates a full-range position. For custom ranges, use Position Manager directly.
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
    ) external payable nonReentrant whenNotPaused returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        if (block.timestamp > deadline) revert DeadlineExpired();

        // Convert input tokens
        (address actualTokenA, uint256 actualAmountADesired) = _handleTokenIn(tokenA, amountADesired);
        (address actualTokenB, uint256 actualAmountBDesired) = _handleTokenIn(tokenB, amountBDesired);

        // Ensure token0 < token1 (Uniswap V3 requirement)
        (address token0, address token1, uint256 amount0Desired, uint256 amount1Desired) =
            actualTokenA < actualTokenB
                ? (actualTokenA, actualTokenB, actualAmountADesired, actualAmountBDesired)
                : (actualTokenB, actualTokenA, actualAmountBDesired, actualAmountADesired);

        // Calculate minimum amounts for actual tokens
        uint256 actualAmountAMin = tokenA == address(JUSD) ? _jusdToSvJusdAmount(amountAMin) : amountAMin;
        uint256 actualAmountBMin = tokenB == address(JUSD) ? _jusdToSvJusdAmount(amountBMin) : amountBMin;

        (uint256 amount0Min, uint256 amount1Min) =
            actualTokenA < actualTokenB
                ? (actualAmountAMin, actualAmountBMin)
                : (actualAmountBMin, actualAmountAMin);

        // Create full-range position (tick -887220 to 887220 for most pools)
        INonfungiblePositionManager.MintParams memory params = INonfungiblePositionManager.MintParams({
            token0: token0,
            token1: token1,
            fee: defaultFee,
            tickLower: -887220, // Full range lower
            tickUpper: 887220,  // Full range upper
            amount0Desired: amount0Desired,
            amount1Desired: amount1Desired,
            amount0Min: amount0Min,
            amount1Min: amount1Min,
            recipient: to,
            deadline: deadline
        });

        (uint256 tokenId, uint128 liquidityAmount, uint256 amount0, uint256 amount1) = POSITION_MANAGER.mint(params);

        // Map back to A/B order
        (amountA, amountB) = actualTokenA < actualTokenB ? (amount0, amount1) : (amount1, amount0);
        liquidity = tokenId; // Return NFT tokenId as "liquidity"

        // Return excess tokens to user
        uint256 excessA = actualTokenA < actualTokenB
            ? (amount0Desired > amount0 ? amount0Desired - amount0 : 0)
            : (amount1Desired > amount1 ? amount1Desired - amount1 : 0);
        uint256 excessB = actualTokenA < actualTokenB
            ? (amount1Desired > amount1 ? amount1Desired - amount1 : 0)
            : (amount0Desired > amount0 ? amount0Desired - amount0 : 0);

        _returnExcess(tokenA, actualTokenA, excessA, msg.sender);
        _returnExcess(tokenB, actualTokenB, excessB, msg.sender);

        emit LiquidityAdded(msg.sender, tokenA, tokenB, amountA, amountB, liquidity);
        return (amountA, amountB, liquidity);
    }

    /**
     * @notice Removes liquidity with automatic svJUSD→JUSD conversion
     * @dev For Uniswap V3, 'liquidity' parameter is the NFT tokenId
     */
    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint256 liquidity, // tokenId in V3
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external nonReentrant whenNotPaused returns (uint256 amountA, uint256 amountB) {
        if (block.timestamp > deadline) revert DeadlineExpired();

        uint256 tokenId = liquidity;

        // Get position info to determine liquidity amount
        (,,,,,,, uint128 liquidityAmount,,,,) = POSITION_MANAGER.positions(tokenId);

        // Transfer NFT to this contract
        IERC721(address(POSITION_MANAGER)).transferFrom(msg.sender, address(this), tokenId);

        address actualTokenA = _getActualToken(tokenA);
        address actualTokenB = _getActualToken(tokenB);

        // Calculate minimum amounts for actual tokens
        uint256 actualAmountAMin = tokenA == address(JUSD) ? _jusdToSvJusdAmount(amountAMin) : amountAMin;
        uint256 actualAmountBMin = tokenB == address(JUSD) ? _jusdToSvJusdAmount(amountBMin) : amountBMin;

        // Determine token order
        bool isAToken0 = actualTokenA < actualTokenB;
        (uint256 amount0Min, uint256 amount1Min) = isAToken0
            ? (actualAmountAMin, actualAmountBMin)
            : (actualAmountBMin, actualAmountAMin);

        // Decrease liquidity to 0
        INonfungiblePositionManager.DecreaseLiquidityParams memory decreaseParams =
            INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: tokenId,
                liquidity: liquidityAmount,
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                deadline: deadline
            });

        (uint256 amount0, uint256 amount1) = POSITION_MANAGER.decreaseLiquidity(decreaseParams);

        // Collect tokens
        INonfungiblePositionManager.CollectParams memory collectParams =
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            });

        (amount0, amount1) = POSITION_MANAGER.collect(collectParams);

        // Map back to A/B order
        (uint256 actualAmountA, uint256 actualAmountB) = isAToken0 ? (amount0, amount1) : (amount1, amount0);

        // Convert back to user-facing tokens
        amountA = _handleTokenOut(tokenA, actualAmountA, to);
        amountB = _handleTokenOut(tokenB, actualAmountB, to);

        emit LiquidityRemoved(msg.sender, tokenA, tokenB, amountA, amountB, liquidity);
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

    // ==================== Internal Functions ====================

    /**
     * @dev Handles input token conversion and returns the actual token to use in swaps
     */
    function _handleTokenIn(address token, uint256 amount) internal returns (address actualToken, uint256 actualAmount) {
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
            // JUICE → JUSD → svJUSD
            JUICE.transferFrom(msg.sender, address(this), amount);
            uint256 jusdAmount = JUICE.redeem(address(this), amount);
            uint256 shares = SV_JUSD.deposit(jusdAmount, address(this));
            return (address(SV_JUSD), shares);
        } else {
            // Other tokens - direct transfer
            IERC20(token).transferFrom(msg.sender, address(this), amount);
            // Approve max for gas efficiency (only approve once per token)
            if (IERC20(token).allowance(address(this), address(SWAP_ROUTER)) < amount) {
                IERC20(token).approve(address(SWAP_ROUTER), type(uint256).max);
            }
            if (IERC20(token).allowance(address(this), address(POSITION_MANAGER)) < amount) {
                IERC20(token).approve(address(POSITION_MANAGER), type(uint256).max);
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
            JUICE.transfer(to, juiceAmount);
            return juiceAmount;
        } else {
            // Other tokens - direct transfer
            IERC20(token).transfer(to, actualAmount);
            return actualAmount;
        }
    }

    /**
     * @dev Returns the actual token address used in pools
     */
    function _getActualToken(address token) internal view returns (address) {
        if (token == NATIVE_TOKEN) return address(WCBTC);
        if (token == address(JUSD)) return address(SV_JUSD);
        if (token == address(JUICE)) return address(SV_JUSD); // JUICE swaps through equity
        return token;
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
        } else if (actualToken != address(0)) {
            // Return excess tokens directly
            IERC20(actualToken).transfer(to, excessAmount);
        }
    }

    // ==================== Admin Functions ====================

    /**
     * @notice Updates the default fee tier for swaps
     * @param newFee The new fee tier (500 = 0.05%, 3000 = 0.3%, 10000 = 1%)
     */
    function setDefaultFee(uint24 newFee) external onlyOwner {
        uint24 oldFee = defaultFee;
        defaultFee = newFee;
        emit DefaultFeeUpdated(oldFee, newFee);
    }

    /**
     * @notice Rescue function to withdraw accidentally sent native cBTC
     */
    function rescueNative() external onlyOwner {
        uint256 balance = address(this).balance;
        if (balance > 0) {
            (bool success, ) = owner().call{value: balance}("");
            if (!success) revert TransferFailed();
            emit NativeRescued(owner(), balance);
        }
    }

    /**
     * @notice Rescue function to withdraw accidentally sent tokens
     */
    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert InvalidToken();
        IERC20(token).transfer(to, amount);
        emit TokenRescued(token, to, amount);
    }

    /**
     * @notice Pause the contract
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause the contract
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @dev Required to receive native cBTC from WcBTC.withdraw()
     */
    receive() external payable {
        // Only accept cBTC from WcBTC contract
        if (msg.sender != address(WCBTC)) revert DirectTransferNotAccepted();
    }
}
