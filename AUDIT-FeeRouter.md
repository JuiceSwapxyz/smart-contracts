# Audit Report — JuiceSwapFeeRouter / FeeCollectorV2 / ProtocolFeeKeeper

**Scope:** branch `feat/fee-router-and-collector-v2`, three new contracts plus interface and test mock changes.
**Method:** five review passes (manual code walks, static-analyser-class checks, gas profile, coverage, hostile-mindset attack-tree).
**Date:** 2026-05-11.

This is the "if I get hacked I lose my life" pass. Findings are graded by **realistic impact**, not by what reads well.

---

## TL;DR

- **0 Critical** findings (funds at risk).
- **0 High** findings.
- **2 Medium** findings — both fixed in this branch.
- **3 Low / 2 Informational** — documented; no action required for this PR.
- **1 Mandatory pre-mainnet item**: a Citrea-fork test must be executed before deployment. Scaffold added; not yet runnable without an RPC URL.

---

## Findings

### M-1 — Bridge ↔ JUSD wiring not validated (FIXED)

**Status:** Fixed (`IFeeRouterStablecoinBridge.JUSD()` added; constructor now requires `bridge.JUSD() == _jusd` for both bridges).

The constructor previously checked `bridge.usd() == sourceToken` but not `bridge.JUSD() == _jusd`. A misdeploy could have wired a bridge that produces some *other* stablecoin pretending to be JUSD — fees would land at FEE_COLLECTOR as the wrong token. Not exploitable post-deploy because immutables (no setter), but the deploy script could go wrong with no on-chain signal.

**Verification:** `test/JuiceSwapFeeRouter.test.ts → rejects bridge wired to wrong JUSD (M-1)`.

### M-2 — FeeCollectorV2 trusts JUSD/Equity wiring without verification (FIXED)

**Status:** Fixed. `IEquity` extended with `JUSD()` view; FeeCollectorV2 constructor now reverts `JusdEquityMismatch` if `IEquity(_juice).JUSD() != _jusd`.

If the Equity contract internally references a different JUSD address than the one passed to FeeCollectorV2, the flow is silently broken:
- `flush()` would transfer "our" JUSD to address(JUICE) — but this JUSD is not the one Equity counts as reserve. `JUSD.equity()` does not increase.
- `burnJuiceShares()` calls `Equity.redeem(JUICE, balance)` which routes the JUSD proceeds via Equity's *internal* JUSD reference; mismatch can leave shares partially burned.

Constructor check eliminates this class of misdeploy.

**Verification:** `test/JuiceSwapFeeCollectorV2.test.ts → rejects misdeploy where Equity.JUSD() != _jusd (M-2)`.

### M-3 — No fork test against real JuiceSwap V3 / Satsuma Algebra pools (TRACKED)

**Status:** Scaffold added (`test/FeeRouter.citreaFork.test.ts`); execution **deferred to pre-deployment**.

All current tests use simplified mocks for Algebra, Uniswap V3, and the StablecoinBridge. Mocks cannot catch:

- Algebra Integral v1.9 quirks (the `deployer` field, dynamic fees, different revert codes).
- The exact JuiceSwap V3 pool layout vs the `IUniswapV3Pool` interface we depend on (`slot0` and `observe`).
- Citrea-specific StablecoinBridge governance state (mint limit reached, horizon expired, `stopped == true`).

**Mandatory pre-mainnet:**
1. Run the fork suite against a recent Citrea Mainnet block.
2. Execute a real swap through the deployed router and verify the JUSD balance in the collector increases by the expected 0.25%.
3. Verify each pool the router will use has observation cardinality ≥ 901 (the TWAP requirement). Call `increaseObservationCardinalityNext` on each pool first if needed.
4. Verify the deployed bridges report `stopped() == false`, `horizon() > now`, and `minted() < limit()`.

### L-1 — `MAX_PATH_HOPS` check uses byte-length instead of explicit hop count

**Status:** No action. The byte-length formula is exact: 20 + 23 × hops; the check `(path.length - 20) > MAX_PATH_HOPS * 23` rejects 6+ hops and accepts exactly 5. Stylistic preference only.

### L-2 — Router and bridge addresses are not `code.length`-checked at construction

**Status:** No action. Zero-address check is in place; a non-contract EOA at one of these slots would make every swap revert immediately on the first call. Operational, not security.

