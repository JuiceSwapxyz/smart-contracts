import { expect } from "chai";
import { ethers } from "hardhat";
import {
  JuiceSwapGovernor,
  MockJUSD,
  MockJUICE,
  MockWBTC,
  MockUSDT,
  MockUniswapV3Pool,
  MockSwapRouter,
  MockUniswapV3Factory
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("JuiceSwapGovernor - Integration Tests", function () {
  const PROPOSAL_FEE = ethers.parseEther("1000");
  const MIN_APPLICATION_PERIOD = 14 * 24 * 60 * 60;

  /**
   * Full integration fixture with mock Uniswap V3 infrastructure
   */
  async function deployFullIntegrationFixture() {
    const [deployer, proposer, keeper, user1] = await ethers.getSigners();

    // 1. Deploy tokens
    const MockJUSD = await ethers.getContractFactory("MockJUSD");
    const jusd = await MockJUSD.deploy() as unknown as MockJUSD;

    const MockJUICE = await ethers.getContractFactory("MockJUICE");
    const juice = await MockJUICE.deploy() as unknown as MockJUICE;

    const MockWBTC = await ethers.getContractFactory("MockWBTC");
    const wbtc = await MockWBTC.deploy() as unknown as MockWBTC;

    const MockUSDT = await ethers.getContractFactory("MockUSDT");
    const usdt = await MockUSDT.deploy() as unknown as MockUSDT;

    // 2. Deploy mock SwapRouter
    const MockSwapRouter = await ethers.getContractFactory("MockSwapRouter");
    const swapRouter = await MockSwapRouter.deploy() as unknown as MockSwapRouter;

    // 3. Deploy mock Factory
    const MockUniswapV3Factory = await ethers.getContractFactory("MockUniswapV3Factory");
    const factory = await MockUniswapV3Factory.deploy() as unknown as MockUniswapV3Factory;

    // 4. Deploy mock Uniswap V3 Pools
    const MockUniswapV3Pool = await ethers.getContractFactory("MockUniswapV3Pool");

    // Ensure correct token ordering (token0 < token1)
    const jusdAddr = await jusd.getAddress();
    const wbtcAddr = await wbtc.getAddress();
    const usdtAddr = await usdt.getAddress();

    // WBTC/JUSD pool
    const wbtcJusdPool = await MockUniswapV3Pool.deploy(
      jusdAddr < wbtcAddr ? jusdAddr : wbtcAddr,
      jusdAddr < wbtcAddr ? wbtcAddr : jusdAddr,
      3000 // 0.3% fee
    ) as unknown as MockUniswapV3Pool;

    // USDT/JUSD pool
    const usdtJusdPool = await MockUniswapV3Pool.deploy(
      jusdAddr < usdtAddr ? jusdAddr : usdtAddr,
      jusdAddr < usdtAddr ? usdtAddr : jusdAddr,
      500 // 0.05% fee
    ) as unknown as MockUniswapV3Pool;

    // 5. Register pools with factory
    await factory.registerPool(wbtcAddr, jusdAddr, 3000, await wbtcJusdPool.getAddress());
    await factory.registerPool(usdtAddr, jusdAddr, 500, await usdtJusdPool.getAddress());

    // 6. Deploy Governor
    const factoryAddr = await factory.getAddress();

    const JuiceSwapGovernor = await ethers.getContractFactory("JuiceSwapGovernor");
    const governor = await JuiceSwapGovernor.deploy(
      await jusd.getAddress(),
      await juice.getAddress(),
      await swapRouter.getAddress(),
      factoryAddr
    ) as unknown as JuiceSwapGovernor;

    // 7. Setup: Fund proposer with JUSD for proposals
    await jusd.mint(proposer.address, PROPOSAL_FEE * 10n);
    await jusd.connect(proposer).approve(await governor.getAddress(), ethers.MaxUint256);

    // 8. Setup: Give keeper voting power
    const totalVotes = ethers.parseEther("1000000");
    const keeperVotes = ethers.parseEther("20000");
    await juice.setTotalVotingPower(totalVotes);
    await juice.setVotingPower(keeper.address, keeperVotes);

    // 9. Setup swap router exchange rates
    // WBTC → JUSD: 1 WBTC (8 decimals) = 100,000 JUSD (18 decimals)
    await swapRouter.setExchangeRate(
      wbtcAddr,
      jusdAddr,
      1000000000000 // 100,000 with decimal adjustment
    );

    // USDT → JUSD: 1 USDT (6 decimals) = 1 JUSD (18 decimals)
    await swapRouter.setExchangeRate(
      usdtAddr,
      jusdAddr,
      1000000000000 // 1:1 with decimal adjustment
    );

    return {
      governor,
      jusd,
      juice,
      wbtc,
      usdt,
      swapRouter,
      factory,
      wbtcJusdPool,
      usdtJusdPool,
      deployer,
      proposer,
      keeper,
      user1
    };
  }

  describe("Full Fee Collection Flow", function () {
    it("Should collect WBTC fees, swap to JUSD, and increase equity", async function () {
      const {
        governor,
        jusd,
        juice,
        wbtc,
        swapRouter,
        wbtcJusdPool,
        keeper,
        proposer
      } = await loadFixture(deployFullIntegrationFixture);

      // 1. Setup: Set keeper via governance
      const govAddr = await governor.getAddress();
      const setKeeperData = governor.interface.encodeFunctionData("setFeeCollector", [keeper.address]);

      await governor.connect(proposer).propose(
        govAddr,
        setKeeperData,
        MIN_APPLICATION_PERIOD,
        "Set keeper"
      );

      await time.increase(MIN_APPLICATION_PERIOD + 1);
      await governor.execute(1);

      // 2. Setup: Fund pool with protocol fees (simulate trading)
      const wbtcFees = ethers.parseUnits("1", 8); // 1 WBTC in fees
      const wbtcAddr = await wbtc.getAddress();
      const jusdAddr = await jusd.getAddress();

      // Check which token is token0 vs token1
      const token0 = await wbtcJusdPool.token0();
      const isWbtcToken0 = token0.toLowerCase() === wbtcAddr.toLowerCase();

      // Mint WBTC to pool and set protocol fees
      await wbtc.mint(await wbtcJusdPool.getAddress(), wbtcFees);
      if (isWbtcToken0) {
        await wbtcJusdPool.setProtocolFees(wbtcFees, 0);
      } else {
        await wbtcJusdPool.setProtocolFees(0, wbtcFees);
      }

      // 3. Setup: Fund swap router with JUSD for swaps
      const jusdForSwap = ethers.parseEther("100000"); // 100k JUSD
      await jusd.mint(await swapRouter.getAddress(), jusdForSwap);

      // 4. Setup: Set TWAP (at tick 0, price = 1:1 for simplicity)
      await wbtcJusdPool.setTWAP(0, 1800);

      // 5. Get initial equity
      const equityBefore = await jusd.balanceOf(await juice.getAddress());

      // 6. Prepare swap paths based on token ordering
      const swapPath = ethers.solidityPacked(
        ["address", "uint24", "address"],
        [wbtcAddr, 3000, jusdAddr]
      );

      // path0 and path1 correspond to token0 and token1
      const path0 = isWbtcToken0 ? swapPath : "0x";
      const path1 = isWbtcToken0 ? "0x" : swapPath;

      // 7. Keeper collects fees
      const poolAddr = await wbtcJusdPool.getAddress();
      await expect(
        governor.connect(keeper).collectAndReinvestFees(
          poolAddr,
          path0, // swap path for token0
          path1  // swap path for token1
        )
      ).to.emit(governor, "FeesReinvested");

      // 8. Verify equity increased
      const equityAfter = await jusd.balanceOf(await juice.getAddress());
      expect(equityAfter).to.be.gt(equityBefore);
    });

    it("Should handle pool where token0 is JUSD (no swap needed)", async function () {
      const {
        governor,
        jusd,
        juice,
        wbtcJusdPool,
        keeper,
        proposer
      } = await loadFixture(deployFullIntegrationFixture);

      // Setup keeper
      const govAddr = await governor.getAddress();
      const setKeeperData = governor.interface.encodeFunctionData("setFeeCollector", [keeper.address]);
      await governor.connect(proposer).propose(govAddr, setKeeperData, MIN_APPLICATION_PERIOD, "Set keeper");
      await time.increase(MIN_APPLICATION_PERIOD + 1);
      await governor.execute(1);

      // Fund pool with JUSD fees (token0 or token1 depending on address ordering)
      const jusdFees = ethers.parseEther("1000"); // 1000 JUSD
      await jusd.mint(await wbtcJusdPool.getAddress(), jusdFees);

      // Check which token is which
      const token0 = await wbtcJusdPool.token0();
      const jusdAddr = await jusd.getAddress();

      if (token0 === jusdAddr) {
        // JUSD is token0
        await wbtcJusdPool.setProtocolFees(jusdFees, 0);
      } else {
        // JUSD is token1
        await wbtcJusdPool.setProtocolFees(0, jusdFees);
      }

      await wbtcJusdPool.setTWAP(0, 1800);

      const equityBefore = await jusd.balanceOf(await juice.getAddress());

      // No swap path needed for JUSD
      await governor.connect(keeper).collectAndReinvestFees(
        await wbtcJusdPool.getAddress(),
        "0x", // No swap for JUSD
        "0x"
      );

      const equityAfter = await jusd.balanceOf(await juice.getAddress());

      // Should increase by exactly the fee amount (no slippage)
      expect(equityAfter - equityBefore).to.equal(jusdFees);
    });

    it("Should handle both tokens needing swaps", async function () {
      const {
        governor,
        jusd,
        juice,
        wbtc,
        usdt,
        swapRouter,
        factory,
        deployer,
        keeper,
        proposer
      } = await loadFixture(deployFullIntegrationFixture);

      // Create WBTC/USDT pool (both need swapping to JUSD)
      const MockUniswapV3Pool = await ethers.getContractFactory("MockUniswapV3Pool");
      const wbtcAddr = await wbtc.getAddress();
      const usdtAddr = await usdt.getAddress();

      const wbtcUsdtPool = await MockUniswapV3Pool.deploy(
        wbtcAddr < usdtAddr ? wbtcAddr : usdtAddr,
        wbtcAddr < usdtAddr ? usdtAddr : wbtcAddr,
        3000
      ) as unknown as MockUniswapV3Pool;

      // Register the new pool with factory
      await factory.registerPool(wbtcAddr, usdtAddr, 3000, await wbtcUsdtPool.getAddress());

      // Setup keeper
      const govAddr = await governor.getAddress();
      const setKeeperData = governor.interface.encodeFunctionData("setFeeCollector", [keeper.address]);
      await governor.connect(proposer).propose(govAddr, setKeeperData, MIN_APPLICATION_PERIOD, "Set keeper");
      await time.increase(MIN_APPLICATION_PERIOD + 1);
      await governor.execute(1);

      // Fund pool with fees
      const wbtcFees = ethers.parseUnits("0.5", 8); // 0.5 WBTC
      const usdtFees = ethers.parseUnits("10000", 6); // 10,000 USDT

      await wbtc.mint(await wbtcUsdtPool.getAddress(), wbtcFees);
      await usdt.mint(await wbtcUsdtPool.getAddress(), usdtFees);

      const token0 = await wbtcUsdtPool.token0();
      if (token0 === wbtcAddr) {
        await wbtcUsdtPool.setProtocolFees(wbtcFees, usdtFees);
      } else {
        await wbtcUsdtPool.setProtocolFees(usdtFees, wbtcFees);
      }

      // Fund swap router
      const jusdForSwap = ethers.parseEther("100000");
      await jusd.mint(await swapRouter.getAddress(), jusdForSwap);

      await wbtcUsdtPool.setTWAP(0, 1800);

      const equityBefore = await jusd.balanceOf(await juice.getAddress());

      // Create swap paths for both tokens
      const jusdAddr = await jusd.getAddress();
      const wbtcPath = ethers.solidityPacked(
        ["address", "uint24", "address"],
        [wbtcAddr, 3000, jusdAddr]
      );
      const usdtPath = ethers.solidityPacked(
        ["address", "uint24", "address"],
        [usdtAddr, 500, jusdAddr]
      );

      // Collect fees
      await governor.connect(keeper).collectAndReinvestFees(
        await wbtcUsdtPool.getAddress(),
        token0 === wbtcAddr ? wbtcPath : usdtPath,
        token0 === wbtcAddr ? usdtPath : wbtcPath
      );

      const equityAfter = await jusd.balanceOf(await juice.getAddress());
      expect(equityAfter).to.be.gt(equityBefore);
    });
  });

  describe("TWAP Slippage Protection", function () {
    it("Should revert if swap output below TWAP-based minimum", async function () {
      const {
        governor,
        jusd,
        wbtc,
        swapRouter,
        wbtcJusdPool,
        keeper,
        proposer
      } = await loadFixture(deployFullIntegrationFixture);

      // Setup keeper
      const govAddr = await governor.getAddress();
      const setKeeperData = governor.interface.encodeFunctionData("setFeeCollector", [keeper.address]);
      await governor.connect(proposer).propose(govAddr, setKeeperData, MIN_APPLICATION_PERIOD, "Set keeper");
      await time.increase(MIN_APPLICATION_PERIOD + 1);
      await governor.execute(1);

      // Fund pool with fees
      const wbtcFees = ethers.parseUnits("1", 8);
      const wbtcAddr = await wbtc.getAddress();
      const jusdAddr = await jusd.getAddress();

      // Check which token is token0 vs token1
      const token0 = await wbtcJusdPool.token0();
      const isWbtcToken0 = token0.toLowerCase() === wbtcAddr.toLowerCase();

      await wbtc.mint(await wbtcJusdPool.getAddress(), wbtcFees);
      if (isWbtcToken0) {
        await wbtcJusdPool.setProtocolFees(wbtcFees, 0);
      } else {
        await wbtcJusdPool.setProtocolFees(0, wbtcFees);
      }

      // IMPORTANT: Set TWAP BEFORE setting router slippage
      // TWAP tick=0 means 1:1 price (simplified for testing)
      await wbtcJusdPool.setTWAP(0, 1800);

      // Temporarily override exchange rate to match TWAP (1:1 after decimals)
      // This ensures TWAP-based slippage protection actually works
      await swapRouter.setExchangeRate(wbtcAddr, jusdAddr, 10000); // 1:1 at same decimals

      // Set high slippage on router (5% loss)
      // With 1:1 rate and 5% slippage: 1 WBTC → 0.95 WBTC worth of JUSD
      await swapRouter.setSlippage(500); // 5%

      // Fund router with enough JUSD
      await jusd.mint(await swapRouter.getAddress(), ethers.parseEther("100"));

      const swapPath = ethers.solidityPacked(
        ["address", "uint24", "address"],
        [wbtcAddr, 3000, jusdAddr]
      );

      // path0 and path1 correspond to token0 and token1
      const path0 = isWbtcToken0 ? swapPath : "0x";
      const path1 = isWbtcToken0 ? "0x" : swapPath;

      // Should revert due to slippage > 2%
      // TWAP expects ~1 JUSD output (at tick 0, 1:1 price)
      // Governor allows max 2% slippage → minOutput = 0.98 JUSD
      // Router with 5% slippage gives 0.95 JUSD
      // 0.95 < 0.98 → should revert with "Slippage too high"
      await expect(
        governor.connect(keeper).collectAndReinvestFees(
          await wbtcJusdPool.getAddress(),
          path0,
          path1
        )
      ).to.be.revertedWith("Slippage too high");
    });

    it("Should succeed with acceptable slippage (< 2%)", async function () {
      const {
        governor,
        jusd,
        wbtc,
        swapRouter,
        wbtcJusdPool,
        keeper,
        proposer
      } = await loadFixture(deployFullIntegrationFixture);

      // Setup keeper
      const govAddr = await governor.getAddress();
      const setKeeperData = governor.interface.encodeFunctionData("setFeeCollector", [keeper.address]);
      await governor.connect(proposer).propose(govAddr, setKeeperData, MIN_APPLICATION_PERIOD, "Set keeper");
      await time.increase(MIN_APPLICATION_PERIOD + 1);
      await governor.execute(1);

      // Fund pool
      const wbtcFees = ethers.parseUnits("1", 8);
      const wbtcAddr = await wbtc.getAddress();
      const jusdAddr = await jusd.getAddress();

      // Check which token is token0 vs token1
      const token0 = await wbtcJusdPool.token0();
      const isWbtcToken0 = token0.toLowerCase() === wbtcAddr.toLowerCase();

      await wbtc.mint(await wbtcJusdPool.getAddress(), wbtcFees);
      if (isWbtcToken0) {
        await wbtcJusdPool.setProtocolFees(wbtcFees, 0);
      } else {
        await wbtcJusdPool.setProtocolFees(0, wbtcFees);
      }

      // Set acceptable slippage (1%)
      await swapRouter.setSlippage(100); // 1%

      await jusd.mint(await swapRouter.getAddress(), ethers.parseEther("100000"));
      await wbtcJusdPool.setTWAP(0, 1800);

      const swapPath = ethers.solidityPacked(
        ["address", "uint24", "address"],
        [wbtcAddr, 3000, jusdAddr]
      );

      // path0 and path1 correspond to token0 and token1
      const path0 = isWbtcToken0 ? swapPath : "0x";
      const path1 = isWbtcToken0 ? "0x" : swapPath;

      // Should succeed
      await expect(
        governor.connect(keeper).collectAndReinvestFees(
          await wbtcJusdPool.getAddress(),
          path0,
          path1
        )
      ).to.emit(governor, "FeesReinvested");
    });
  });

  describe("Edge Cases", function () {
    it("Should handle zero fees collected", async function () {
      const {
        governor,
        wbtcJusdPool,
        keeper,
        proposer
      } = await loadFixture(deployFullIntegrationFixture);

      // Setup keeper
      const govAddr = await governor.getAddress();
      const setKeeperData = governor.interface.encodeFunctionData("setFeeCollector", [keeper.address]);
      await governor.connect(proposer).propose(govAddr, setKeeperData, MIN_APPLICATION_PERIOD, "Set keeper");
      await time.increase(MIN_APPLICATION_PERIOD + 1);
      await governor.execute(1);

      // No fees in pool
      await wbtcJusdPool.setProtocolFees(0, 0);
      await wbtcJusdPool.setTWAP(0, 1800);

      // Should complete without error
      await expect(
        governor.connect(keeper).collectAndReinvestFees(
          await wbtcJusdPool.getAddress(),
          "0x",
          "0x"
        )
      ).to.emit(governor, "FeesReinvested")
        .withArgs(await wbtcJusdPool.getAddress(), 0, 0, 0);
    });

    it("Should revert if swap path doesn't end with JUSD", async function () {
      const {
        governor,
        wbtc,
        usdt,
        wbtcJusdPool,
        keeper,
        proposer
      } = await loadFixture(deployFullIntegrationFixture);

      // Setup keeper
      const govAddr = await governor.getAddress();
      const setKeeperData = governor.interface.encodeFunctionData("setFeeCollector", [keeper.address]);
      await governor.connect(proposer).propose(govAddr, setKeeperData, MIN_APPLICATION_PERIOD, "Set keeper");
      await time.increase(MIN_APPLICATION_PERIOD + 1);
      await governor.execute(1);

      // Fund pool
      const wbtcFees = ethers.parseUnits("1", 8);
      const wbtcAddr = await wbtc.getAddress();
      const usdtAddr = await usdt.getAddress();

      // Check which token is token0 vs token1
      const token0 = await wbtcJusdPool.token0();
      const isWbtcToken0 = token0.toLowerCase() === wbtcAddr.toLowerCase();

      await wbtc.mint(await wbtcJusdPool.getAddress(), wbtcFees);
      if (isWbtcToken0) {
        await wbtcJusdPool.setProtocolFees(wbtcFees, 0);
      } else {
        await wbtcJusdPool.setProtocolFees(0, wbtcFees);
      }
      await wbtcJusdPool.setTWAP(0, 1800);

      // Invalid path: WBTC → USDT (not JUSD!)
      const invalidPath = ethers.solidityPacked(
        ["address", "uint24", "address"],
        [wbtcAddr, 3000, usdtAddr]
      );

      // path0 and path1 correspond to token0 and token1
      const path0 = isWbtcToken0 ? invalidPath : "0x";
      const path1 = isWbtcToken0 ? "0x" : invalidPath;

      // Should revert with InvalidSwapPath
      await expect(
        governor.connect(keeper).collectAndReinvestFees(
          await wbtcJusdPool.getAddress(),
          path0,
          path1
        )
      ).to.be.revertedWithCustomError(governor, "InvalidSwapPath");
    });

    it("Should revert if empty swap path for non-JUSD token", async function () {
      const {
        governor,
        wbtc,
        wbtcJusdPool,
        keeper,
        proposer
      } = await loadFixture(deployFullIntegrationFixture);

      // Setup keeper
      const govAddr = await governor.getAddress();
      const setKeeperData = governor.interface.encodeFunctionData("setFeeCollector", [keeper.address]);
      await governor.connect(proposer).propose(govAddr, setKeeperData, MIN_APPLICATION_PERIOD, "Set keeper");
      await time.increase(MIN_APPLICATION_PERIOD + 1);
      await governor.execute(1);

      // Fund pool with WBTC fees
      const wbtcFees = ethers.parseUnits("1", 8);
      const wbtcAddr = await wbtc.getAddress();

      // Check which token is token0 vs token1
      const token0 = await wbtcJusdPool.token0();
      const isWbtcToken0 = token0.toLowerCase() === wbtcAddr.toLowerCase();

      await wbtc.mint(await wbtcJusdPool.getAddress(), wbtcFees);
      if (isWbtcToken0) {
        await wbtcJusdPool.setProtocolFees(wbtcFees, 0);
      } else {
        await wbtcJusdPool.setProtocolFees(0, wbtcFees);
      }
      await wbtcJusdPool.setTWAP(0, 1800);

      // Empty paths for both (wrong - WBTC needs a swap path!)
      await expect(
        governor.connect(keeper).collectAndReinvestFees(
          await wbtcJusdPool.getAddress(),
          "0x", // Empty path for token0
          "0x"  // Empty path for token1
        )
      ).to.be.revertedWithCustomError(governor, "InvalidSwapPath");
    });
  });

  describe("Authorization", function () {
    it("Should prevent non-keeper from collecting fees", async function () {
      const {
        governor,
        wbtcJusdPool,
        user1
      } = await loadFixture(deployFullIntegrationFixture);

      await expect(
        governor.connect(user1).collectAndReinvestFees(
          await wbtcJusdPool.getAddress(),
          "0x",
          "0x"
        )
      ).to.be.revertedWithCustomError(governor, "NotAuthorized");
    });
  });

  describe("Advanced Edge Cases", function () {
    it("Should handle multi-hop swap path (3 tokens)", async function () {
      const {
        governor,
        jusd,
        juice,
        wbtc,
        usdt,
        swapRouter,
        factory,
        keeper,
        proposer
      } = await loadFixture(deployFullIntegrationFixture);

      // Setup keeper
      const govAddr = await governor.getAddress();
      const setKeeperData = governor.interface.encodeFunctionData("setFeeCollector", [keeper.address]);
      await governor.connect(proposer).propose(govAddr, setKeeperData, MIN_APPLICATION_PERIOD, "Set keeper");
      await time.increase(MIN_APPLICATION_PERIOD + 1);
      await governor.execute(1);

      // Create WBTC/USDT pool
      const MockUniswapV3Pool = await ethers.getContractFactory("MockUniswapV3Pool");
      const wbtcAddr = await wbtc.getAddress();
      const usdtAddr = await usdt.getAddress();
      const jusdAddr = await jusd.getAddress();

      const wbtcUsdtPool = await MockUniswapV3Pool.deploy(
        wbtcAddr < usdtAddr ? wbtcAddr : usdtAddr,
        wbtcAddr < usdtAddr ? usdtAddr : wbtcAddr,
        3000
      );

      await factory.registerPool(wbtcAddr, usdtAddr, 3000, await wbtcUsdtPool.getAddress());

      // Setup exchange rates
      await swapRouter.setExchangeRate(wbtcAddr, usdtAddr, 10000);
      await swapRouter.setExchangeRate(usdtAddr, jusdAddr, 10000);

      const wbtcFees = ethers.parseUnits("1", 8);
      const token0 = await wbtcUsdtPool.token0();
      const isWbtcToken0 = token0.toLowerCase() === wbtcAddr.toLowerCase();

      await wbtc.mint(await wbtcUsdtPool.getAddress(), wbtcFees);
      if (isWbtcToken0) {
        await wbtcUsdtPool.setProtocolFees(wbtcFees, 0);
      } else {
        await wbtcUsdtPool.setProtocolFees(0, wbtcFees);
      }

      await wbtcUsdtPool.setTWAP(0, 1800);
      await usdt.mint(await swapRouter.getAddress(), ethers.parseUnits("1000000", 6));
      await jusd.mint(await swapRouter.getAddress(), ethers.parseEther("100000"));

      // Multi-hop path: WBTC → USDT → JUSD
      const multiHopPath = ethers.solidityPacked(
        ["address", "uint24", "address", "uint24", "address"],
        [wbtcAddr, 3000, usdtAddr, 500, jusdAddr]
      );

      const path0 = isWbtcToken0 ? multiHopPath : "0x";
      const path1 = isWbtcToken0 ? "0x" : multiHopPath;

      const equityBefore = await jusd.balanceOf(await juice.getAddress());

      await expect(
        governor.connect(keeper).collectAndReinvestFees(
          await wbtcUsdtPool.getAddress(),
          path0,
          path1
        )
      ).to.emit(governor, "FeesReinvested");

      const equityAfter = await jusd.balanceOf(await juice.getAddress());
      expect(equityAfter).to.be.gt(equityBefore);
    });

    it("Should handle different fee tiers (1% pool)", async function () {
      const {
        governor,
        jusd,
        juice,
        wbtc,
        swapRouter,
        factory,
        keeper,
        proposer
      } = await loadFixture(deployFullIntegrationFixture);

      // Setup keeper
      const govAddr = await governor.getAddress();
      const setKeeperData = governor.interface.encodeFunctionData("setFeeCollector", [keeper.address]);
      await governor.connect(proposer).propose(govAddr, setKeeperData, MIN_APPLICATION_PERIOD, "Set keeper");
      await time.increase(MIN_APPLICATION_PERIOD + 1);
      await governor.execute(1);

      const wbtcAddr = await wbtc.getAddress();
      const jusdAddr = await jusd.getAddress();

      // Create pool with 1% fee tier (10000)
      const MockUniswapV3Pool = await ethers.getContractFactory("MockUniswapV3Pool");
      const highFeePool = await MockUniswapV3Pool.deploy(
        wbtcAddr < jusdAddr ? wbtcAddr : jusdAddr,
        wbtcAddr < jusdAddr ? jusdAddr : wbtcAddr,
        10000
      );

      await factory.registerPool(wbtcAddr, jusdAddr, 10000, await highFeePool.getAddress());

      const wbtcFees = ethers.parseUnits("1", 8);
      const token0 = await highFeePool.token0();
      const isWbtcToken0 = token0.toLowerCase() === wbtcAddr.toLowerCase();

      await wbtc.mint(await highFeePool.getAddress(), wbtcFees);
      if (isWbtcToken0) {
        await highFeePool.setProtocolFees(wbtcFees, 0);
      } else {
        await highFeePool.setProtocolFees(0, wbtcFees);
      }

      await highFeePool.setTWAP(0, 1800);
      await jusd.mint(await swapRouter.getAddress(), ethers.parseEther("100000"));

      const highFeePath = ethers.solidityPacked(
        ["address", "uint24", "address"],
        [wbtcAddr, 10000, jusdAddr]
      );

      const path0 = isWbtcToken0 ? highFeePath : "0x";
      const path1 = isWbtcToken0 ? "0x" : highFeePath;

      const equityBefore = await jusd.balanceOf(await juice.getAddress());

      await expect(
        governor.connect(keeper).collectAndReinvestFees(
          await highFeePool.getAddress(),
          path0,
          path1
        )
      ).to.emit(governor, "FeesReinvested");

      const equityAfter = await jusd.balanceOf(await juice.getAddress());
      expect(equityAfter).to.be.gt(equityBefore);
    });

    it("Should revert when pool does not exist in factory", async function () {
      const {
        governor,
        wbtc,
        jusd,
        keeper,
        proposer
      } = await loadFixture(deployFullIntegrationFixture);

      // Setup keeper
      const govAddr = await governor.getAddress();
      const setKeeperData = governor.interface.encodeFunctionData("setFeeCollector", [keeper.address]);
      await governor.connect(proposer).propose(govAddr, setKeeperData, MIN_APPLICATION_PERIOD, "Set keeper");
      await time.increase(MIN_APPLICATION_PERIOD + 1);
      await governor.execute(1);

      // Create unregistered pool
      const MockUniswapV3Pool = await ethers.getContractFactory("MockUniswapV3Pool");
      const wbtcAddr = await wbtc.getAddress();
      const jusdAddr = await jusd.getAddress();

      const unregisteredPool = await MockUniswapV3Pool.deploy(
        wbtcAddr < jusdAddr ? wbtcAddr : jusdAddr,
        wbtcAddr < jusdAddr ? jusdAddr : wbtcAddr,
        3000
      );

      const wbtcFees = ethers.parseUnits("1", 8);
      const token0 = await unregisteredPool.token0();
      const isWbtcToken0 = token0.toLowerCase() === wbtcAddr.toLowerCase();

      await wbtc.mint(await unregisteredPool.getAddress(), wbtcFees);
      if (isWbtcToken0) {
        await unregisteredPool.setProtocolFees(wbtcFees, 0);
      } else {
        await unregisteredPool.setProtocolFees(0, wbtcFees);
      }

      await unregisteredPool.setTWAP(0, 1800);

      const swapPath = ethers.solidityPacked(
        ["address", "uint24", "address"],
        [wbtcAddr, 3000, jusdAddr]
      );

      const path0 = isWbtcToken0 ? swapPath : "0x";
      const path1 = isWbtcToken0 ? "0x" : swapPath;

      // Pool not registered in factory → factory.getPool returns address(0)
      // → Governor reverts with "Pool does not exist"
      await expect(
        governor.connect(keeper).collectAndReinvestFees(
          await unregisteredPool.getAddress(),
          path0,
          path1
        )
      ).to.be.reverted;
    });

    it("Should handle very large fee amounts", async function () {
      const {
        governor,
        jusd,
        juice,
        wbtc,
        swapRouter,
        wbtcJusdPool,
        keeper,
        proposer
      } = await loadFixture(deployFullIntegrationFixture);

      // Setup keeper
      const govAddr = await governor.getAddress();
      const setKeeperData = governor.interface.encodeFunctionData("setFeeCollector", [keeper.address]);
      await governor.connect(proposer).propose(govAddr, setKeeperData, MIN_APPLICATION_PERIOD, "Set keeper");
      await time.increase(MIN_APPLICATION_PERIOD + 1);
      await governor.execute(1);

      // Very large amount: 10,000 WBTC
      const hugeFees = ethers.parseUnits("10000", 8);
      const wbtcAddr = await wbtc.getAddress();
      const jusdAddr = await jusd.getAddress();

      const token0 = await wbtcJusdPool.token0();
      const isWbtcToken0 = token0.toLowerCase() === wbtcAddr.toLowerCase();

      await wbtc.mint(await wbtcJusdPool.getAddress(), hugeFees);
      if (isWbtcToken0) {
        await wbtcJusdPool.setProtocolFees(hugeFees, 0);
      } else {
        await wbtcJusdPool.setProtocolFees(0, hugeFees);
      }

      await wbtcJusdPool.setTWAP(0, 1800);
      await jusd.mint(await swapRouter.getAddress(), ethers.parseEther("1000000000"));

      const swapPath = ethers.solidityPacked(
        ["address", "uint24", "address"],
        [wbtcAddr, 3000, jusdAddr]
      );

      const path0 = isWbtcToken0 ? swapPath : "0x";
      const path1 = isWbtcToken0 ? "0x" : swapPath;

      const equityBefore = await jusd.balanceOf(await juice.getAddress());

      await expect(
        governor.connect(keeper).collectAndReinvestFees(
          await wbtcJusdPool.getAddress(),
          path0,
          path1
        )
      ).to.emit(governor, "FeesReinvested");

      const equityAfter = await jusd.balanceOf(await juice.getAddress());
      expect(equityAfter).to.be.gt(equityBefore);
    });
  });
});
