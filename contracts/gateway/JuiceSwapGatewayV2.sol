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
 * @notice Staged gateway with a direct JUSD protocol fee routed to Equity.
 * @dev Stage 2a adds direct JUSD, svJUSD, and JUICE conversions to the Stage 1 JUSD swap path.
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
        if (msg.value > 0) revert DirectTransferNotAccepted();
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (amountIn < 1) revert InvalidAmount();
        if (to == address(0)) revert InvalidToken();

        if (_isStageTwoDirectConversion(tokenIn, tokenOut)) {
            return _swapStageTwoDirect(tokenIn, tokenOut, amountIn, minAmountOut, to);
        }

        if (tokenIn != address(JUSD) || _isUnsupportedStageOneOutput(tokenOut)) revert NotImplemented();

        uint24 effectiveFee = fee < 1 ? DEFAULT_FEE : fee;
        if (effectiveFee >= 1_000_000) revert InvalidFee(effectiveFee);

        uint256 jusdBalanceBefore = JUSD.balanceOf(address(this));
        JUSD.safeTransferFrom(msg.sender, address(this), amountIn);

        uint256 receivedInput = JUSD.balanceOf(address(this)) - jusdBalanceBefore;
        if (_amountsDiffer(receivedInput, amountIn)) {
            revert BalanceDeltaMismatch(address(JUSD), amountIn, receivedInput);
        }

        uint256 protocolFee = _protocolFee(amountIn);
        uint256 tradeAmount = amountIn - protocolFee;
        if (protocolFee < 1 || tradeAmount < 1) {
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
        if (_amountsDiffer(receivedOutput, routerAmountOut)) {
            revert BalanceDeltaMismatch(tokenOut, routerAmountOut, receivedOutput);
        }
        if (routerAmountOut < 1 || receivedOutput < minAmountOut) revert InsufficientOutput();

        uint256 recipientBalanceBefore = outputToken.balanceOf(to);
        outputToken.safeTransfer(to, receivedOutput);
        uint256 recipientDelta = outputToken.balanceOf(to) - recipientBalanceBefore;
        if (_amountsDiffer(recipientDelta, receivedOutput)) {
            revert BalanceDeltaMismatch(tokenOut, receivedOutput, recipientDelta);
        }

        uint256 expectedJusdBalance = jusdBalanceBefore;
        uint256 actualJusdBalance = JUSD.balanceOf(address(this));
        if (_amountsDiffer(actualJusdBalance, expectedJusdBalance)) {
            revert UnexpectedBalance(address(JUSD), expectedJusdBalance, actualJusdBalance);
        }

        emit SwapExecuted(msg.sender, tokenIn, tokenOut, amountIn, receivedOutput);
        return receivedOutput;
    }

    function _protocolFee(uint256 amountIn) internal pure returns (uint256) {
        return Math.mulDiv(amountIn, PROTOCOL_FEE_BPS, BPS_DENOMINATOR, Math.Rounding.Ceil);
    }

    function _amountsDiffer(uint256 actualAmount, uint256 expectedAmount) private pure returns (bool) {
        // WHY: Exact equality is the invariant for balance deltas and residual balances; drift must revert.
        // slither-disable-next-line incorrect-equality
        return actualAmount != expectedAmount;
    }

    function _chargeProtocolFeeToEquity(uint256 jusdAmount) internal {
        JUSD.safeTransfer(address(JUICE), jusdAmount);
        emit ProtocolFeeToEquity(msg.sender, jusdAmount);
    }

    function _isStageTwoAsset(address token) private view returns (bool) {
        return token == address(JUSD) || token == address(SV_JUSD) || token == address(JUICE);
    }

    function _isStageTwoDirectConversion(address tokenIn, address tokenOut) private view returns (bool) {
        return tokenIn != tokenOut && _isStageTwoAsset(tokenIn) && _isStageTwoAsset(tokenOut);
    }

    function _swapStageTwoDirect(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address to
    ) private returns (uint256 amountOut) {
        uint256 expectedJusdBalance = JUSD.balanceOf(address(this));
        uint256 expectedSvJusdBalance = IERC20(address(SV_JUSD)).balanceOf(address(this));
        uint256 expectedJuiceBalance = JUICE.balanceOf(address(this));

        uint256 grossJusd = _collectStageTwoInput(tokenIn, amountIn);
        uint256 protocolFee = _protocolFee(grossJusd);
        uint256 netJusd = grossJusd - protocolFee;
        if (protocolFee < 1 || netJusd < 1) {
            revert InsufficientTradeAmount(grossJusd, protocolFee);
        }

        _chargeProtocolFeeToEquity(protocolFee);

        amountOut = _convertStageTwoOutput(tokenOut, netJusd, to);
        if (amountOut < 1 || amountOut < minAmountOut) revert InsufficientOutput();

        _assertGatewayStageTwoBalances(expectedJusdBalance, expectedSvJusdBalance, expectedJuiceBalance);

        emit SwapExecuted(msg.sender, tokenIn, tokenOut, amountIn, amountOut);
        return amountOut;
    }

    function _collectStageTwoInput(address tokenIn, uint256 amountIn) private returns (uint256 grossJusd) {
        if (tokenIn == address(JUSD)) {
            uint256 jusdInputBalanceBefore = JUSD.balanceOf(address(this));
            JUSD.safeTransferFrom(msg.sender, address(this), amountIn);
            return _checkedBalanceDelta(JUSD, address(JUSD), address(this), jusdInputBalanceBefore, amountIn);
        }

        if (tokenIn == address(SV_JUSD)) {
            IERC20 svJusd = IERC20(address(SV_JUSD));
            uint256 svJusdBalanceBefore = svJusd.balanceOf(address(this));
            svJusd.safeTransferFrom(msg.sender, address(this), amountIn);
            uint256 receivedShares = _checkedBalanceDelta(
                svJusd,
                address(SV_JUSD),
                address(this),
                svJusdBalanceBefore,
                amountIn
            );

            uint256 jusdRedeemBalanceBefore = JUSD.balanceOf(address(this));
            uint256 redeemedAssets = SV_JUSD.redeem(receivedShares, address(this), address(this));
            return _checkedBalanceDelta(JUSD, address(JUSD), address(this), jusdRedeemBalanceBefore, redeemedAssets);
        }

        uint256 jusdProceedsBalanceBefore = JUSD.balanceOf(address(this));
        uint256 proceeds = JUICE.redeemFrom(msg.sender, address(this), amountIn, 0);
        return _checkedBalanceDelta(JUSD, address(JUSD), address(this), jusdProceedsBalanceBefore, proceeds);
    }

    function _convertStageTwoOutput(address tokenOut, uint256 netJusd, address to) private returns (uint256 amountOut) {
        if (tokenOut == address(JUSD)) {
            return _transferStageTwoOutput(JUSD, address(JUSD), netJusd, to);
        }

        if (tokenOut == address(SV_JUSD)) {
            IERC20 svJusd = IERC20(address(SV_JUSD));
            uint256 recipientBalanceBefore = svJusd.balanceOf(to);
            uint256 svJusdShares = SV_JUSD.deposit(netJusd, to);
            return _checkedBalanceDelta(svJusd, address(SV_JUSD), to, recipientBalanceBefore, svJusdShares);
        }

        uint256 juiceBalanceBefore = JUICE.balanceOf(address(this));
        uint256 juiceShares = JUICE.invest(netJusd, 0);
        uint256 receivedShares = _checkedBalanceDelta(
            IERC20(address(JUICE)),
            address(JUICE),
            address(this),
            juiceBalanceBefore,
            juiceShares
        );
        return _transferStageTwoOutput(IERC20(address(JUICE)), address(JUICE), receivedShares, to);
    }

    function _transferStageTwoOutput(
        IERC20 token,
        address tokenAddress,
        uint256 amount,
        address to
    ) private returns (uint256 amountOut) {
        uint256 recipientBalanceBefore = token.balanceOf(to);
        token.safeTransfer(to, amount);
        return _checkedBalanceDelta(token, tokenAddress, to, recipientBalanceBefore, amount);
    }

    function _checkedBalanceDelta(
        IERC20 token,
        address tokenAddress,
        address account,
        uint256 balanceBefore,
        uint256 expectedDelta
    ) private view returns (uint256 actualDelta) {
        actualDelta = token.balanceOf(account) - balanceBefore;
        if (_amountsDiffer(actualDelta, expectedDelta)) {
            revert BalanceDeltaMismatch(tokenAddress, expectedDelta, actualDelta);
        }
        return actualDelta;
    }

    function _assertGatewayStageTwoBalances(
        uint256 expectedJusdBalance,
        uint256 expectedSvJusdBalance,
        uint256 expectedJuiceBalance
    ) private view {
        uint256 actualJusdBalance = JUSD.balanceOf(address(this));
        if (_amountsDiffer(actualJusdBalance, expectedJusdBalance)) {
            revert UnexpectedBalance(address(JUSD), expectedJusdBalance, actualJusdBalance);
        }

        uint256 actualSvJusdBalance = IERC20(address(SV_JUSD)).balanceOf(address(this));
        if (_amountsDiffer(actualSvJusdBalance, expectedSvJusdBalance)) {
            revert UnexpectedBalance(address(SV_JUSD), expectedSvJusdBalance, actualSvJusdBalance);
        }

        uint256 actualJuiceBalance = JUICE.balanceOf(address(this));
        if (_amountsDiffer(actualJuiceBalance, expectedJuiceBalance)) {
            revert UnexpectedBalance(address(JUICE), expectedJuiceBalance, actualJuiceBalance);
        }
    }

    function _isUnsupportedStageOneOutput(address tokenOut) private view returns (bool) {
        return
            tokenOut == NATIVE_TOKEN ||
            tokenOut == address(JUSD) ||
            tokenOut == address(SV_JUSD) ||
            tokenOut == address(JUICE) ||
            tokenOut == address(WCBTC);
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

    function jusdToSvJusd(uint256 jusdAmount) external view returns (uint256) {
        return SV_JUSD.convertToShares(jusdAmount);
    }

    function svJusdToJusd(uint256 svJusdAmount) external view returns (uint256) {
        return SV_JUSD.convertToAssets(svJusdAmount);
    }

    function juiceToJusd(uint256 juiceAmount) external view returns (uint256) {
        return JUICE.calculateProceeds(juiceAmount);
    }

    function jusdToJuice(uint256 jusdAmount) external view returns (uint256) {
        return JUICE.calculateShares(jusdAmount);
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
