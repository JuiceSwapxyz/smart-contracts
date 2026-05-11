# Documentation PR — Fee Router / Collector V2 / Protocol Fee Keeper

Paste these three sections into the indicated files in `JuiceSwapxyz/documentation` (`src/`).

---

## 1) `swap.md` — add a "Protocol fee" section

> ### Protocol fee
>
> Trades routed through `JuiceSwapFeeRouter` pay a protocol fee in basis
> points (BPS) of the input amount. The fee is **always converted to JUSD**
> before it reaches the protocol's `JuiceSwapFeeCollector`, where it
> accumulates and is periodically flushed to the JUICE Equity pot —
> raising the price of every JUICE share.
>
> | Parameter | Default | Hard cap | Governable by |
> |---|---|---|---|
> | `feeBps` | **25 bps** (0.25%) | **500 bps** (5%) | DAO (`JuiceSwapGovernor`) |
> | `feeEnabled[ROUTE_SATSUMA]` | **true** | — | DAO |
> | `feeEnabled[ROUTE_JUICESWAP_V3]` | **false** | — | DAO |
>
> #### How the fee reaches JUSD
>
> | Trade pair | Mechanism |
> |---|---|
> | One side is JUSD | Fee is taken directly in JUSD, transferred to the collector. |
> | One side is USDC.e or ctUSD | Fee is converted to JUSD via the corresponding `StablecoinBridge` and delivered to the collector. |
> | Neither side is a bridge-stable but DAO has set a `conversionPath` for one of the tokens | Fee is parked in that token; `convertAccumulated(token)` (permissionless) swaps it to JUSD via JuiceSwap V3 with a 30-minute TWAP slippage floor. |
> | Neither side bridgeable and no conversion path configured | Swap reverts with `NoFeePath`. |
>
> #### Why all fees become JUSD
>
> The collector accepts only JUSD. No random ERC-20 is ever held there, so
> there is no path through which a token approval could be issued or
> abused. This is enforced by `JuiceSwapFeeCollectorV2` having no
> external approval, no rescue function, no generic call, and only two
> exits: JUSD to JUICE (flush) and JUICE shares back to the Equity
> contract for a real burn.
>
> #### Flush threshold
>
> The collector flushes JUSD to JUICE Equity in **100-JUSD steps**
> (`flushStep = 100e18`). At a balance of 250 JUSD, calling `flush()`
> sends 200 JUSD to the Equity pot and leaves 50 JUSD in the collector
> for the next round. Below one full step, `flush()` reverts. The DAO can
> change `flushStep` via governor proposal.

---

## 2) `smart-contracts.md` — extend the contract table

> ### Fee infrastructure (Phase 2)
>
> | Contract | Address | Description |
> |---|---|---|
> | `JuiceSwapFeeRouter` | TBD — deploy via DAO | Aggregator entry that applies the 0.25% protocol fee, converts the fee to JUSD via StablecoinBridge or TWAP-protected V3 path, and forwards JUSD to the `JuiceSwapFeeCollectorV2`. Supports Satsuma (Algebra) and JuiceSwap V3 routes. Native cBTC supported with auto-wrap (input) and auto-unwrap (output). |
> | `JuiceSwapFeeCollectorV2` | TBD — deploy via DAO | Strict JUSD sink. Flushes accumulated JUSD to JUICE Equity in 100-JUSD steps. Permissionless `flush()` / `tryFlush()` / `burnJuiceShares()`. No swap, no approval, no rescue surface. Real burn of held JUICE shares via `Equity.redeem(JUICE, balance)`. |
> | `ProtocolFeeKeeper` | TBD — deploy via DAO (optional) | Future Factory-owner wrapper for the Uniswap-V3 `setFeeProtocol` mechanism. Governor + Operator role separation: governor sets the protocol-fee ratio (denominator in `[4, 10]`), operator only triggers `setFeeProtocol` and `collectProtocol(recipient = FEE_COLLECTOR)` on a batch of pools. Operator cannot pick fee value or recipient. |
>
> All three contracts have their critical addresses (`FEE_COLLECTOR`,
> bridges, routers, factory, JUSD, JUICE) declared `immutable`. Migration
> requires redeploy.

---

## 3) `governance.md` — clarify the Ownable pattern

> ### How DAO governance reaches the Fee Router and Collector
>
> `JuiceSwapFeeRouter`, `JuiceSwapFeeCollectorV2`, and `ProtocolFeeKeeper`
> use OpenZeppelin's `Ownable` with the owner set to `JuiceSwapGovernor`.
> This is the same Frankencoin-style veto governance the rest of the
> protocol already uses:
>
> 1. **Propose.** A user pays 1000 JUSD (forwarded directly to the JUICE
>    Equity pot) and submits `propose(target, calldata, period ≥ 14d,
>    description)`. The calldata is the function selector + arguments for
>    one of the contracts' setter functions, e.g.:
>    ```
>    abi.encodeWithSignature("setFeeBps(uint16)", 50)
>    abi.encodeWithSignature("setConversionPath(address,bytes)", token, path)
>    abi.encodeWithSignature("setFlushStep(uint256)", 200e18)
>    ```
> 2. **Veto window.** During the 14+ day period, any JUICE holder with
>    ≥2% voting power (`votesDelegated` aggregated, duration-weighted,
>    flash-loan immune) can call `veto(proposalId, helpers)` to block
>    execution permanently.
> 3. **Execute.** After the period passes and if no veto landed, anyone
>    can call `execute(proposalId)` to run the calldata against the
>    target. The contract's `onlyOwner` modifier resolves to the
>    `JuiceSwapGovernor`'s address, so the call goes through.
>
> No fee, route toggle, conversion path, or flush parameter can be
> changed except through this pipeline. Calling `setFeeBps`, `setX`, or
> any other setter directly always reverts with
> `OwnableUnauthorizedAccount`.

---

## Optional appendix — what *cannot* be governed away

The following are compile-time invariants that not even a fully
compromised governor (or a successfully-executed malicious proposal)
can override:

- `MAX_FEE_BPS = 500` — the 5% cap on `feeBps`.
- Every address: `FEE_COLLECTOR`, `JUICESWAP_ROUTER`, `SATSUMA_ROUTER`, `JUICESWAP_FACTORY`, `JUSD`, `USDC_E`, `USDC_E_BRIDGE`, `CTUSD`, `CTUSD_BRIDGE`, `WCBTC` — immutable in the FeeRouter.
- `JUSD`, `JUICE` — immutable in the FeeCollectorV2.
- `FACTORY`, `FEE_COLLECTOR`, `GOVERNOR`, `MIN_PROTOCOL_FEE_VALUE = 4`, `MAX_PROTOCOL_FEE_VALUE = 10` — immutable in the ProtocolFeeKeeper.
- TWAP floors: `twapPeriod ≥ 300s`, `expectedBlockTime ∈ [1, 60]`, `convertMaxSlippageBps ≤ 1000`.
- Conversion-path validation: path must start with the named token and end in JUSD.
- Receive function: rejects native cBTC from any sender except WCBTC during unwrap.

Migration past any of these requires a redeploy and a DAO proposal to
point the Frontend/API at the new address.
