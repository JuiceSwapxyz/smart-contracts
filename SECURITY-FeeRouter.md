# Security Notes — JuiceSwapFeeRouter / FeeCollectorV2 / ProtocolFeeKeeper

This document is the audit hand-off for the `feat/fee-router-and-collector-v2` branch. It is structured as a defender's review: each section names a threat class, then states what the contracts do about it and which tests verify it.

## Components

| Contract | File | Role |
|---|---|---|
| `JuiceSwapFeeRouter` | `contracts/governance/JuiceSwapFeeRouter.sol` | Aggregator entry. Charges 0.25% (cap 5%) protocol fee on every swap routed through it. Fee is converted to JUSD before reaching the collector — either at the bridge (USDC.e/ctUSD/JUSD direct) or via a TWAP-protected V3 path (other tokens). |
| `JuiceSwapFeeCollectorV2` | `contracts/governance/JuiceSwapFeeCollectorV2.sol` | JUSD sink. Flushes JUSD in 100-JUSD steps to JUICE Equity. `burnJuiceShares()` does a real burn via `Equity.redeem(JUICE, balance)`. |
| `ProtocolFeeKeeper` | `contracts/governance/ProtocolFeeKeeper.sol` | Optional future Factory-owner wrapper for activating Uniswap-V3 protocol-fee on JuiceSwap pools. Governor + Operator split. |

## Trust model

**Mutability:** every address that could be used to steal funds is `immutable` in the FeeRouter and FeeCollectorV2 — no setters. Specifically:

- `FEE_COLLECTOR`, `JUICESWAP_ROUTER`, `SATSUMA_ROUTER`, `JUICESWAP_FACTORY`, `JUSD`, `USDC_E`, `USDC_E_BRIDGE`, `CTUSD`, `CTUSD_BRIDGE`, `WCBTC` in `JuiceSwapFeeRouter`.
- `JUSD`, `JUICE` in `JuiceSwapFeeCollectorV2`.
- `FACTORY`, `FEE_COLLECTOR`, `GOVERNOR` in `ProtocolFeeKeeper`.

Migration = redeploy. There is no upgrade proxy and no governor-callable destination-changing function.

**Governance pipeline.** All settable parameters are `onlyOwner`, where owner is `JuiceSwapGovernor`. This is **not** OpenZeppelin's `Governor`; it is a Frankencoin-style veto governor. Every state change goes through:

```
proposer pays 1000 JUSD → propose(target, calldata, ≥14d period, description)
                                      │
                                      ▼
       within the period, any holder with ≥2% JUICE voting power can veto
                                      │
                                      ▼
       after the period, anyone can execute(); call is unrestricted
```

The 1000 JUSD proposal fee is forwarded to `address(JUICE)` (Equity pot) — so even attempted attacks **pay JUICE holders**. JUICE voting power is duration-weighted (`votesDelegated` / `checkQualified` in `Equity.sol`), which makes flash-loan votes impossible.

End-to-end verified in `test/Governance.feerouter.test.ts` (propose → time-travel 14d → execute). Direct attacker call always reverts with `OwnableUnauthorizedAccount`.

## Fee path — three guaranteed properties

1. **Cap.** `MAX_FEE_BPS = 500` is a Solidity `constant`. `setFeeBps(bps)` reverts for `bps > 500`. Verified.
2. **Recipient.** All fees enter the FeeCollector. `FEE_COLLECTOR` has no setter and is `immutable`. Verified by interface scan in `test/FeeRouter.adversarial.test.ts`.
3. **Currency.** Whatever token a user trades, what reaches the collector is **always JUSD**.
   - tokenIn or tokenOut is bridgeable (JUSD/USDC.e/ctUSD): fee is converted via the immutable StablecoinBridge for that token, JUSD is minted directly to `FEE_COLLECTOR`.
   - tokenIn or tokenOut has a configured `conversionPath`: fee is parked in the token, and `convertAccumulated(token)` (permissionless) swaps it to JUSD via JuiceSwap V3 with a **TWAP-enforced** `amountOutMinimum`.
   - Neither: swap reverts with `NoFeePath`.

## TWAP slippage floor for `convertAccumulated`

This is what protects the deferred-conversion path from sandwich attacks.

- The Router reads `OracleLibrary.consult(pool, twapPeriod)` for each hop in the configured path, using the immutable `JUICESWAP_FACTORY` to resolve pool addresses.
- Default: `twapPeriod = 30 minutes`, `expectedBlockTime = 2s`, `convertMaxSlippageBps = 200` (= 2%). The minimum observation cardinality per pool is 901.
- Pools with insufficient cardinality revert with `InsufficientCardinality`. The DAO must seed cardinality (permissionless on the pool itself).
- Governance can adjust TWAP parameters via `setTwapParams`, but `twapPeriod ≥ 300s`, `expectedBlockTime ∈ [1, 60]`, `maxSlippageBps ≤ 1000` are floors enforced on-chain. A compromised governor cannot disable the TWAP guard.
- An attacker who wishes to manipulate the converted output must hold the pool tick off-equilibrium for 30 continuous minutes against arbitrageurs — economically dominant only for very large fee balances.

## FeeCollectorV2 — minimal surface

The collector exposes exactly four state-changing functions:

```
flush()             permissionless — JUSD → JUICE Equity in 100-JUSD steps
tryFlush()          same, returns (false, balance) below threshold
burnJuiceShares()   permissionless — JUICE.redeem(target=JUICE, shares)  ← REAL BURN
setFlushStep()      onlyOwner       — minimum 1 wei (no zero)
```

Plus inherited `transferOwnership` / `renounceOwnership` from Ownable.

