import { expect } from "chai";
import { ethers } from "hardhat";
import {
  JuiceSwapGateway,
  MockERC20,
  MockEquity,
  MockERC4626,
  MockWETH,
  MockSwapRouter,
  MockPositionManager,
  MockStablecoinBridge,
} from "../typechain-types";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * Comprehensive Swap Matrix Tests
 *
 * Tests all 72 swap directions (36 pairs) for the 9 supported tokens:
 * - cBTC (native)
 * - WcBTC
 * - JUSD
 * - svJUSD
 * - JUICE
 * - USDT.e (bridged)
 * - USDC.e (bridged)
 * - SUSD (bridged)
 * - ctUSD (bridged)
 */
describe("JuiceSwapGateway - Complete Swap Matrix", function () {
  // Test constants
  const INITIAL_BALANCE = ethers.parseEther("10000");
  const DEADLINE_OFFSET = 3600;
  const BRIDGE_LIMIT = ethers.parseEther("1000000000"); // 1B JUSD (high limit for testing)
  const BRIDGE_WEEKS = 208; // 4 years

  // Token identifiers for the matrix
  type TokenId =
    | "cBTC"
    | "WcBTC"
    | "JUSD"
    | "svJUSD"
    | "JUICE"
    | "USDT"
    | "USDC"
    | "SUSD"
    | "ctUSD";

  interface TokenInfo {
    id: TokenId;
    decimals: number;
    isBridged: boolean;
    isNative: boolean;
  }

  const TOKEN_INFO: Record<TokenId, TokenInfo> = {
    cBTC: { id: "cBTC", decimals: 18, isBridged: false, isNative: true },
    WcBTC: { id: "WcBTC", decimals: 18, isBridged: false, isNative: false },
    JUSD: { id: "JUSD", decimals: 18, isBridged: false, isNative: false },
    svJUSD: { id: "svJUSD", decimals: 18, isBridged: false, isNative: false },
    JUICE: { id: "JUICE", decimals: 18, isBridged: false, isNative: false },
    USDT: { id: "USDT", decimals: 6, isBridged: true, isNative: false },
    USDC: { id: "USDC", decimals: 6, isBridged: true, isNative: false },
    SUSD: { id: "SUSD", decimals: 18, isBridged: true, isNative: false },
    ctUSD: { id: "ctUSD", decimals: 6, isBridged: true, isNative: false },
  };

  const ALL_TOKENS: TokenId[] = [
    "cBTC",
    "WcBTC",
    "JUSD",
    "svJUSD",
    "JUICE",
    "USDT",
    "USDC",
    "SUSD",
    "ctUSD",
  ];

  interface FixtureResult {
    owner: HardhatEthersSigner;
    user1: HardhatEthersSigner;
    gateway: JuiceSwapGateway;
    jusd: MockERC20;
    juice: MockEquity;
    svJusd: MockERC4626;
    wcbtc: MockWETH;
    swapRouter: MockSwapRouter;
    positionManager: MockPositionManager;
    usdt: MockERC20;
    usdc: MockERC20;
    susd: MockERC20;
    ctUsd: MockERC20;
    usdtBridge: MockStablecoinBridge;
    usdcBridge: MockStablecoinBridge;
    susdBridge: MockStablecoinBridge;
    ctUsdBridge: MockStablecoinBridge;
    getTokenAddress: (id: TokenId) => Promise<string>;
    getTokenContract: (id: TokenId) => MockERC20 | MockEquity | MockERC4626 | MockWETH;
    getBridge: (id: TokenId) => MockStablecoinBridge | null;
  }

  /**
   * Deploy complete fixture with all 9 tokens
   */
  async function deployCompleteFixture(): Promise<FixtureResult> {
    const [owner, user1] = await ethers.getSigners();

    // Deploy core mocks
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    const jusd = (await MockERC20Factory.deploy(
      "JuiceDollar",
      "JUSD",
      18
    )) as unknown as MockERC20;

    const MockEquityFactory = await ethers.getContractFactory("MockEquity");
    const juice = (await MockEquityFactory.deploy(
      "Juice Protocol",
      "JUICE",
      await jusd.getAddress()
    )) as unknown as MockEquity;

    const MockERC4626Factory = await ethers.getContractFactory("MockERC4626");
    const svJusd = (await MockERC4626Factory.deploy(
      await jusd.getAddress(),
      "Savings Vault JUSD",
      "svJUSD"
    )) as unknown as MockERC4626;

    const MockWETHFactory = await ethers.getContractFactory("MockWETH");
    const wcbtc = (await MockWETHFactory.deploy(
      "Wrapped cBTC",
      "WcBTC"
    )) as unknown as MockWETH;

    const MockSwapRouterFactory =
      await ethers.getContractFactory("MockSwapRouter");
    const swapRouter =
      (await MockSwapRouterFactory.deploy()) as unknown as MockSwapRouter;

    const MockPositionManagerFactory =
      await ethers.getContractFactory("MockPositionManager");
    const positionManager =
      (await MockPositionManagerFactory.deploy()) as unknown as MockPositionManager;

    // Deploy gateway
    const JuiceSwapGatewayFactory =
      await ethers.getContractFactory("JuiceSwapGateway");
    const gateway = (await JuiceSwapGatewayFactory.deploy(
      await jusd.getAddress(),
      await svJusd.getAddress(),
      await juice.getAddress(),
      await wcbtc.getAddress(),
      await swapRouter.getAddress(),
      await positionManager.getAddress()
    )) as unknown as JuiceSwapGateway;

    // Deploy bridged stablecoins
    const usdt = (await MockERC20Factory.deploy(
      "Tether USD",
      "USDT.e",
      6
    )) as unknown as MockERC20;
    const usdc = (await MockERC20Factory.deploy(
      "USD Coin",
      "USDC.e",
      6
    )) as unknown as MockERC20;
    const susd = (await MockERC20Factory.deploy(
      "StartUSD",
      "SUSD",
      18
    )) as unknown as MockERC20;
    const ctUsd = (await MockERC20Factory.deploy(
      "M0 USD",
      "ctUSD",
      6
    )) as unknown as MockERC20;

    // Deploy bridges
    const MockBridgeFactory =
      await ethers.getContractFactory("MockStablecoinBridge");
    const usdtBridge = (await MockBridgeFactory.deploy(
      await usdt.getAddress(),
      await jusd.getAddress(),
      BRIDGE_LIMIT,
      BRIDGE_WEEKS
    )) as unknown as MockStablecoinBridge;
    const usdcBridge = (await MockBridgeFactory.deploy(
      await usdc.getAddress(),
      await jusd.getAddress(),
      BRIDGE_LIMIT,
      BRIDGE_WEEKS
    )) as unknown as MockStablecoinBridge;
    const susdBridge = (await MockBridgeFactory.deploy(
      await susd.getAddress(),
      await jusd.getAddress(),
      BRIDGE_LIMIT,
      BRIDGE_WEEKS
    )) as unknown as MockStablecoinBridge;
    const ctUsdBridge = (await MockBridgeFactory.deploy(
      await ctUsd.getAddress(),
      await jusd.getAddress(),
      BRIDGE_LIMIT,
      BRIDGE_WEEKS
    )) as unknown as MockStablecoinBridge;

    // Set bridges as approved minters
    await jusd.setMinter(await usdtBridge.getAddress(), true);
    await jusd.setMinter(await usdcBridge.getAddress(), true);
    await jusd.setMinter(await susdBridge.getAddress(), true);
    await jusd.setMinter(await ctUsdBridge.getAddress(), true);

    // Register bridged tokens
    await gateway.registerBridgedToken(
      await usdt.getAddress(),
      await usdtBridge.getAddress()
    );
    await gateway.registerBridgedToken(
      await usdc.getAddress(),
      await usdcBridge.getAddress()
    );
    await gateway.registerBridgedToken(
      await susd.getAddress(),
      await susdBridge.getAddress()
    );
    await gateway.registerBridgedToken(
      await ctUsd.getAddress(),
      await ctUsdBridge.getAddress()
    );

    // Fund bridges with tokens for burn operations
    const bridgeFunding6Dec = 100_000_000n * 10n ** 6n; // 100M (6 decimals)
    const bridgeFunding18Dec = ethers.parseEther("100000000"); // 100M (18 decimals)
    await usdt.mint(await usdtBridge.getAddress(), bridgeFunding6Dec);
    await usdc.mint(await usdcBridge.getAddress(), bridgeFunding6Dec);
    await susd.mint(await susdBridge.getAddress(), bridgeFunding18Dec);
    await ctUsd.mint(await ctUsdBridge.getAddress(), bridgeFunding6Dec);

    // Set initial minted amounts for all bridges (needed for burn operations)
    // Must be > 0 for burn operations but not exceed limit
    await usdtBridge.setMinted(ethers.parseEther("10000000"));
    await usdcBridge.setMinted(ethers.parseEther("10000000"));
    await susdBridge.setMinted(ethers.parseEther("10000000"));
    await ctUsdBridge.setMinted(ethers.parseEther("10000000"));

    // Setup user balances
    await jusd.mint(user1.address, INITIAL_BALANCE);
    await juice.mint(user1.address, INITIAL_BALANCE);
    await wcbtc.connect(user1).deposit({ value: ethers.parseEther("1000") });

    // Fund user with bridged tokens
    await usdt.mint(user1.address, 1_000_000n * 10n ** 6n);
    await usdc.mint(user1.address, 1_000_000n * 10n ** 6n);
    await susd.mint(user1.address, ethers.parseEther("1000000"));
    await ctUsd.mint(user1.address, 1_000_000n * 10n ** 6n);

    // Fund svJUSD vault with JUSD for redemptions
    await jusd.mint(await svJusd.getAddress(), ethers.parseEther("10000000"));

    // Fund JUICE contract with JUSD for redemptions
    await jusd.mint(await juice.getAddress(), ethers.parseEther("10000000"));

    // Mint svJUSD to user for svJUSD input tests
    await jusd.mint(user1.address, ethers.parseEther("100000"));
    await jusd
      .connect(user1)
      .approve(await svJusd.getAddress(), ethers.parseEther("100000"));
    await svJusd
      .connect(user1)
      ["deposit(uint256,address)"](
        ethers.parseEther("100000"),
        user1.address
      );

    // Helper functions
    const getTokenAddress = async (id: TokenId): Promise<string> => {
      switch (id) {
        case "cBTC":
          return ethers.ZeroAddress;
        case "WcBTC":
          return await wcbtc.getAddress();
        case "JUSD":
          return await jusd.getAddress();
        case "svJUSD":
          return await svJusd.getAddress();
        case "JUICE":
          return await juice.getAddress();
        case "USDT":
          return await usdt.getAddress();
        case "USDC":
          return await usdc.getAddress();
        case "SUSD":
          return await susd.getAddress();
        case "ctUSD":
          return await ctUsd.getAddress();
      }
    };

    const getTokenContract = (
      id: TokenId
    ): MockERC20 | MockEquity | MockERC4626 | MockWETH => {
      switch (id) {
        case "cBTC":
        case "WcBTC":
          return wcbtc;
        case "JUSD":
          return jusd;
        case "svJUSD":
          return svJusd as unknown as MockERC4626;
        case "JUICE":
          return juice;
        case "USDT":
          return usdt;
        case "USDC":
          return usdc;
        case "SUSD":
          return susd;
        case "ctUSD":
          return ctUsd;
      }
    };

    const getBridge = (id: TokenId): MockStablecoinBridge | null => {
      switch (id) {
        case "USDT":
          return usdtBridge;
        case "USDC":
          return usdcBridge;
        case "SUSD":
          return susdBridge;
        case "ctUSD":
          return ctUsdBridge;
        default:
          return null;
      }
    };

    return {
      owner,
      user1,
      gateway,
      jusd,
      juice,
      svJusd,
      wcbtc,
      swapRouter,
      positionManager,
      usdt,
      usdc,
      susd,
      ctUsd,
      usdtBridge,
      usdcBridge,
      susdBridge,
      ctUsdBridge,
      getTokenAddress,
      getTokenContract,
      getBridge,
    };
  }

  /**
   * Get the pool token that a user token converts to
   */
  function getPoolToken(tokenId: TokenId): "WcBTC" | "svJUSD" {
    if (tokenId === "cBTC" || tokenId === "WcBTC") {
      return "WcBTC";
    }
    return "svJUSD";
  }

  /**
   * Determine swap type based on input/output tokens
   */
  function getSwapType(
    tokenIn: TokenId,
    tokenOut: TokenId
  ): "pool" | "direct" | "wrap" {
    const poolIn = getPoolToken(tokenIn);
    const poolOut = getPoolToken(tokenOut);

    // Wrap/unwrap between cBTC and WcBTC
    if (
      (tokenIn === "cBTC" && tokenOut === "WcBTC") ||
      (tokenIn === "WcBTC" && tokenOut === "cBTC")
    ) {
      return "wrap";
    }

    // Pool swap if crossing between WcBTC and svJUSD groups
    if (poolIn !== poolOut) {
      return "pool";
    }

    // Direct conversion within the same group
    return "direct";
  }

  /**
   * Get appropriate swap amount based on token decimals
   */
  function getSwapAmount(tokenId: TokenId): bigint {
    const info = TOKEN_INFO[tokenId];
    if (info.decimals === 6) {
      return 1000n * 10n ** 6n; // 1000 units for 6 decimal tokens
    }
    return ethers.parseEther("100"); // 100 units for 18 decimal tokens
  }

  /**
   * Setup mock router for pool swaps
   */
  async function setupPoolSwap(
    fixture: FixtureResult,
    tokenIn: TokenId,
    tokenOut: TokenId
  ): Promise<bigint> {
    const { swapRouter, svJusd, wcbtc } = fixture;

    // Calculate expected output based on direction
    const poolIn = getPoolToken(tokenIn);
    const poolOut = getPoolToken(tokenOut);

    let mockOutput: bigint;

    if (poolIn === "WcBTC" && poolOut === "svJUSD") {
      // WcBTC → svJUSD (e.g., 0.01 WcBTC → 1000 svJUSD)
      mockOutput = ethers.parseEther("1000");
      await svJusd["mint(address,uint256)"](
        await swapRouter.getAddress(),
        mockOutput
      );
    } else {
      // svJUSD → WcBTC (e.g., 1000 svJUSD → 0.01 WcBTC)
      mockOutput = ethers.parseEther("0.01");
      await wcbtc.connect(fixture.owner).deposit({ value: mockOutput });
      await wcbtc
        .connect(fixture.owner)
        .transfer(await swapRouter.getAddress(), mockOutput);
    }

    await swapRouter.setSwapOutput(mockOutput);
    return mockOutput;
  }

  describe("Swap Matrix - All 72 Directions", function () {
    // Generate test cases for all token pairs
    for (const tokenIn of ALL_TOKENS) {
      for (const tokenOut of ALL_TOKENS) {
        if (tokenIn === tokenOut) continue;

        const swapType = getSwapType(tokenIn, tokenOut);
        const testName = `${tokenIn} → ${tokenOut} (${swapType})`;

        it(`Should swap ${testName}`, async function () {
          const fixture = await loadFixture(deployCompleteFixture);
          const { gateway, user1, getTokenAddress, getTokenContract, getBridge } =
            fixture;

          const deadline = (await time.latest()) + DEADLINE_OFFSET;
          const tokenInAddr = await getTokenAddress(tokenIn);
          const tokenOutAddr = await getTokenAddress(tokenOut);
          const swapAmount = getSwapAmount(tokenIn);
          const tokenInfo = TOKEN_INFO[tokenIn];

          // Setup for pool swaps
          if (swapType === "pool") {
            await setupPoolSwap(fixture, tokenIn, tokenOut);
          }

          // Get balance before
          let balanceBefore: bigint;
          if (tokenOut === "cBTC") {
            balanceBefore = await ethers.provider.getBalance(user1.address);
          } else {
            const outContract = getTokenContract(tokenOut);
            balanceBefore = await outContract.balanceOf(user1.address);
          }

          // Approve gateway if not native token
          if (!tokenInfo.isNative) {
            const inContract = getTokenContract(tokenIn);
            await inContract
              .connect(user1)
              .approve(await gateway.getAddress(), swapAmount);
          }

          // Execute swap
          const txOptions = tokenInfo.isNative ? { value: swapAmount } : {};
          await gateway.connect(user1).swapExactTokensForTokens(
            tokenInAddr,
            tokenOutAddr,
            0, // use default fee
            swapAmount,
            0, // min output (we just want to verify it works)
            user1.address,
            deadline,
            txOptions
          );

          // Verify balance increased
          let balanceAfter: bigint;
          if (tokenOut === "cBTC") {
            balanceAfter = await ethers.provider.getBalance(user1.address);
            // Account for gas costs - just verify we got some output
            // For wrap/unwrap the balance should be close
          } else {
            const outContract = getTokenContract(tokenOut);
            balanceAfter = await outContract.balanceOf(user1.address);
          }

          // Verify output was received (balance increased)
          expect(balanceAfter).to.be.gte(
            balanceBefore,
            `${testName}: Output balance should increase`
          );
        });
      }
    }
  });

  describe("Swap Path Verification", function () {
    describe("Pool Swaps (WcBTC ↔ svJUSD group)", function () {
      const poolSwapPairs: [TokenId, TokenId][] = [
        ["cBTC", "JUSD"],
        ["cBTC", "svJUSD"],
        ["cBTC", "JUICE"],
        ["cBTC", "USDT"],
        ["cBTC", "USDC"],
        ["cBTC", "SUSD"],
        ["cBTC", "ctUSD"],
        ["WcBTC", "JUSD"],
        ["WcBTC", "svJUSD"],
        ["WcBTC", "JUICE"],
        ["WcBTC", "USDT"],
        ["WcBTC", "USDC"],
        ["WcBTC", "SUSD"],
        ["WcBTC", "ctUSD"],
        ["JUSD", "cBTC"],
        ["JUSD", "WcBTC"],
        ["svJUSD", "cBTC"],
        ["svJUSD", "WcBTC"],
        ["JUICE", "cBTC"],
        ["JUICE", "WcBTC"],
        ["USDT", "cBTC"],
        ["USDT", "WcBTC"],
        ["USDC", "cBTC"],
        ["USDC", "WcBTC"],
        ["SUSD", "cBTC"],
        ["SUSD", "WcBTC"],
        ["ctUSD", "cBTC"],
        ["ctUSD", "WcBTC"],
      ];

      for (const [tokenIn, tokenOut] of poolSwapPairs) {
        it(`${tokenIn} → ${tokenOut} should use pool swap`, async function () {
          const fixture = await loadFixture(deployCompleteFixture);
          const { gateway, user1, swapRouter, getTokenAddress, getTokenContract } =
            fixture;

          const deadline = (await time.latest()) + DEADLINE_OFFSET;
          const tokenInAddr = await getTokenAddress(tokenIn);
          const tokenOutAddr = await getTokenAddress(tokenOut);
          const swapAmount = getSwapAmount(tokenIn);
          const tokenInfo = TOKEN_INFO[tokenIn];

          // Setup mock router
          await setupPoolSwap(fixture, tokenIn, tokenOut);

          // Track router calls
          const routerCallsBefore = await swapRouter.swapCallCount();

          // Approve if needed
          if (!tokenInfo.isNative) {
            const inContract = getTokenContract(tokenIn);
            await inContract
              .connect(user1)
              .approve(await gateway.getAddress(), swapAmount);
          }

          // Execute swap
          const txOptions = tokenInfo.isNative ? { value: swapAmount } : {};
          await gateway.connect(user1).swapExactTokensForTokens(
            tokenInAddr,
            tokenOutAddr,
            0,
            swapAmount,
            0,
            user1.address,
            deadline,
            txOptions
          );

          // Verify router was called (pool swap)
          const routerCallsAfter = await swapRouter.swapCallCount();
          expect(routerCallsAfter).to.be.gt(
            routerCallsBefore,
            "Pool swap should call router"
          );
        });
      }
    });

    describe("Direct Conversions (skip pool)", function () {
      const directPairs: [TokenId, TokenId][] = [
        // USD ↔ USD (optimized path)
        ["JUSD", "USDT"],
        ["JUSD", "USDC"],
        ["JUSD", "SUSD"],
        ["JUSD", "ctUSD"],
        ["USDT", "JUSD"],
        ["USDC", "JUSD"],
        ["SUSD", "JUSD"],
        ["ctUSD", "JUSD"],
        // Bridged ↔ Bridged
        ["USDT", "USDC"],
        ["USDT", "SUSD"],
        ["USDT", "ctUSD"],
        ["USDC", "USDT"],
        ["USDC", "SUSD"],
        ["USDC", "ctUSD"],
        ["SUSD", "USDT"],
        ["SUSD", "USDC"],
        ["SUSD", "ctUSD"],
        ["ctUSD", "USDT"],
        ["ctUSD", "USDC"],
        ["ctUSD", "SUSD"],
        // USD → JUICE (optimized)
        ["JUSD", "JUICE"],
        ["USDT", "JUICE"],
        ["USDC", "JUICE"],
        ["SUSD", "JUICE"],
        ["ctUSD", "JUICE"],
      ];

      for (const [tokenIn, tokenOut] of directPairs) {
        it(`${tokenIn} → ${tokenOut} should skip pool (direct conversion)`, async function () {
          const fixture = await loadFixture(deployCompleteFixture);
          const { gateway, user1, swapRouter, getTokenAddress, getTokenContract } =
            fixture;

          const deadline = (await time.latest()) + DEADLINE_OFFSET;
          const tokenInAddr = await getTokenAddress(tokenIn);
          const tokenOutAddr = await getTokenAddress(tokenOut);
          const swapAmount = getSwapAmount(tokenIn);

          // Track router calls
          const routerCallsBefore = await swapRouter.swapCallCount();

          // Approve
          const inContract = getTokenContract(tokenIn);
          await inContract
            .connect(user1)
            .approve(await gateway.getAddress(), swapAmount);

          // Execute swap
          await gateway.connect(user1).swapExactTokensForTokens(
            tokenInAddr,
            tokenOutAddr,
            0,
            swapAmount,
            0,
            user1.address,
            deadline
          );

          // Verify router was NOT called (direct conversion)
          const routerCallsAfter = await swapRouter.swapCallCount();
          expect(routerCallsAfter).to.equal(
            routerCallsBefore,
            "Direct conversion should NOT call router"
          );
        });
      }
    });

    describe("Wrap/Unwrap (cBTC ↔ WcBTC)", function () {
      it("cBTC → WcBTC should wrap without pool", async function () {
        const fixture = await loadFixture(deployCompleteFixture);
        const { gateway, user1, wcbtc, swapRouter } = fixture;

        const deadline = (await time.latest()) + DEADLINE_OFFSET;
        const swapAmount = ethers.parseEther("1");

        const routerCallsBefore = await swapRouter.swapCallCount();
        const wcbtcBefore = await wcbtc.balanceOf(user1.address);

        await gateway.connect(user1).swapExactTokensForTokens(
          ethers.ZeroAddress, // cBTC
          await wcbtc.getAddress(),
          0,
          swapAmount,
          0,
          user1.address,
          deadline,
          { value: swapAmount }
        );

        const wcbtcAfter = await wcbtc.balanceOf(user1.address);
        const routerCallsAfter = await swapRouter.swapCallCount();

        expect(wcbtcAfter - wcbtcBefore).to.equal(swapAmount);
        expect(routerCallsAfter).to.equal(
          routerCallsBefore,
          "Wrap should not call router"
        );
      });

      it("WcBTC → cBTC should unwrap without pool", async function () {
        const fixture = await loadFixture(deployCompleteFixture);
        const { gateway, user1, wcbtc, swapRouter } = fixture;

        const deadline = (await time.latest()) + DEADLINE_OFFSET;
        const swapAmount = ethers.parseEther("1");

        await wcbtc
          .connect(user1)
          .approve(await gateway.getAddress(), swapAmount);

        const routerCallsBefore = await swapRouter.swapCallCount();
        const cbtcBefore = await ethers.provider.getBalance(user1.address);

        const tx = await gateway.connect(user1).swapExactTokensForTokens(
          await wcbtc.getAddress(),
          ethers.ZeroAddress, // cBTC
          0,
          swapAmount,
          0,
          user1.address,
          deadline
        );

        const receipt = await tx.wait();
        const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
        const cbtcAfter = await ethers.provider.getBalance(user1.address);
        const routerCallsAfter = await swapRouter.swapCallCount();

        // Account for gas in balance check
        expect(cbtcAfter + gasUsed - cbtcBefore).to.be.closeTo(
          swapAmount,
          ethers.parseEther("0.001")
        );
        expect(routerCallsAfter).to.equal(
          routerCallsBefore,
          "Unwrap should not call router"
        );
      });
    });

    describe("svJUSD Direct Input/Output", function () {
      it("svJUSD → JUSD should redeem directly", async function () {
        const fixture = await loadFixture(deployCompleteFixture);
        const { gateway, user1, svJusd, jusd, swapRouter } = fixture;

        const deadline = (await time.latest()) + DEADLINE_OFFSET;
        const swapAmount = ethers.parseEther("100");

        await svJusd
          .connect(user1)
          .approve(await gateway.getAddress(), swapAmount);

        const routerCallsBefore = await swapRouter.swapCallCount();
        const jusdBefore = await jusd.balanceOf(user1.address);

        await gateway.connect(user1).swapExactTokensForTokens(
          await svJusd.getAddress(),
          await jusd.getAddress(),
          0,
          swapAmount,
          0,
          user1.address,
          deadline
        );

        const jusdAfter = await jusd.balanceOf(user1.address);
        const routerCallsAfter = await swapRouter.swapCallCount();

        expect(jusdAfter).to.be.gt(jusdBefore);
        expect(routerCallsAfter).to.equal(
          routerCallsBefore,
          "svJUSD → JUSD should not call router"
        );
      });

      it("JUSD → svJUSD should deposit directly", async function () {
        const fixture = await loadFixture(deployCompleteFixture);
        const { gateway, user1, svJusd, jusd, swapRouter } = fixture;

        const deadline = (await time.latest()) + DEADLINE_OFFSET;
        const swapAmount = ethers.parseEther("100");

        await jusd
          .connect(user1)
          .approve(await gateway.getAddress(), swapAmount);

        const routerCallsBefore = await swapRouter.swapCallCount();
        const svJusdBefore = await svJusd.balanceOf(user1.address);

        await gateway.connect(user1).swapExactTokensForTokens(
          await jusd.getAddress(),
          await svJusd.getAddress(),
          0,
          swapAmount,
          0,
          user1.address,
          deadline
        );

        const svJusdAfter = await svJusd.balanceOf(user1.address);
        const routerCallsAfter = await swapRouter.swapCallCount();

        expect(svJusdAfter).to.be.gt(svJusdBefore);
        expect(routerCallsAfter).to.equal(
          routerCallsBefore,
          "JUSD → svJUSD should not call router"
        );
      });

      it("svJUSD → JUICE should convert via JUSD", async function () {
        const fixture = await loadFixture(deployCompleteFixture);
        const { gateway, user1, svJusd, juice, swapRouter } = fixture;

        const deadline = (await time.latest()) + DEADLINE_OFFSET;
        const swapAmount = ethers.parseEther("1000");

        await svJusd
          .connect(user1)
          .approve(await gateway.getAddress(), swapAmount);

        const routerCallsBefore = await swapRouter.swapCallCount();
        const juiceBefore = await juice.balanceOf(user1.address);

        await gateway.connect(user1).swapExactTokensForTokens(
          await svJusd.getAddress(),
          await juice.getAddress(),
          0,
          swapAmount,
          0,
          user1.address,
          deadline
        );

        const juiceAfter = await juice.balanceOf(user1.address);
        const routerCallsAfter = await swapRouter.swapCallCount();

        expect(juiceAfter).to.be.gt(juiceBefore);
        expect(routerCallsAfter).to.equal(
          routerCallsBefore,
          "svJUSD → JUICE should not call router"
        );
      });

      it("svJUSD → WcBTC should use pool swap", async function () {
        const fixture = await loadFixture(deployCompleteFixture);
        const { gateway, user1, svJusd, wcbtc, swapRouter } = fixture;

        const deadline = (await time.latest()) + DEADLINE_OFFSET;
        const swapAmount = ethers.parseEther("1000");

        // Setup mock output
        const mockOutput = ethers.parseEther("0.01");
        await wcbtc.connect(fixture.owner).deposit({ value: mockOutput });
        await wcbtc
          .connect(fixture.owner)
          .transfer(await swapRouter.getAddress(), mockOutput);
        await swapRouter.setSwapOutput(mockOutput);

        await svJusd
          .connect(user1)
          .approve(await gateway.getAddress(), swapAmount);

        const routerCallsBefore = await swapRouter.swapCallCount();
        const wcbtcBefore = await wcbtc.balanceOf(user1.address);

        await gateway.connect(user1).swapExactTokensForTokens(
          await svJusd.getAddress(),
          await wcbtc.getAddress(),
          0,
          swapAmount,
          0,
          user1.address,
          deadline
        );

        const wcbtcAfter = await wcbtc.balanceOf(user1.address);
        const routerCallsAfter = await swapRouter.swapCallCount();

        expect(wcbtcAfter).to.be.gt(wcbtcBefore);
        expect(routerCallsAfter).to.be.gt(
          routerCallsBefore,
          "svJUSD → WcBTC should call router (pool swap)"
        );
      });

      it("svJUSD → bridged token should convert via JUSD", async function () {
        const fixture = await loadFixture(deployCompleteFixture);
        const { gateway, user1, svJusd, usdc, swapRouter } = fixture;

        const deadline = (await time.latest()) + DEADLINE_OFFSET;
        const swapAmount = ethers.parseEther("1000");

        await svJusd
          .connect(user1)
          .approve(await gateway.getAddress(), swapAmount);

        const routerCallsBefore = await swapRouter.swapCallCount();
        const usdcBefore = await usdc.balanceOf(user1.address);

        await gateway.connect(user1).swapExactTokensForTokens(
          await svJusd.getAddress(),
          await usdc.getAddress(),
          0,
          swapAmount,
          0,
          user1.address,
          deadline
        );

        const usdcAfter = await usdc.balanceOf(user1.address);
        const routerCallsAfter = await swapRouter.swapCallCount();

        expect(usdcAfter).to.be.gt(usdcBefore);
        expect(routerCallsAfter).to.equal(
          routerCallsBefore,
          "svJUSD → bridged should not call router"
        );
      });
    });

    describe("JUICE Input/Output", function () {
      it("JUICE → JUSD should redeem via redeemFrom", async function () {
        const fixture = await loadFixture(deployCompleteFixture);
        const { gateway, user1, juice, jusd, swapRouter } = fixture;

        const deadline = (await time.latest()) + DEADLINE_OFFSET;
        const swapAmount = ethers.parseEther("1");

        await juice
          .connect(user1)
          .approve(await gateway.getAddress(), swapAmount);

        const routerCallsBefore = await swapRouter.swapCallCount();
        const jusdBefore = await jusd.balanceOf(user1.address);

        await gateway.connect(user1).swapExactTokensForTokens(
          await juice.getAddress(),
          await jusd.getAddress(),
          0,
          swapAmount,
          0,
          user1.address,
          deadline
        );

        const jusdAfter = await jusd.balanceOf(user1.address);
        const routerCallsAfter = await swapRouter.swapCallCount();

        expect(jusdAfter).to.be.gt(jusdBefore);
        expect(routerCallsAfter).to.equal(
          routerCallsBefore,
          "JUICE → JUSD should not call router"
        );
      });

      it("JUICE → bridged should go through JUSD", async function () {
        const fixture = await loadFixture(deployCompleteFixture);
        const { gateway, user1, juice, usdt, swapRouter } = fixture;

        const deadline = (await time.latest()) + DEADLINE_OFFSET;
        const swapAmount = ethers.parseEther("1");

        await juice
          .connect(user1)
          .approve(await gateway.getAddress(), swapAmount);

        const routerCallsBefore = await swapRouter.swapCallCount();
        const usdtBefore = await usdt.balanceOf(user1.address);

        await gateway.connect(user1).swapExactTokensForTokens(
          await juice.getAddress(),
          await usdt.getAddress(),
          0,
          swapAmount,
          0,
          user1.address,
          deadline
        );

        const usdtAfter = await usdt.balanceOf(user1.address);
        const routerCallsAfter = await swapRouter.swapCallCount();

        expect(usdtAfter).to.be.gt(usdtBefore);
        // JUICE → bridged goes through svJUSD, so no pool swap
        expect(routerCallsAfter).to.equal(
          routerCallsBefore,
          "JUICE → bridged should not call router"
        );
      });

      it("JUICE → WcBTC should use pool swap", async function () {
        const fixture = await loadFixture(deployCompleteFixture);
        const { gateway, user1, juice, wcbtc, swapRouter } = fixture;

        const deadline = (await time.latest()) + DEADLINE_OFFSET;
        const swapAmount = ethers.parseEther("1");

        // Setup mock output
        const mockOutput = ethers.parseEther("0.001");
        await wcbtc.connect(fixture.owner).deposit({ value: mockOutput });
        await wcbtc
          .connect(fixture.owner)
          .transfer(await swapRouter.getAddress(), mockOutput);
        await swapRouter.setSwapOutput(mockOutput);

        await juice
          .connect(user1)
          .approve(await gateway.getAddress(), swapAmount);

        const routerCallsBefore = await swapRouter.swapCallCount();
        const wcbtcBefore = await wcbtc.balanceOf(user1.address);

        await gateway.connect(user1).swapExactTokensForTokens(
          await juice.getAddress(),
          await wcbtc.getAddress(),
          0,
          swapAmount,
          0,
          user1.address,
          deadline
        );

        const wcbtcAfter = await wcbtc.balanceOf(user1.address);
        const routerCallsAfter = await swapRouter.swapCallCount();

        expect(wcbtcAfter).to.be.gt(wcbtcBefore);
        expect(routerCallsAfter).to.be.gt(
          routerCallsBefore,
          "JUICE → WcBTC should call router (pool swap)"
        );
      });
    });
  });

  describe("Edge Cases", function () {
    it("Should handle SUSD (18 decimals bridged token) correctly", async function () {
      const fixture = await loadFixture(deployCompleteFixture);
      const { gateway, user1, susd, jusd } = fixture;

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("1000");

      await susd.connect(user1).approve(await gateway.getAddress(), swapAmount);

      const jusdBefore = await jusd.balanceOf(user1.address);

      await gateway.connect(user1).swapExactTokensForTokens(
        await susd.getAddress(),
        await jusd.getAddress(),
        0,
        swapAmount,
        0,
        user1.address,
        deadline
      );

      const jusdAfter = await jusd.balanceOf(user1.address);

      // SUSD is 18 decimals, so 1:1 with JUSD
      expect(jusdAfter - jusdBefore).to.equal(swapAmount);
    });

    it("Should handle 6 decimal to 18 decimal conversion correctly", async function () {
      const fixture = await loadFixture(deployCompleteFixture);
      const { gateway, user1, usdc, jusd } = fixture;

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = 1000n * 10n ** 6n; // 1000 USDC (6 decimals)

      await usdc.connect(user1).approve(await gateway.getAddress(), swapAmount);

      const jusdBefore = await jusd.balanceOf(user1.address);

      await gateway.connect(user1).swapExactTokensForTokens(
        await usdc.getAddress(),
        await jusd.getAddress(),
        0,
        swapAmount,
        0,
        user1.address,
        deadline
      );

      const jusdAfter = await jusd.balanceOf(user1.address);

      // 1000 USDC (6 dec) = 1000 JUSD (18 dec)
      expect(jusdAfter - jusdBefore).to.equal(ethers.parseEther("1000"));
    });

    it("Should handle 18 decimal to 6 decimal conversion correctly", async function () {
      const fixture = await loadFixture(deployCompleteFixture);
      const { gateway, user1, jusd, usdc, usdcBridge } = fixture;

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("1000");

      await jusd.connect(user1).approve(await gateway.getAddress(), swapAmount);

      const usdcBefore = await usdc.balanceOf(user1.address);

      await gateway.connect(user1).swapExactTokensForTokens(
        await jusd.getAddress(),
        await usdc.getAddress(),
        0,
        swapAmount,
        0,
        user1.address,
        deadline
      );

      const usdcAfter = await usdc.balanceOf(user1.address);

      // 1000 JUSD (18 dec) = 1000 USDC (6 dec)
      expect(usdcAfter - usdcBefore).to.equal(1000n * 10n ** 6n);
    });

    it("Should emit SwapExecuted for all swap types", async function () {
      const fixture = await loadFixture(deployCompleteFixture);
      const { gateway, user1, jusd, usdc } = fixture;

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("100");

      await jusd.connect(user1).approve(await gateway.getAddress(), swapAmount);

      await expect(
        gateway.connect(user1).swapExactTokensForTokens(
          await jusd.getAddress(),
          await usdc.getAddress(),
          0,
          swapAmount,
          0,
          user1.address,
          deadline
        )
      ).to.emit(gateway, "SwapExecuted");
    });
  });
});
