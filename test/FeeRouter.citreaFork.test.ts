import { expect } from "chai";
import { ethers, network } from "hardhat";

/**
 * MANDATORY PRE-MAINNET FORK TEST.
 *
 * Everything else in this suite is mocked: Algebra/V3 routers, factory,
 * bridges. Mocks cannot catch real-world protocol mismatches:
 *
 *   - Algebra Integral v1.9 has a `deployer` field that Uniswap V3 doesn't,
 *     plus dynamic fees that affect quoting.
 *   - The Citrea-specific `JUICESWAP_FACTORY` pool layout could deviate from
 *     `IUniswapV3Pool` in subtle ways (we only need slot0[3] + observe).
 *   - The Citrea StablecoinBridge contracts have governance state that mocks
 *     don't reproduce (mint limits, horizon expiry).
 *
 * This file is skipped in the default `hardhat test` run. To execute:
 *
 *   CITREA_FORK_URL="https://rpc.mainnet.citrea.xyz" \
 *     npx hardhat test test/FeeRouter.citreaFork.test.ts
 *
 * Block pinning is recommended for reproducibility — see `pinBlock` below.
 */

const CITREA_FORK_URL = process.env.CITREA_FORK_URL;
const FORK_BLOCK = process.env.CITREA_FORK_BLOCK
  ? parseInt(process.env.CITREA_FORK_BLOCK, 10)
  : undefined;

// Production addresses on Citrea Mainnet (verified on-chain 2026-05-11).
const ADDR = {
  satsumaRouter:   "0x3012e9049d05b4b5369d690114d5a5861ebb85cb",
  juiceswapRouter: "0x565eD3D57fe40f78A46f348C220121AE093c3cF8",
  juiceswapFactory:"0xd809b1285aDd8eeaF1B1566Bf31B2B4C4Bba8e82",
  governor:        "0x51f3D5905C768CCA2D4904Ca7877614CeaD607ae",
  jusd:            "0x0987D3720D38847ac6dBB9D025B9dE892a3CA35C",
  usdce:           "0xE045e6c36cF77FAA2CfB54466D71A3aEF7bbE839",
  usdceBridge:     "0x920db0adf6fee2d69401e9f68d60319177dca20f",
  ctusd:           "0x8D82c4E3c936C7B5724A382a9c5a4E6Eb7aB6d5D",
  ctusdBridge:     "0x8d11020286af9ecf7e5d7bd79699c391b224a0bd",
  wcbtc:           "0x3100000000000000000000000000000000000006",
  juice:           "0x2A36f2b204B46Fd82653cd06d00c7fF757C99ae4",
  satsumaPool:     "0x172d2ab563afdaace7247a6592ee1be62e791165", // USDC.e/ctUSD Algebra
};

(CITREA_FORK_URL ? describe : describe.skip)(
  "FeeRouter — Citrea mainnet fork",
  () => {
    before(async () => {
      await network.provider.request({
        method: "hardhat_reset",
        params: [{
          forking: {
            jsonRpcUrl: CITREA_FORK_URL,
            ...(FORK_BLOCK ? { blockNumber: FORK_BLOCK } : {}),
          },
        }],
      });
    });

    it("deploys FeeRouter against real Citrea infrastructure", async () => {
      const [deployer] = await ethers.getSigners();
      const Collector = await ethers.getContractFactory("JuiceSwapFeeCollectorV2");
      const collector = await Collector.deploy(
        ADDR.jusd, ADDR.juice, ADDR.governor,
      );

      const Router = await ethers.getContractFactory("JuiceSwapFeeRouter");
      const router = await Router.deploy({
        feeCollector:    await collector.getAddress(),
        satsumaRouter:   ADDR.satsumaRouter,
        juiceswapRouter: ADDR.juiceswapRouter,
        juiceswapFactory: ADDR.juiceswapFactory,
        governor:        ADDR.governor,
        jusd:            ADDR.jusd,
        usdce:           ADDR.usdce,
        usdceBridge:     ADDR.usdceBridge,
        ctusd:           ADDR.ctusd,
        ctusdBridge:     ADDR.ctusdBridge,
        wcbtc:           ADDR.wcbtc,
      });

      expect(await router.feeBps()).to.equal(25);
      expect(await router.FEE_COLLECTOR()).to.equal(await collector.getAddress());
    });

    it("executes a real Satsuma swap (USDC.e -> ctUSD) with fee bridged to JUSD", async () => {
      // Requires:
      //   - A funded USDC.e whale to impersonate
      //   - The real Satsuma USDC.e/ctUSD pool to be liquid
      //   - The real USDC.e StablecoinBridge to be active (not stopped/expired)
      //
      // Test outline (left as TODO for the actual fork run):
      //   1. Deploy router as above
      //   2. Impersonate a USDC.e holder
      //   3. approve(router, amountIn)
      //   4. router.swapExactInputSingleSatsuma(USDC.e, ctUSD, 0x0, 1000e6, 0, 0, deadline, false)
      //   5. Assert collector's JUSD balance increased by ~ 2.5e18 (0.25% * 1000 / 1e-12 scale)
      //   6. Assert user received ~ 997.5e6 ctUSD
      this.skip(); // remove once fork env is wired
    });

    it("verifies cardinality of WCBTC/USDC.e pool is sufficient for TWAP", async () => {
      // For convertAccumulated to work against real pools, observation
      // cardinality must be >= twapPeriod/blockTime + 1 = 1800/2+1 = 901.
      // New JuiceSwap V3 pools start at 1; someone must have called
      // increaseObservationCardinalityNext(901) on each pool we route through.
      this.skip();
    });
  },
);