There is **no** `rescue`, no `withdraw`, no `sweep`, no `call`, no `multicall`. There is **no external approval issued anywhere**. Verified by interface scan in `test/JuiceSwapFeeCollectorV2.test.ts` ("contract exposes ONLY: flush, tryFlush, burnJuiceShares, setFlushStep" and "no function whose name contains 'approve', 'swap', 'rescue', 'sweep', 'withdraw', 'transfer'").

**Real burn semantics.** `burnJuiceShares()` calls `JUICE.redeem(address(JUICE), shares)`. The Frankencoin-style Equity contract burns the shares (`_burn` internally) and transfers JUSD proceeds to `target`. With `target = address(JUICE)`:

- `totalSupply(JUICE)` decreases.
- `JUSD.balanceOf(JUICE)` is unchanged (proceeds go from JUICE to JUICE = no-op).
- `JUSD.equity() = JUSD.balanceOf(JUICE) - minterReserve` is unchanged.
- `price() = factor × equity / totalSupply` **rises** — every existing JUICE share is worth more JUSD.

This is the canonical Frankencoin/Equity burn pattern and is consistent with `JuiceSwapGovernor` and the existing V1 collector's behaviour. Note: subject to Equity's `notSameBlock` flash-loan guard.

## Threats considered

### Re-entrancy

- `nonReentrant` on every state-mutating external function in all three contracts.
- Balance-delta accounting on `tokenIn` (`balanceBefore` / `balanceAfter`) handles fee-on-transfer tokens that try to manipulate balance mid-call.
- `_deliverOutput` uses `.call{value: amount}("")` only after the swap completes and state is settled; the receive function rejects native value from any sender other than `WCBTC`.

### Compromised governor

A 100% compromised governor can do at most:

- Move `feeBps` anywhere in `[0, 500]` — still under hard cap.
- Toggle `feeEnabled[route]` — turn route fees off (cannot redirect them).
- Set `conversionPath[token]` to a worse pool — degrades conversion rate, but the path is still validated to end in JUSD, and the recipient is still the immutable `FEE_COLLECTOR`.
- Set `minConvertAmount[token]` to MAX — strands tokens in the router but cannot extract them.
- Set TWAP parameters within enforced floors.
- Move `flushStep` (collector) — can stall flushes but cannot redirect JUSD.

Cannot do:
- Redirect any fee. `FEE_COLLECTOR`, `JUICE`, all bridges, all routers are immutable.
- Raise fee above 5%.
- Bypass the TWAP slippage floor (period floor 5min, slippage cap 10%).
- Approve tokens to an attacker — every approval target in the codebase is immutable.

### Compromised proposer (governance)

Anyone can submit a proposal by paying 1000 JUSD. Worst case if a malicious proposal is missed by all JUICE holders for 14 days: it executes — but it can do nothing in the list above (theft is impossible by the immutability constraints). Cost-of-attack: 1000 JUSD per attempt, paid into the same pot the proposal would harm.

### Sandwich on `convertAccumulated`

Blocked by on-chain TWAP `amountOutMinimum`. See "TWAP slippage floor" above.

### Storage manipulation / proxy injection

No proxy. All address-state is `immutable`. Storage layout cannot be modified after deploy.

### Native cBTC handling

- `swap*Single*(..., unwrapNative=true)` only with `tokenOut == WCBTC`; otherwise revert `UnwrapOnlyForWCBTC`.
- `msg.value > 0` only with `tokenIn == WCBTC`; otherwise revert `NativeOnlyWithWCBTC`.
- `msg.value != amountIn` reverts `NativeValueMismatch`.
- `receive()` rejects any native transfer that isn't from `WCBTC` (i.e. from the unwrap step).
- Failed native-send during unwrap reverts `NativeTransferFailed`, rolling back the swap.

### Stuck tokens

Any ERC20 sent directly to the FeeCollector that isn't JUSD or JUICE is permanently locked. This is an explicit design trade-off — chosen over a `rescue` function because a rescue function is a drain vector. The router's `convertAccumulated` covers the *intended* path for non-bridgeable fee tokens; ad-hoc dust is accepted as permanent dead-locked.

### Test-suite hygiene note

When the entire repo suite is run in a single Hardhat process, the existing Gateway test files exhibit `loadFixture` cache contamination depending on the alphabetical run order. Each test file passes cleanly in isolation. This is a Hardhat snapshot-cache quirk, **not** a contract issue. Recommended CI: run each test file in a separate Hardhat invocation (`for f in test/*.ts; do npx hardhat test "$f"; done`).

## Test inventory

```
test/JuiceSwapFeeRouter.test.ts       34 tests   route fee, TWAP, native cBTC, path validation
test/JuiceSwapFeeCollectorV2.test.ts  16 tests   flush, step math, real burn, no rescue surface
test/ProtocolFeeKeeper.test.ts        14 tests   governor/operator separation, hardcoded recipient
test/FeeRouter.adversarial.test.ts    15 tests   owner-compromise, path tricks, math overflow
test/Governance.feerouter.test.ts      3 tests   end-to-end propose → wait 14d → execute
```

All FeeRouter / Collector / Keeper / Governance suites green when run in isolation.

## Recommended doc updates (for `JuiceSwapxyz/documentation`)

1. `swap.md` — add a "Protocol fee" section describing the 0.25% (cap 5%) fee on Satsuma routes, off by default on JuiceSwap-V3 routes.
2. `smart-contracts.md` — extend the contract table with `JuiceSwapFeeRouter`, `JuiceSwapFeeCollectorV2`, `ProtocolFeeKeeper`.
3. `governance.md` — clarify that the FeeRouter is `Ownable(JuiceSwapGovernor)`, not an OZ Governor — same veto-style governance as the rest of the protocol.

PR-ready text in `docs/jsx-fee-router-pr.md` (in this branch).
