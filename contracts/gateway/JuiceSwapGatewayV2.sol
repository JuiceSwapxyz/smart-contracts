// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IJuiceSwapGateway} from "./interfaces/IJuiceSwapGateway.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IWrappedCBTCV2 is IERC20 {
    function deposit() external payable;
    function withdraw(uint256 wad) external;
}

interface IEquityV2 is IERC20 {
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

interface ISwapRouterV2 {
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

interface IUniswapV3FactoryV2 {
    function feeAmountTickSpacing(uint24 fee) external view returns (int24);
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

interface INonfungiblePositionManagerV2 {
    function factory() external view returns (address);
}

/**
 * @title JuiceSwapGatewayV2
 * @notice Stage 1 gateway with a direct JUSD protocol fee routed to Equity.
 * @dev Stage 1 intentionally implements only JUSD exact-input ERC20 swaps.
 */
// WHY: V1-compatible payable entrypoints are required, but Stage 1 rejects msg.value and receive reverts.
// slither-disable-start locked-ether
contract JuiceSwapGatewayV2 is IJuiceSwapGateway, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable JUSD;
    IERC4626 public immutable SV_JUSD;
    IEquityV2 public immutable JUICE;
    IWrappedCBTCV2 public immutable WCBTC;
    ISwapRouterV2 public immutable SWAP_ROUTER;
    INonfungiblePositionManagerV2 public immutable POSITION_MANAGER;
    IUniswapV3FactoryV2 public immutable FACTORY;

    uint8 public immutable JUSD_DECIMALS;

    address private constant NATIVE_TOKEN = address(0);
    uint24 public constant DEFAULT_FEE = 3000;
    uint256 public constant PROTOCOL_FEE_BPS = 25;
    uint256 public constant BPS_DENOMINATOR = 10_000;

    error InvalidToken();
    error InvalidAmount();
    error InsufficientOutput();
    error DeadlineExpired();
    error DirectTransferNotAccepted();
    error InvalidFee(uint24 fee);
    error NotImplemented();
    error InsufficientTradeAmount(uint256 grossAmount, uint256 feeAmount);
    error BalanceDeltaMismatch(address token, uint256 expectedDelta, uint256 actualDelta);
    error UnexpectedBalance(address token, uint256 expected, uint256 actual);

    event ProtocolFeeToEquity(address indexed payer, uint256 jusdAmount);

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
        JUICE = IEquityV2(_juice);
        WCBTC = IWrappedCBTCV2(_wcbtc);
        SWAP_ROUTER = ISwapRouterV2(_swapRouter);
        POSITION_MANAGER = INonfungiblePositionManagerV2(_positionManager);
        FACTORY = IUniswapV3FactoryV2(INonfungiblePositionManagerV2(_positionManager).factory());
        JUSD_DECIMALS = IERC20Metadata(_jusd).decimals();

        JUSD.forceApprove(address(SV_JUSD), type(uint256).max);
        JUSD.forceApprove(address(JUICE), type(uint256).max);
        IERC20(_svJusd).forceApprove(_swapRouter, type(uint256).max);
        IERC20(_svJusd).forceApprove(_positionManager, type(uint256).max);
        IERC20(_wcbtc).forceApprove(_swapRouter, type(uint256).max);
        IERC20(_wcbtc).forceApprove(_positionManager, type(uint256).max);
        IERC20(_juice).forceApprove(_positionManager, type(uint256).max);
    }

