// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./IEquity.sol";

/**
 * @title JuiceSwapFeeCollectorV2
 * @notice Strict sink for protocol fees. Holds JUSD, JUICE and any other
 *         ERC20 deposited to it, but exposes **only three operations**:
 *
 *           1. flush()             JUSD balance  -> JUICE Equity (threshold-gated)
 *           2. tryFlush()          same, silent below threshold
 *           3. burnJuiceShares()   JUICE balance -> JUICE Equity (self-burn)
 *
 *         There are **no swap functions, no external approvals, no generic
 *         calls and no owner-controlled token withdrawals**. Any ERC20 sent
 *         to this contract that is not JUSD or JUICE is permanently stuck.
 *         This is an explicit security trade-off: zero approval surface in
 *         exchange for the inability to recover non-whitelisted tokens.
 *
 * @dev Security envelope:
 *      - `JUSD` and `JUICE` are immutable. JUSD held here has exactly one
 *        exit: `safeTransfer(JUICE, balance)` in `_flushJusd()`. JUICE held
 *        here has exactly one exit: `safeTransfer(JUICE, balance)` in
 *        `_burnJuice()`. Both recipients are the same hardcoded immutable.
 *      - No `approve` / `forceApprove` is ever issued anywhere in this
 *        contract. No external contract is ever granted spending rights.
 *      - No `setRecipient`, no `setSwapRouter`, no `rescue`, no
 *        `emergencyWithdraw`, no `multicall`, no `call(target,data)`.
 *      - Both flush and burn are permissionless: anyone can pay gas to
 *        push state in the only direction it is allowed to move.
 */
contract JuiceSwapFeeCollectorV2 is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Immutable security anchors
    // ---------------------------------------------------------------------

    /// @notice JUSD stablecoin. The only token this contract knows how to flush.
    IERC20 public immutable JUSD;

    /// @notice JUICE Equity contract. Sole destination of both JUSD and JUICE.
    IEquity public immutable JUICE;

    // ---------------------------------------------------------------------
    // Governable parameters (intentionally minimal)
    // ---------------------------------------------------------------------

    /// @notice Flush step size in JUSD wei. `flush()` requires the JUSD
    ///         balance to be >= `flushStep` and then transfers exactly the
    ///         largest multiple of `flushStep` ≤ balance, leaving the
    ///         remainder in the contract for the next round.
    ///         Default 100 JUSD (100e18).
    uint256 public flushStep;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event Flushed(uint256 amount, uint256 remainder);
    event JuiceBurned(uint256 amount);
    event FlushStepUpdated(uint256 oldStep, uint256 newStep);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error InvalidAddress();
    error InvalidStep();
    error BelowThreshold();
    error NothingToBurn();
    error JusdEquityMismatch();

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    constructor(address _jusd, address _juice, address _owner) Ownable(_owner) {
        if (_jusd == address(0)) revert InvalidAddress();
        if (_juice == address(0)) revert InvalidAddress();

        // The Equity contract must reference exactly this JUSD. Without
        // this check a misdeploy could pair a JUSD token with an Equity
        // bound to a different stablecoin, leaving `burnJuiceShares`
        // silently broken (redeem proceeds would route through a JUSD
        // the Equity doesn't track).
        if (IEquity(_juice).JUSD() != _jusd) revert JusdEquityMismatch();

        JUSD = IERC20(_jusd);
        JUICE = IEquity(_juice);

        flushStep = 100 ether; // 100 JUSD
    }

    // ---------------------------------------------------------------------
    // Public actions — JUSD path
    // ---------------------------------------------------------------------

    /**
     * @notice Transfer the largest multiple of `flushStep` ≤ JUSD balance
     *         to JUICE Equity. Reverts if balance is below one full step.
     *
     *         Example with `flushStep = 100 JUSD`:
     *           balance = 250 JUSD  ⇒ flush 200 JUSD, keep 50 JUSD.
     *           balance =  99 JUSD  ⇒ revert (BelowThreshold).
     *           balance = 100 JUSD  ⇒ flush 100 JUSD, keep 0.
     *
     * @dev Recipient is hardcoded to the immutable `JUICE`. No path
     *      exists to route JUSD anywhere else.
     * @return amount The JUSD transferred to JUICE.
     */
    function flush() external nonReentrant returns (uint256 amount) {
        uint256 balance = JUSD.balanceOf(address(this));
        uint256 step = flushStep;
        if (balance < step) revert BelowThreshold();
        // Largest multiple of `step` ≤ balance. Step is enforced > 0 by
        // the setter, so the division is safe.
        amount = (balance / step) * step;
        _flushJusd(amount, balance - amount);
    }

    /**
     * @notice Same as `flush()` but returns `(false, balance)` instead of
     *         reverting when below one full step. For keeper bots that
     *         poll opportunistically.
     */
    function tryFlush() external nonReentrant returns (bool flushed, uint256 amount) {
        uint256 balance = JUSD.balanceOf(address(this));
        uint256 step = flushStep;
        if (balance < step) return (false, balance);
        amount = (balance / step) * step;
        _flushJusd(amount, balance - amount);
        flushed = true;
    }

    // ---------------------------------------------------------------------
    // Public actions — JUICE path
    // ---------------------------------------------------------------------

    /**
     * @notice Redeem the entire JUICE balance of this contract back into
     *         the JUICE Equity pot. This is a REAL burn:
     *
     *         `JUICE.redeem(address(JUICE), shares)` burns the shares
     *         (totalSupply ↓) and routes the JUSD proceeds to the Equity
     *         contract itself, which is also the JUSD reserve. Net effect:
     *         `JUSD.equity()` is unchanged but `totalSupply(JUICE)` drops,
     *         so `price() = factor × equity / totalSupply` rises.
     *
     *         Reverts if the contract holds no JUICE.
     *         Subject to Equity's `notSameBlock` guard — if JUICE was
     *         received in this block, burn must wait one block.
     *
     * @dev    Permissionless. Recipient of proceeds is hardcoded to
     *         `address(JUICE)` — no caller-chosen recipient.
     */
    function burnJuiceShares() external nonReentrant returns (uint256 amount) {
        amount = IERC20(address(JUICE)).balanceOf(address(this));
        if (amount == 0) revert NothingToBurn();
        // Sole legitimate JUICE-burn path. Target is hardcoded to the
        // JUICE Equity contract itself; proceeds (JUSD) stay in the pot,
        // shares are burned by Equity._burn() internally.
        JUICE.redeem(address(JUICE), amount);
        emit JuiceBurned(amount);
    }

    // ---------------------------------------------------------------------
    // Governance — strictly minimal
    // ---------------------------------------------------------------------

    function setFlushStep(uint256 newStep) external onlyOwner {
        if (newStep == 0) revert InvalidStep();
        emit FlushStepUpdated(flushStep, newStep);
        flushStep = newStep;
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _flushJusd(uint256 amount, uint256 remainder) internal {
        // Sole legitimate JUSD exit. Hardcoded recipient.
        JUSD.safeTransfer(address(JUICE), amount);
        emit Flushed(amount, remainder);
    }

}
