// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title JuiceSwapFeeRouter
 * @notice Governance-owned exact-input ERC20 swap overlay that settles protocol fees in JUSD.
 */
// WHY: Native value is rejected by receive() and the nonpayable swap entrypoint; this router has no ETH custody path.
// slither-disable-next-line locked-ether
contract JuiceSwapFeeRouter is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_PROTOCOL_FEE_BPS = 500;
    uint256 public constant BPS_DENOMINATOR = 10_000;

    uint256 public protocolFeeBps = 25;

    bytes4 private constant SWAP_ROUTER_02_EXACT_OUTPUT_SINGLE_SELECTOR = 0x5023b4df;
    bytes4 private constant SWAP_ROUTER_02_EXACT_OUTPUT_SELECTOR = 0x09b81346;
    bytes4 private constant LEGACY_SWAP_ROUTER_EXACT_OUTPUT_SINGLE_SELECTOR = 0xdb3e2198;
    bytes4 private constant LEGACY_SWAP_ROUTER_EXACT_OUTPUT_SELECTOR = 0xf28c0498;
    bytes4 private constant DEADLINE_LAST_EXACT_OUTPUT_SINGLE_SELECTOR = 0x5d7ef810;
    bytes4 private constant SWAP_ROUTER_02_V2_EXACT_OUTPUT_SELECTOR = 0x42712a67;
    bytes4 private constant LEGACY_V2_EXACT_OUTPUT_SELECTOR = 0x8803dbee;
    bytes4 private constant MULTICALL_SELECTOR = 0xac9650d8;
    bytes4 private constant MULTICALL_DEADLINE_SELECTOR = 0x5ae401dc;
    bytes4 private constant MULTICALL_PREVIOUS_BLOCKHASH_SELECTOR = 0x1f0464d1;

    IERC20 public immutable JUSD;
    address public immutable EQUITY;
    address public immutable JUICE;
    address public immutable WCBTC;

    mapping(address target => bool allowed) public allowedTargets;
    mapping(address target => bool allowed) public allowedFeeConverters;

    struct FeeTargetConfig {
        address target;
        bool swapAllowed;
        bool feeConverterAllowed;
    }

    struct ExactInputParams {
        address tokenIn;
        address tokenOut;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint256 deadline;
        address target;
        bytes swapCalldata;
        address feeConversionTarget;
        bytes feeConversionCalldata;
        uint256 minJusdFeeOut;
    }

    event ProtocolFeeBpsUpdated(uint256 oldProtocolFeeBps, uint256 newProtocolFeeBps);
    event ProtocolFeeCharged(
        address indexed payer,
        address indexed feeToken,
        uint256 grossAmount,
        uint256 feeAmount,
        uint256 tradeAmount
    );
    event ProtocolFeeConverted(
        address indexed feeToken,
        address indexed converter,
        uint256 feeAmount,
        uint256 jusdAmount
    );
    event FeeSwapExecuted(
        address indexed payer,
        address indexed target,
        address indexed tokenOut,
        uint256 tradeAmount,
        uint256 amountOut,
        address recipient
    );
    event FeeTargetUpdated(address indexed target, bool swapAllowed, bool feeConverterAllowed);

    error InvalidAddress();
    error InvalidAmount();
    error DeadlineExpired();
    error NativeUnsupported();
    error JuiceInputUnsupported();
    error SameTokenUnsupported();
    error ExactOutputUnsupported();
    error InvalidCalldata();
    error TargetNotAllowed(address target);
    error FeeConverterNotAllowed(address target);
    error FeeConversionRequired(address feeToken);
    error ProtocolFeeTooHigh(uint256 requested, uint256 maximum);
    error InsufficientTradeAmount(uint256 grossAmount, uint256 feeAmount);
    error BalanceDeltaMismatch(address token, uint256 expectedDelta, uint256 actualDelta);
    error UnexpectedBalance(address token, uint256 expected, uint256 actual);
    error FeeConversionFailed(address converter, bytes returndata);
    error TargetCallFailed(address target, bytes returndata);
    error InsufficientJusdFee(uint256 received, uint256 minimum);
    error InsufficientOutput(uint256 received, uint256 minimum);

    constructor(
        address jusd_,
        address equity_,
        address juice_,
        address wcbtc_,
        address owner_,
        FeeTargetConfig[] memory initialTargets
    ) Ownable(owner_) {
        if (jusd_ == address(0)) revert InvalidAddress();
        if (equity_ == address(0)) revert InvalidAddress();
        if (juice_ == address(0)) revert InvalidAddress();
        if (wcbtc_ == address(0)) revert InvalidAddress();

        JUSD = IERC20(jusd_);
        EQUITY = equity_;
        JUICE = juice_;
        WCBTC = wcbtc_;

        for (uint256 i = 0; i < initialTargets.length; i++) {
            _setFeeTarget(
                initialTargets[i].target,
                initialTargets[i].swapAllowed,
                initialTargets[i].feeConverterAllowed
            );
        }
    }

    receive() external payable {
        revert NativeUnsupported();
    }

    function setFeeTarget(address target, bool swapAllowed, bool feeConverterAllowed) external onlyOwner {
        _setFeeTarget(target, swapAllowed, feeConverterAllowed);
    }

    function setProtocolFeeBps(uint256 newProtocolFeeBps) external onlyOwner {
        if (newProtocolFeeBps > MAX_PROTOCOL_FEE_BPS) {
            revert ProtocolFeeTooHigh(newProtocolFeeBps, MAX_PROTOCOL_FEE_BPS);
        }

        uint256 oldProtocolFeeBps = protocolFeeBps;
        protocolFeeBps = newProtocolFeeBps;

        emit ProtocolFeeBpsUpdated(oldProtocolFeeBps, newProtocolFeeBps);
    }

    // WHY: Post-call balance reads are required target-agnostic output/refund proofs, and nonReentrant blocks callback reentry.
    // slither-disable-start reentrancy-balance
    function swapExactInput(
        ExactInputParams calldata params
    ) external nonReentrant returns (uint256 amountOut, uint256 protocolFee, uint256 jusdFeeAmount) {
        _validateExactInputParams(params);

        IERC20 tokenIn = IERC20(params.tokenIn);
        IERC20 tokenOut = IERC20(params.tokenOut);

        uint256 tokenInBalanceBefore = tokenIn.balanceOf(address(this));
        tokenIn.safeTransferFrom(msg.sender, address(this), params.amountIn);

        uint256 receivedInput = tokenIn.balanceOf(address(this)) - tokenInBalanceBefore;
        if (receivedInput < params.amountIn || receivedInput > params.amountIn) {
            revert BalanceDeltaMismatch(params.tokenIn, params.amountIn, receivedInput);
        }

        protocolFee = _protocolFee(params.amountIn);
        uint256 tradeAmount = params.amountIn - protocolFee;
        if (tradeAmount < 1) {
            revert InsufficientTradeAmount(params.amountIn, protocolFee);
        }

        emit ProtocolFeeCharged(msg.sender, params.tokenIn, params.amountIn, protocolFee, tradeAmount);

        if (protocolFee > 0) {
            jusdFeeAmount = _creditProtocolFee(tokenIn, params, protocolFee);
        }

        uint256 expectedTradeBalance = tokenInBalanceBefore + tradeAmount;
        uint256 actualTradeBalance = tokenIn.balanceOf(address(this));
        if (actualTradeBalance < expectedTradeBalance || actualTradeBalance > expectedTradeBalance) {
            revert UnexpectedBalance(params.tokenIn, expectedTradeBalance, actualTradeBalance);
        }

        uint256 outputBefore = tokenOut.balanceOf(address(this));
        _executeSwapTarget(tokenIn, params.target, tradeAmount, params.swapCalldata);

        amountOut = tokenOut.balanceOf(address(this)) - outputBefore;
        if (amountOut < 1 || amountOut < params.amountOutMinimum) {
            revert InsufficientOutput(amountOut, params.amountOutMinimum);
        }

        _transferOutput(tokenOut, params.tokenOut, params.recipient, amountOut);
        _refundUnspentInput(tokenIn, params.tokenIn, tokenInBalanceBefore);

        emit FeeSwapExecuted(msg.sender, params.target, params.tokenOut, tradeAmount, amountOut, params.recipient);
    }
    // slither-disable-end reentrancy-balance

    function _setFeeTarget(address target, bool swapAllowed, bool feeConverterAllowed) private {
        if (target == address(0) || target == address(this)) revert InvalidAddress();
        if ((swapAllowed || feeConverterAllowed) && target.code.length == 0) revert InvalidAddress();

        allowedTargets[target] = swapAllowed;
        allowedFeeConverters[target] = feeConverterAllowed;

        emit FeeTargetUpdated(target, swapAllowed, feeConverterAllowed);
    }

    function _validateExactInputParams(ExactInputParams calldata params) private view {
        if (msg.value > 0) revert NativeUnsupported();
        if (block.timestamp > params.deadline) revert DeadlineExpired();
        if (params.amountIn < 1) revert InvalidAmount();
        if (params.tokenIn == address(0) || params.tokenOut == address(0)) revert NativeUnsupported();
        if (params.recipient == address(0) || params.recipient == address(this)) revert InvalidAddress();
        if (params.target == address(0) || params.target.code.length == 0) revert InvalidAddress();
        if (params.tokenIn == JUICE) revert JuiceInputUnsupported();
        if (params.tokenIn == params.tokenOut) revert SameTokenUnsupported();
        if (!allowedTargets[params.target]) revert TargetNotAllowed(params.target);

        _rejectUnsupportedSwapSelector(params.swapCalldata);
    }

    function _rejectUnsupportedSwapSelector(bytes calldata swapCalldata) private pure {
        if (swapCalldata.length < 4) revert InvalidCalldata();

        bytes4 selector;
        assembly {
            selector := calldataload(swapCalldata.offset)
        }

        if (
            selector == SWAP_ROUTER_02_EXACT_OUTPUT_SINGLE_SELECTOR ||
            selector == SWAP_ROUTER_02_EXACT_OUTPUT_SELECTOR ||
            selector == LEGACY_SWAP_ROUTER_EXACT_OUTPUT_SINGLE_SELECTOR ||
            selector == LEGACY_SWAP_ROUTER_EXACT_OUTPUT_SELECTOR ||
            selector == DEADLINE_LAST_EXACT_OUTPUT_SINGLE_SELECTOR ||
            selector == SWAP_ROUTER_02_V2_EXACT_OUTPUT_SELECTOR ||
            selector == LEGACY_V2_EXACT_OUTPUT_SELECTOR ||
            selector == MULTICALL_SELECTOR ||
            selector == MULTICALL_DEADLINE_SELECTOR ||
            selector == MULTICALL_PREVIOUS_BLOCKHASH_SELECTOR
        ) {
            revert ExactOutputUnsupported();
        }
    }

    // WHY: The JUSD balance delta after converter.call is the required proof that non-JUSD fees settled as JUSD.
    // slither-disable-start reentrancy-balance
    function _creditProtocolFee(
        IERC20 tokenIn,
        ExactInputParams calldata params,
        uint256 protocolFee
    ) private returns (uint256 jusdFeeAmount) {
        if (params.tokenIn == address(JUSD)) {
            JUSD.safeTransfer(EQUITY, protocolFee);
            return protocolFee;
        }

        if (params.feeConversionTarget == address(0)) revert FeeConversionRequired(params.tokenIn);
        if (params.feeConversionTarget.code.length == 0) revert InvalidAddress();
        if (!allowedFeeConverters[params.feeConversionTarget]) {
            revert FeeConverterNotAllowed(params.feeConversionTarget);
        }
        if (params.minJusdFeeOut < 1) revert InvalidAmount();

        uint256 jusdBefore = JUSD.balanceOf(address(this));
        tokenIn.forceApprove(params.feeConversionTarget, protocolFee);

        (bool success, bytes memory returndata) = params.feeConversionTarget.call(params.feeConversionCalldata);
        tokenIn.forceApprove(params.feeConversionTarget, 0);
        if (!success) revert FeeConversionFailed(params.feeConversionTarget, returndata);

        jusdFeeAmount = JUSD.balanceOf(address(this)) - jusdBefore;
        if (jusdFeeAmount < params.minJusdFeeOut) {
            revert InsufficientJusdFee(jusdFeeAmount, params.minJusdFeeOut);
        }

        JUSD.safeTransfer(EQUITY, jusdFeeAmount);
        emit ProtocolFeeConverted(params.tokenIn, params.feeConversionTarget, protocolFee, jusdFeeAmount);
    }
    // slither-disable-end reentrancy-balance

    function _executeSwapTarget(
        IERC20 tokenIn,
        address target,
        uint256 tradeAmount,
        bytes calldata swapCalldata
    ) private {
        tokenIn.forceApprove(target, tradeAmount);

        (bool success, bytes memory returndata) = target.call(swapCalldata);
        tokenIn.forceApprove(target, 0);
        if (!success) revert TargetCallFailed(target, returndata);
    }

    function _transferOutput(IERC20 tokenOut, address tokenOutAddress, address recipient, uint256 amountOut) private {
        uint256 recipientBefore = tokenOut.balanceOf(recipient);
        tokenOut.safeTransfer(recipient, amountOut);

        uint256 recipientDelta = tokenOut.balanceOf(recipient) - recipientBefore;
        if (recipientDelta < amountOut || recipientDelta > amountOut) {
            revert BalanceDeltaMismatch(tokenOutAddress, amountOut, recipientDelta);
        }
    }

    function _refundUnspentInput(IERC20 tokenIn, address tokenInAddress, uint256 tokenInBalanceBefore) private {
        uint256 tokenInBalanceAfter = tokenIn.balanceOf(address(this));
        if (tokenInBalanceAfter <= tokenInBalanceBefore) return;

        uint256 refundAmount = tokenInBalanceAfter - tokenInBalanceBefore;
        uint256 payerBalanceBefore = tokenIn.balanceOf(msg.sender);
        tokenIn.safeTransfer(msg.sender, refundAmount);

        uint256 payerDelta = tokenIn.balanceOf(msg.sender) - payerBalanceBefore;
        if (payerDelta < refundAmount || payerDelta > refundAmount) {
            revert BalanceDeltaMismatch(tokenInAddress, refundAmount, payerDelta);
        }
    }

    function _protocolFee(uint256 amountIn) private view returns (uint256) {
        return Math.mulDiv(amountIn, protocolFeeBps, BPS_DENOMINATOR, Math.Rounding.Ceil);
    }
}