    function swapExactTokensForTokens(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 minAmountOut,
        address to,
        uint256 deadline
    ) external payable nonReentrant returns (uint256 amountOut) {
        if (msg.value != 0) revert DirectTransferNotAccepted();
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (amountIn == 0) revert InvalidAmount();
        if (to == address(0)) revert InvalidToken();
        if (tokenIn != address(JUSD) || _isUnsupportedStageOneOutput(tokenOut)) revert NotImplemented();

        uint24 effectiveFee = fee == 0 ? DEFAULT_FEE : fee;
        if (effectiveFee >= 1_000_000) revert InvalidFee(effectiveFee);

        uint256 jusdBalanceBefore = JUSD.balanceOf(address(this));
        JUSD.safeTransferFrom(msg.sender, address(this), amountIn);

        uint256 receivedInput = JUSD.balanceOf(address(this)) - jusdBalanceBefore;
        if (receivedInput != amountIn) {
            revert BalanceDeltaMismatch(address(JUSD), amountIn, receivedInput);
        }

        uint256 protocolFee = _protocolFee(amountIn);
        uint256 tradeAmount = amountIn - protocolFee;
        if (protocolFee == 0 || tradeAmount == 0) {
            revert InsufficientTradeAmount(amountIn, protocolFee);
        }

        _chargeProtocolFeeToEquity(protocolFee);

        IERC20 outputToken = IERC20(tokenOut);
        uint256 outputBalanceBefore = outputToken.balanceOf(address(this));

        JUSD.forceApprove(address(SWAP_ROUTER), tradeAmount);
        // WHY: Balance-delta checks must compare pre/post router balances; nonReentrant blocks same-entry reentry.
        // slither-disable-next-line reentrancy-balance
        uint256 routerAmountOut = SWAP_ROUTER.exactInputSingle(
            ISwapRouterV2.ExactInputSingleParams({
                tokenIn: address(JUSD),
                tokenOut: tokenOut,
                fee: effectiveFee,
                recipient: address(this),
                amountIn: tradeAmount,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        JUSD.forceApprove(address(SWAP_ROUTER), 0);

        uint256 receivedOutput = outputToken.balanceOf(address(this)) - outputBalanceBefore;
        if (receivedOutput != routerAmountOut) {
            revert BalanceDeltaMismatch(tokenOut, routerAmountOut, receivedOutput);
        }
        if (routerAmountOut < 1 || receivedOutput < minAmountOut) revert InsufficientOutput();

        uint256 recipientBalanceBefore = outputToken.balanceOf(to);
        outputToken.safeTransfer(to, receivedOutput);
        uint256 recipientDelta = outputToken.balanceOf(to) - recipientBalanceBefore;
        if (recipientDelta != receivedOutput) {
            revert BalanceDeltaMismatch(tokenOut, receivedOutput, recipientDelta);
        }

        uint256 expectedJusdBalance = jusdBalanceBefore;
        uint256 actualJusdBalance = JUSD.balanceOf(address(this));
        if (actualJusdBalance != expectedJusdBalance) {
            revert UnexpectedBalance(address(JUSD), expectedJusdBalance, actualJusdBalance);
        }

        emit SwapExecuted(msg.sender, tokenIn, tokenOut, amountIn, receivedOutput);
        return receivedOutput;
    }

    function _protocolFee(uint256 amountIn) internal pure returns (uint256) {
        return Math.mulDiv(amountIn, PROTOCOL_FEE_BPS, BPS_DENOMINATOR, Math.Rounding.Ceil);
    }

    function _chargeProtocolFeeToEquity(uint256 jusdAmount) internal {
        JUSD.safeTransfer(address(JUICE), jusdAmount);
        emit ProtocolFeeToEquity(msg.sender, jusdAmount);
    }

    function _isUnsupportedStageOneOutput(address tokenOut) private view returns (bool) {
        return
            tokenOut == NATIVE_TOKEN ||
            tokenOut == address(JUSD) ||
            tokenOut == address(SV_JUSD) ||
            tokenOut == address(JUICE);
    }

    function _stageTwo() private pure {
        revert NotImplemented();
    }

    // TODO(Stage 2): implement automatic JUSD/svJUSD conversion liquidity.
    function addLiquidity(
        address,
        address,
        uint24,
        int24,
        int24,
        uint256,
        uint256,
        uint256,
        uint256,
        address,
        uint256
    ) external payable returns (uint256, uint256, uint256) {
        _stageTwo();
    }

    // TODO(Stage 2): implement position liquidity increases.
    function increaseLiquidity(
        uint256,
        address,
        address,
        uint256,
        uint256,
        uint256,
        uint256,
        uint256
    ) external payable returns (uint256, uint256, uint128) {
        _stageTwo();
    }

    // TODO(Stage 2): implement position liquidity removal.
    function removeLiquidity(
        uint256,
        uint128,
        address,
        address,
        uint256,
        uint256,
        address,
        uint256
    ) external pure returns (uint256, uint256) {
        _stageTwo();
    }

    // TODO(Stage 2): implement JUSD to svJUSD quoting.
    function jusdToSvJusd(uint256) external pure returns (uint256) {
        _stageTwo();
    }

    // TODO(Stage 2): implement svJUSD to JUSD quoting.
    function svJusdToJusd(uint256) external pure returns (uint256) {
        _stageTwo();
    }

    // TODO(Stage 2): implement JUICE redemption quoting.
    function juiceToJusd(uint256) external pure returns (uint256) {
        _stageTwo();
    }

    // TODO(Stage 2): implement JUICE investment quoting.
    function jusdToJuice(uint256) external pure returns (uint256) {
        _stageTwo();
    }

    // TODO(Stage 2): implement bridged stablecoin to svJUSD quoting.
    function bridgedToSvJusd(address, uint256) external pure returns (uint256) {
        _stageTwo();
    }

    // TODO(Stage 2): implement svJUSD to bridged stablecoin quoting.
    function svJusdToBridged(address, uint256) external pure returns (uint256) {
        _stageTwo();
    }

    // TODO(Stage 2): implement bridged-token discovery.
    function isBridgedToken(address) external pure returns (bool) {
        _stageTwo();
    }

    // TODO(Stage 2): implement bridged-token enumeration.
    function getBridgedTokens() external pure returns (address[] memory) {
        _stageTwo();
    }

    // TODO(Stage 2): implement bridged-token registration.
    function registerBridgedToken(address) external pure {
        _stageTwo();
    }

    // TODO(Stage 2): implement bridge status checks.
    function getBridgeStatus(address) external pure returns (BridgeStatus memory) {
        _stageTwo();
    }

    // TODO(Stage 2): implement pool creation with user-facing token conversion.
    function createPool(address, address, uint24, uint160) external pure returns (address) {
        _stageTwo();
    }

    // TODO(Stage 2): implement pool creation plus initial liquidity.
    function createPoolAndAddLiquidity(
        address,
        address,
        uint24,
        uint160,
        int24,
        int24,
        uint256,
        uint256,
        uint256,
        uint256,
        address,
        uint256
    ) external payable returns (address, uint256, uint256, uint256) {
        _stageTwo();
    }

    // TODO(Stage 2): implement pool lookup with user-facing token conversion.
    function getPool(address, address, uint24) external pure returns (address, bool) {
        _stageTwo();
    }

    receive() external payable {
        revert DirectTransferNotAccepted();
    }
}
// slither-disable-end locked-ether