### L-3 — Code duplication between `flush` and `tryFlush`

**Status:** No action. Two near-identical 4-line functions with different return semantics. Pulling out a shared internal saves ~5 lines at the cost of less linear control flow. Auditor preference is to keep linear flow.

### I-1 — TWAP manipulation cost > reward

**Status:** Informational. To move the 30-min arithmetic-mean tick by 2% requires sustained pool manipulation against arbitrageurs for the full window. On a typical pool, this costs far more than the maximum gain from a single `convertAccumulated` call (capped by `MIN_CONVERT_JUSD = 100 JUSD` floor × 2% = $2 absolute upper bound on edge). Not economical.

### I-2 — Algebra `deployer` parameter passes through without validation

**Status:** Informational. Callers pass `address(0)` (factory default) per the API integration. The router does no validation. A malicious `deployer` could in principle resolve to a malicious pool, but Algebra's pool resolution is permissionless on the deployer field — any deployer that produces a *real* pool with liquidity could be used. Slippage and TWAP floors apply.

---

## Attack surface walked, no finding

These attack hypotheses were considered and rejected with reasoning:

| # | Hypothesis | Why it fails / doesn't apply |
|---|---|---|
| A | Re-entry via tokenIn ERC777 hook | `nonReentrant`; safeTransferFrom callback on ERC777 would revert because router doesn't implement `tokensReceived` |
| B | Re-entry via Algebra/V3 swap-callback | We call SwapRouter, not pools directly; SwapRouter handles its own callbacks; our contract doesn't expose `uniswapV3SwapCallback` or `algebraSwapCallback`, so a callback to us reverts |
| C | Re-entry via WCBTC unwrap → user `receive()` re-enters router | Explicitly tested: `nonReentrant` blocks → bubbles up as `NativeTransferFailed` → swap reverts. Covered by 2 hostile tests + control test in adversarial pack |
| D | Sandwich `convertAccumulated` | TWAP-based `amountOutMinimum` blocks; the 30-min window plus 2% slippage cap makes sandwich uneconomical |
| E | Cross-tx allowance escalation via max-approve | Spenders are `immutable`; cross-tx the router holds no tokens, so unlimited allowance is bounded by within-tx balance |
| F | Storage slot collision via inheritance | `Ownable` + `ReentrancyGuard` use slots 0–1; our packed scalars sit at slot 2. Verified via raw storage probe test |
| G | Delegatecall injection | No `delegatecall` anywhere in the codebase |
| H | Suicidal `selfdestruct` | Not present |
| I | Locked Ether | `receive()` rejects non-WCBTC senders; native cBTC only entered via `_pullInput` and only forwarded out via `_deliverOutput` |
| J | `tx.origin` auth | Not used |
| K | Arbitrary external `call(target, data)` | Not exposed |
| L | Integer overflow on fee math at MAX_FEE_BPS with huge amounts | Solidity 0.8 reverts; explicitly tested with 10,000-unit input at 5% |
| M | Returndata bomb via `slot0()` | Pools come from `JUICESWAP_FACTORY.getPool`; factory only deploys real V3 pools |
| N | Path-validation bypass via partial match | Inline-assembly reads first 20 and last 20 bytes of calldata path; min length 43; both addresses checked. Two negative tests cover wrong-start and wrong-end |
| O | TWAP integer overflow at extreme ticks | `OracleLibrary` from Uniswap V3 v1.4.4 (audited) handles overflow via SafeCast; we apply `SafeCast.toUint128(expectedOut)` per hop |
| P | Compromised governor escalation | Trust boundary — governor is `JuiceSwapGovernor` (14-day veto, 2% JUICE quorum). Even fully compromised, governor cannot raise fee above 5%, cannot redirect fees (immutable recipients), cannot bypass TWAP floor (compile-time floor of 5 min / 10% slippage) |
| Q | Compromised operator (Keeper) escalation | Operator can force unscheduled `setFeeProtocol` + `collectProtocol` but recipient is immutable `FEE_COLLECTOR`. No value can leak |
| R | Bridge compromise | If a bridge is compromised, an attacker can mint excess JUSD to the immutable FEE_COLLECTOR — that's a *protocol-positive* event. Inverse case (bridge refuses to mint) reverts the user swap cleanly |
| S | WCBTC compromise | Out of scope (Citrea-system contract); our interactions degrade gracefully (`withdraw` failure → `NativeTransferFailed` → revert; deposit failure → tx revert) |
| T | Degenerate same-token swap (tokenIn == tokenOut) | Falls through to `NoFeePath` revert or to the DEX router (which lacks a same-token pool) → revert |
| U | `unwrapNative=true` + non-WCBTC tokenOut | Reverts `UnwrapOnlyForWCBTC` |
| V | `msg.value` mismatch | Reverts `NativeValueMismatch` |
| W | DoS via spam `convertAccumulated` below threshold | Each call reverts and costs the caller gas; no protocol impact |
| X | Fee-rounding to attacker advantage | Always rounds toward zero, i.e. away from the protocol — never attacker-favorable |
| Y | Stuck-token "drain" via `convertAccumulated` | Possible only along a governance-set path; result lands at immutable `FEE_COLLECTOR`. No drain to attacker |
| Z | Storage-collision on upgrade | No proxies; migration = redeploy |

