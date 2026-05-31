// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IJuiceSwapGateway} from "./interfaces/IJuiceSwapGateway.sol";
import {IStablecoinBridge} from "./interfaces/IStablecoinBridge.sol";
import {IJuiceDollar} from "@juicedollar/jusd/contracts/interface/IJuiceDollar.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
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
 * @notice Fee gateway that mirrors JuiceSwapGateway v1 swap/conversion behavior.
 * @dev V2 adds a 25 bps JUSD protocol fee routed to the JUICE/Equity reserve on every swap/conversion path.
 *      Liquidity and pool management remain intentionally out of scope and stay on JuiceSwapGateway v1.
 */
// WHY: V1-compatible payable entrypoints are required, but Stage 1 rejects msg.value and receive reverts.
// slither-disable-start locked-ether
contract JuiceSwapGatewayV2 is IJuiceSwapGateway, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable JUSD;
    IERC4626 public immutable SV_JUSD;
    IEquityV2 public immutable JUICE;
    IWrappedCBTCV2 public immutable WCBTC;
    ISwapRouterV2 public immutable SWAP_ROUTER;
    INonfungiblePositionManagerV2 public immutable POSITION_MANAGER;
    IUniswapV3FactoryV2 public immutable FACTORY;

    uint8 public immutable JUSD_DECIMALS;

    struct BridgeConfig {
        IStablecoinBridge bridge;
        uint8 decimals;
    }

    mapping(address => BridgeConfig) private _bridgeConfigs;
    address[] private _bridgedTokens;

    address private constant NATIVE_TOKEN = address(0);
    uint24 public constant DEFAULT_FEE = 3000;
    uint256 public constant PROTOCOL_FEE_BPS = 25;
    uint256 public constant MAX_PROTOCOL_FEE_BPS = 500;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public protocolFeeBps = PROTOCOL_FEE_BPS;

    error InvalidToken();
    error InvalidAmount();
    error InsufficientOutput();
    error TransferFailed();
    error DeadlineExpired();
    error DirectTransferNotAccepted();
    error InvalidFee(uint24 fee);
    error NotImplemented();
    error InsufficientTradeAmount(uint256 grossAmount, uint256 feeAmount);
    error BalanceDeltaMismatch(address token, uint256 expectedDelta, uint256 actualDelta);
    error UnexpectedBalance(address token, uint256 expected, uint256 actual);
    error BridgedTokenAlreadyExists(address token);
    error BridgedTokenNotFound(address token);
    error InvalidBridgeConfig();
    error BridgeNotApprovedMinter(address bridge);
    error BridgeStopped(address bridge);

    event ProtocolFeeToEquity(address indexed payer, uint256 jusdAmount);
    event ProtocolFeeBpsUpdated(uint256 oldBps, uint256 newBps);

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
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (amountIn < 1) revert InvalidAmount();
        if (to == address(0)) revert InvalidToken();
        if (tokenIn == NATIVE_TOKEN) {
            if (msg.value != amountIn) revert InvalidAmount();
        } else if (msg.value > 0) {
            revert DirectTransferNotAccepted();
        }

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
        if ((protocolFeeBps > 0 && protocolFee < 1) || tradeAmount < 1) {
            revert InsufficientTradeAmount(amountIn, protocolFee);
        }

        if (protocolFee > 0) {
            _chargeProtocolFeeToEquity(protocolFee);
        }

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

    function setProtocolFeeBps(uint256 newBps) external onlyOwner {
        require(newBps <= MAX_PROTOCOL_FEE_BPS, "Protocol fee too high");
        uint256 oldBps = protocolFeeBps;
        protocolFeeBps = newBps;
        emit ProtocolFeeBpsUpdated(oldBps, newBps);
    }

    function _protocolFee(uint256 amountIn) internal view returns (uint256) {
        return Math.mulDiv(amountIn, protocolFeeBps, BPS_DENOMINATOR, Math.Rounding.Ceil);
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

    function _isRegisteredBridgeToken(address token) private view returns (bool) {
        return address(_bridgeConfigs[token].bridge) != address(0);
    }

    function _isStageTwoAsset(address token) private view returns (bool) {
        return
            token == address(JUSD) ||
            token == address(SV_JUSD) ||
            token == address(JUICE) ||
            _isRegisteredBridgeToken(token);
    }

    function _isStageTwoDirectConversion(address tokenIn, address tokenOut) private view returns (bool) {
        if (tokenIn == NATIVE_TOKEN && tokenOut == address(WCBTC)) return true;
        if (tokenIn == address(WCBTC) && tokenOut == NATIVE_TOKEN) return true;
        return tokenIn != tokenOut && _isStageTwoAsset(tokenIn) && _isStageTwoAsset(tokenOut);
    }

    function _swapStageTwoDirect(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address to
    ) private returns (uint256 amountOut) {
        if (tokenIn == NATIVE_TOKEN || tokenOut == NATIVE_TOKEN) {
            return _swapNativeCbtc(tokenIn, tokenOut, amountIn, minAmountOut, to);
        }

        uint256 expectedJusdBalance = JUSD.balanceOf(address(this));
        uint256 expectedSvJusdBalance = IERC20(address(SV_JUSD)).balanceOf(address(this));
        uint256 expectedJuiceBalance = JUICE.balanceOf(address(this));

        uint256 grossJusd = _collectStageTwoInput(tokenIn, amountIn);
        uint256 protocolFee = _protocolFee(grossJusd);
        uint256 netJusd = grossJusd - protocolFee;
        if ((protocolFeeBps > 0 && protocolFee < 1) || netJusd < 1) {
            revert InsufficientTradeAmount(grossJusd, protocolFee);
        }

        if (protocolFee > 0) {
            _chargeProtocolFeeToEquity(protocolFee);
        }

        amountOut = _convertStageTwoOutput(tokenOut, netJusd, to);
        if (amountOut < 1 || amountOut < minAmountOut) revert InsufficientOutput();

        _assertGatewayStageTwoBalances(expectedJusdBalance, expectedSvJusdBalance, expectedJuiceBalance);

        emit SwapExecuted(msg.sender, tokenIn, tokenOut, amountIn, amountOut);
        return amountOut;
    }

    // WHY: Native unwrap is caller-funded, entrypoint-protected by nonReentrant, and residual balances are asserted.
    // slither-disable-start reentrancy-balance
    function _swapNativeCbtc(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address to
    ) private returns (uint256 amountOut) {
        if (tokenIn == NATIVE_TOKEN && tokenOut == address(WCBTC)) {
            uint256 expectedNativeBalance = address(this).balance - amountIn;
            uint256 expectedWcbtcBalance = WCBTC.balanceOf(address(this));

            WCBTC.deposit{value: amountIn}();
            amountOut = _transferStageTwoOutput(IERC20(address(WCBTC)), address(WCBTC), amountIn, to);

            _assertTokenBalance(IERC20(address(WCBTC)), address(WCBTC), address(this), expectedWcbtcBalance);
            _assertNativeBalance(expectedNativeBalance);
        } else if (tokenIn == address(WCBTC) && tokenOut == NATIVE_TOKEN) {
            uint256 expectedWcbtcBalance = WCBTC.balanceOf(address(this));
            uint256 expectedNativeBalance = address(this).balance;

            IERC20 wcbtc = IERC20(address(WCBTC));
            wcbtc.safeTransferFrom(msg.sender, address(this), amountIn);
            uint256 receivedWcbtc = _checkedBalanceDelta(
                wcbtc,
                address(WCBTC),
                address(this),
                expectedWcbtcBalance,
                amountIn
            );

            WCBTC.withdraw(receivedWcbtc);
            _transferNative(to, receivedWcbtc);
            amountOut = receivedWcbtc;

            _assertTokenBalance(wcbtc, address(WCBTC), address(this), expectedWcbtcBalance);
            _assertNativeBalance(expectedNativeBalance);
        } else {
            revert NotImplemented();
        }

        if (amountOut < 1 || amountOut < minAmountOut) revert InsufficientOutput();

        emit SwapExecuted(msg.sender, tokenIn, tokenOut, amountIn, amountOut);
        return amountOut;
    }
    // slither-disable-end reentrancy-balance

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

        BridgeConfig storage config = _bridgeConfigs[tokenIn];
        if (address(config.bridge) != address(0)) {
            IERC20 bridgedToken = IERC20(tokenIn);
            uint256 bridgedBalanceBefore = bridgedToken.balanceOf(address(this));
            bridgedToken.safeTransferFrom(msg.sender, address(this), amountIn);
            uint256 receivedBridged = _checkedBalanceDelta(
                bridgedToken,
                tokenIn,
                address(this),
                bridgedBalanceBefore,
                amountIn
            );

            uint256 jusdMintBalanceBefore = JUSD.balanceOf(address(this));
            config.bridge.mint(receivedBridged);
            uint256 mintedJusd = _bridgedToJusdAmount(receivedBridged, config.decimals);
            return _checkedBalanceDelta(JUSD, address(JUSD), address(this), jusdMintBalanceBefore, mintedJusd);
        }

        if (tokenIn == address(JUICE)) {
            uint256 jusdProceedsBalanceBefore = JUSD.balanceOf(address(this));
            uint256 proceeds = JUICE.redeemFrom(msg.sender, address(this), amountIn, 0);
            return _checkedBalanceDelta(JUSD, address(JUSD), address(this), jusdProceedsBalanceBefore, proceeds);
        }

        revert InvalidToken();
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

        BridgeConfig storage config = _bridgeConfigs[tokenOut];
        if (address(config.bridge) != address(0)) {
            uint256 recipientBalanceBefore = IERC20(tokenOut).balanceOf(to);
            uint256 bridgedAmount = _jusdToBridgedAmount(netJusd, config.decimals);
            config.bridge.burnAndSend(to, netJusd);
            return _checkedBalanceDelta(IERC20(tokenOut), tokenOut, to, recipientBalanceBefore, bridgedAmount);
        }

        if (tokenOut == address(JUICE)) {
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

        revert InvalidToken();
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
        _assertTokenBalance(JUSD, address(JUSD), address(this), expectedJusdBalance);

        _assertTokenBalance(IERC20(address(SV_JUSD)), address(SV_JUSD), address(this), expectedSvJusdBalance);

        _assertTokenBalance(JUICE, address(JUICE), address(this), expectedJuiceBalance);
    }

    function _assertTokenBalance(
        IERC20 token,
        address tokenAddress,
        address account,
        uint256 expectedBalance
    ) private view {
        uint256 actualBalance = token.balanceOf(account);
        if (_amountsDiffer(actualBalance, expectedBalance)) {
            revert UnexpectedBalance(tokenAddress, expectedBalance, actualBalance);
        }
    }

    function _assertNativeBalance(uint256 expectedBalance) private view {
        uint256 actualBalance = address(this).balance;
        if (_amountsDiffer(actualBalance, expectedBalance)) {
            revert UnexpectedBalance(NATIVE_TOKEN, expectedBalance, actualBalance);
        }
    }

    function _transferNative(address to, uint256 amount) private {
        // WHY: WCBTC unwrap must forward caller-funded native output to the caller-selected recipient.
        // slither-disable-next-line arbitrary-send-eth
        (bool success, ) = to.call{value: amount}("");
        if (!success) revert TransferFailed();
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

    /// @notice Liquidity management is intentionally out of scope for this fee gateway.
    /// @dev Use JuiceSwapGateway v1 for liquidity operations; this placeholder deliberately reverts with NotImplemented.
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

    /// @notice Position liquidity increases are intentionally out of scope for this fee gateway.
    /// @dev Use JuiceSwapGateway v1 for liquidity operations; this placeholder deliberately reverts with NotImplemented.
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

    /// @notice Position liquidity removal is intentionally out of scope for this fee gateway.
    /// @dev Use JuiceSwapGateway v1 for liquidity operations; this placeholder deliberately reverts with NotImplemented.
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

    function bridgedToSvJusd(address bridgedToken, uint256 amount) external view returns (uint256) {
        BridgeConfig storage config = _bridgeConfigs[bridgedToken];
        if (address(config.bridge) == address(0)) revert BridgedTokenNotFound(bridgedToken);
        return SV_JUSD.convertToShares(_bridgedToJusdAmount(amount, config.decimals));
    }

    function svJusdToBridged(address bridgedToken, uint256 svJusdAmount) external view returns (uint256) {
        BridgeConfig storage config = _bridgeConfigs[bridgedToken];
        if (address(config.bridge) == address(0)) revert BridgedTokenNotFound(bridgedToken);
        return _jusdToBridgedAmount(SV_JUSD.convertToAssets(svJusdAmount), config.decimals);
    }

    function isBridgedToken(address token) external view returns (bool) {
        return _isRegisteredBridgeToken(token);
    }

    function getBridgedTokens() external view returns (address[] memory) {
        return _bridgedTokens;
    }

    function registerBridgedToken(address bridge) external {
        if (bridge == address(0)) revert InvalidBridgeConfig();

        IStablecoinBridge bridgeContract = IStablecoinBridge(bridge);
        address token = bridgeContract.usd();
        if (token == address(0)) revert InvalidBridgeConfig();
        if (_bridgeConfigs[token].bridge != IStablecoinBridge(address(0))) {
            revert BridgedTokenAlreadyExists(token);
        }
        if (bridgeContract.JUSD() != address(JUSD)) revert InvalidBridgeConfig();
        if (!IJuiceDollar(address(JUSD)).isMinter(bridge)) revert BridgeNotApprovedMinter(bridge);
        if (bridgeContract.stopped()) revert BridgeStopped(bridge);

        uint8 decimals = IERC20Metadata(token).decimals();
        _bridgeConfigs[token] = BridgeConfig({bridge: bridgeContract, decimals: decimals});
        _bridgedTokens.push(token);

        IERC20(token).forceApprove(bridge, type(uint256).max);
        JUSD.forceApprove(bridge, type(uint256).max);

        emit BridgedTokenRegistered(token, bridge, msg.sender, decimals);
    }

    function getBridgeStatus(address bridgedToken) external view returns (BridgeStatus memory) {
        BridgeConfig storage config = _bridgeConfigs[bridgedToken];
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
        bool canMint = true;
        string memory mintReason = "";
        uint256 mintCapacity = 0;

        if (bridge.stopped()) {
            canMint = false;
            mintReason = "Bridge stopped";
        } else if (block.timestamp > bridge.horizon()) {
            canMint = false;
            mintReason = "Bridge expired";
        } else {
            uint256 minted = bridge.minted();
            uint256 limit = bridge.limit();
            if (minted >= limit) {
                canMint = false;
                mintReason = "Limit reached";
            } else {
                mintCapacity = limit - minted;
            }
        }

        uint256 bridgeBalance = IERC20(bridge.usd()).balanceOf(address(bridge));
        bool canBurn = bridgeBalance > 0;

        return
            BridgeStatus({
                canMint: canMint,
                canBurn: canBurn,
                mintCapacity: mintCapacity,
                burnCapacity: bridgeBalance,
                mintBlockReason: mintReason,
                burnBlockReason: canBurn ? "" : "Insufficient bridge liquidity"
            });
    }

    /// @notice Pool creation is intentionally out of scope for this fee gateway.
    /// @dev Use JuiceSwapGateway v1 for pool management; this placeholder deliberately reverts with NotImplemented.
    function createPool(address, address, uint24, uint160) external pure returns (address) {
        _stageTwo();
    }

    /// @notice Pool creation with initial liquidity is intentionally out of scope for this fee gateway.
    /// @dev Use JuiceSwapGateway v1 for pool and liquidity management; this placeholder deliberately reverts with NotImplemented.
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

    /// @notice Pool lookup is intentionally out of scope for this fee gateway.
    /// @dev Use JuiceSwapGateway v1 for pool lookup; this placeholder deliberately reverts with NotImplemented.
    function getPool(address, address, uint24) external pure returns (address, bool) {
        _stageTwo();
    }

    function _bridgedToJusdAmount(uint256 bridgedAmount, uint8 bridgedDecimals) private view returns (uint256) {
        if (bridgedDecimals < JUSD_DECIMALS) {
            return bridgedAmount * 10 ** (JUSD_DECIMALS - bridgedDecimals);
        }
        if (bridgedDecimals > JUSD_DECIMALS) {
            return bridgedAmount / 10 ** (bridgedDecimals - JUSD_DECIMALS);
        }
        return bridgedAmount;
    }

    function _jusdToBridgedAmount(uint256 jusdAmount, uint8 bridgedDecimals) private view returns (uint256) {
        if (JUSD_DECIMALS > bridgedDecimals) {
            return jusdAmount / 10 ** (JUSD_DECIMALS - bridgedDecimals);
        }
        if (JUSD_DECIMALS < bridgedDecimals) {
            return jusdAmount * 10 ** (bridgedDecimals - JUSD_DECIMALS);
        }
        return jusdAmount;
    }

    receive() external payable {
        if (msg.sender != address(WCBTC)) revert DirectTransferNotAccepted();
    }
}
// slither-disable-end locked-ether