---

## Architectural notes (not findings)

These are design choices, not bugs. Listed so reviewers can challenge them.

1. **No emergency pause.** Even the keeper has no pause modifier. If a post-deploy bug is found, the only recourse is a governance proposal (14-day veto) to set `feeBps = 0` or `setRouteFeeEnabled(1, false)`. Mitigation: the surface is tiny (4 state-mutating functions on the collector, 6 on the router, 5 on the keeper). Smaller surface = less to break.

2. **No upgrade proxy.** Migration is redeploy + DAO-vote to point off-chain components at the new address. Eliminates proxy-class bugs; trades operational friction.

3. **Two routes baked in.** Future DEXes require redeploy. An aggregator pattern with opaque calldata would be more flexible but enlarges attack surface. Decision: explicit routes for auditability.

4. **TWAP for slippage floor, spot for swap execution.** Standard Uniswap-style design. Spot is what the user actually trades against; TWAP is the manipulation-resistant comparison.

5. **`feeBps = 25` default in constructor.** Hardcoded instead of post-deploy-set. Eliminates the bootstrap-window between deployment and first DAO call.

---

## Pre-mainnet checklist

- [ ] Fork test runs end-to-end against Citrea Mainnet at a recent block (`CITREA_FORK_URL` env var + `test/FeeRouter.citreaFork.test.ts`).
- [ ] All target pools (USDC.e/ctUSD on Satsuma; WCBTC/USDC.e tiers on JuiceSwap V3) have `observationCardinality ≥ 901`.
- [ ] Both StablecoinBridges report `stopped == false`, `horizon > now`, `minted < limit`.
- [ ] FeeRouter Constructor args verified byte-for-byte against on-chain addresses (deploy script should emit a hash of the args + diff against known values).
- [ ] After deploy, transactionally: (a) verify `router.FEE_COLLECTOR()` equals the FeeCollectorV2 address from step 1; (b) try a 1-USDC.e swap from a deployer wallet; (c) verify the collector's JUSD balance increased.
- [ ] After deploy, governance proposal to point the off-chain API/frontend at the new FeeRouter — only after the swap-verification step lands.
- [ ] Doc PR for `JuiceSwapxyz/documentation` merged before user-facing announcement.

---

## What's *not* covered

For full transparency:

- **No fuzz testing.** Hardhat doesn't ship with fuzz; Foundry/Forge would help but isn't set up. Risk: 1-in-million edge cases in fee math at extreme inputs.
- **No formal verification.** No symbolic execution against the contract state machine.
- **No third-party audit.** This document is a self-audit by the author. The recommendation is to engage an external firm (Trail of Bits, Spearbit, ChainSecurity) before mainnet.
- **No invariant tests.** Hardhat's standard pattern. Should be added in a follow-up.

---

## Sign-off

If my life depended on this contract being unhackable, I would do these things in order before deployment:

1. **Run the fork test.** (Already scaffolded.)
2. **Run a Foundry fuzz suite** on fee math and path validation.
3. **Engage an external audit firm.**
4. **Bug bounty** for 30 days post-deploy at a tier that makes it worth their time (>= $100k).
5. **Phased rollout**: deploy with `feeBps = 0` for the first 48 hours, ramp up to 25 only after no incidents.

The current state of this branch is **deploy-ready pending the fork test (item 1) and ideally item 3**.

Items 2, 4, 5 are operational additions outside the contract code itself.
