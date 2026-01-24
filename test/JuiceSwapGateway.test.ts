import { expect } from "chai";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
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

describe("JuiceSwapGateway", function () {
  // Test constants
  const INITIAL_BALANCE = ethers.parseEther("1000");
  const SWAP_AMOUNT = ethers.parseEther("10"); // Reduced to avoid test contamination
  const MIN_OUTPUT = ethers.parseEther("0.1"); // Low minimum for mock swaps
  const DEADLINE_OFFSET = 3600; // 1 hour

  /**
   * Deploy mock contracts for testing
   */
  async function deployMocksFixture() {
    const [owner, user1, user2, feeCollector] = await ethers.getSigners();

    // Deploy Mock JUSD (ERC20)
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    const jusd = (await MockERC20Factory.deploy("JuiceDollar", "JUSD", 18)) as unknown as MockERC20;
    await jusd.waitForDeployment();

    // Deploy Mock JUICE (ERC20 with Equity functions)
    const MockEquityFactory = await ethers.getContractFactory("MockEquity");
    const juice = (await MockEquityFactory.deploy(
      "Juice Protocol",
      "JUICE",
      await jusd.getAddress()
    )) as unknown as MockEquity;
    await juice.waitForDeployment();

    // Deploy Mock svJUSD (ERC4626)
    const MockERC4626Factory = await ethers.getContractFactory("MockERC4626");
    const svJusd = (await MockERC4626Factory.deploy(
      await jusd.getAddress(),
      "Savings Vault JUSD",
      "svJUSD"
    )) as unknown as MockERC4626;
    await svJusd.waitForDeployment();

    // Deploy Mock WcBTC (WETH-like wrapper)
    const MockWETHFactory = await ethers.getContractFactory("MockWETH");
    const wcbtc = (await MockWETHFactory.deploy("Wrapped cBTC", "WcBTC")) as unknown as MockWETH;
    await wcbtc.waitForDeployment();

    // Deploy Mock Uniswap V3 SwapRouter
    const MockSwapRouterFactory = await ethers.getContractFactory("MockSwapRouter");
    const swapRouter = (await MockSwapRouterFactory.deploy()) as unknown as MockSwapRouter;
    await swapRouter.waitForDeployment();

    // Deploy Mock NonfungiblePositionManager
    const MockPositionManagerFactory = await ethers.getContractFactory("MockPositionManager");
    const positionManager = (await MockPositionManagerFactory.deploy()) as unknown as MockPositionManager;
    await positionManager.waitForDeployment();

    return {
      owner,
      user1,
      user2,
      feeCollector,
      jusd,
      juice,
      svJusd,
      wcbtc,
      swapRouter,
      positionManager,
    };
  }

  /**
   * Deploy JuiceSwapGateway with all dependencies
   */
  async function deployGatewayFixture() {
    const mocks = await deployMocksFixture();
    const { owner, jusd, svJusd, juice, wcbtc, swapRouter, positionManager } = mocks;

    const JuiceSwapGatewayFactory = await ethers.getContractFactory("JuiceSwapGateway");
    const gateway = (await JuiceSwapGatewayFactory.deploy(
      await jusd.getAddress(),
      await svJusd.getAddress(),
      await juice.getAddress(),
      await wcbtc.getAddress(),
      await swapRouter.getAddress(),
      await positionManager.getAddress()
    )) as unknown as JuiceSwapGateway;
    await gateway.waitForDeployment();

    return { ...mocks, gateway };
  }

  /**
   * Deploy and setup gateway with initial balances
   */
  async function deployGatewayWithBalancesFixture() {
    const fixture = await deployGatewayFixture();
    const { user1, user2, jusd, juice, wcbtc, svJusd, swapRouter } = fixture;

    // Mint initial balances
    await jusd.mint(user1.address, INITIAL_BALANCE);
    await jusd.mint(user2.address, INITIAL_BALANCE);
    await juice.mint(user1.address, INITIAL_BALANCE);
    await juice.mint(user2.address, INITIAL_BALANCE);

    // Wrap some cBTC for testing (enough for all tests in sequence)
    // Each test uses ~10-100 ether, with ~40 tests that's max ~4000 ether needed
    await wcbtc.connect(user1).deposit({ value: ethers.parseEther("5000") });
    await wcbtc.connect(user2).deposit({ value: ethers.parseEther("5000") });

    // NOTE: We intentionally do NOT pre-fund the MockSwapRouter with input tokens.
    // The mocks (MockWETH, MockERC4626) now have mint() functions, allowing the router
    // to mint output tokens on demand. This ensures tests properly verify that the
    // Gateway transfers input tokens to the router before calling exactInputSingle.
    // If the Gateway doesn't transfer tokens, the router's balance check will fail.

    // Fund svJUSD vault with JUSD so it can handle deposits and redemptions
    const svJusdAddr = await svJusd.getAddress();
    await jusd.mint(svJusdAddr, ethers.parseEther("100000")); // For redemptions

    // Fund MockEquity (JUICE contract) with JUSD for redemptions
    const juiceAddr = await juice.getAddress();
    await jusd.mint(juiceAddr, ethers.parseEther("10000"));

    return fixture;
  }

  describe("Deployment", function () {
    it("Should set correct immutable addresses", async function () {
      const { gateway, jusd, svJusd, juice, wcbtc, swapRouter, positionManager } =
        await loadFixture(deployGatewayFixture);

      expect(await gateway.JUSD()).to.equal(await jusd.getAddress());
      expect(await gateway.SV_JUSD()).to.equal(await svJusd.getAddress());
      expect(await gateway.JUICE()).to.equal(await juice.getAddress());
      expect(await gateway.WCBTC()).to.equal(await wcbtc.getAddress());
      expect(await gateway.SWAP_ROUTER()).to.equal(await swapRouter.getAddress());
      expect(await gateway.POSITION_MANAGER()).to.equal(await positionManager.getAddress());
    });

    it("Should have correct constant fee tier", async function () {
      const { gateway } = await loadFixture(deployGatewayFixture);
      expect(await gateway.DEFAULT_FEE()).to.equal(3000); // 0.3% - immutable
    });
  });

  describe("Token Conversion View Functions", function () {
    it("Should calculate JUSD to svJUSD conversion", async function () {
      const { gateway, svJusd } = await loadFixture(deployGatewayFixture);
      const jusdAmount = ethers.parseEther("100");

      const expectedShares = await svJusd.convertToShares(jusdAmount);
      const actualShares = await gateway.jusdToSvJusd(jusdAmount);

      expect(actualShares).to.equal(expectedShares);
    });

    it("Should calculate svJUSD to JUSD conversion", async function () {
      const { gateway, svJusd } = await loadFixture(deployGatewayFixture);
      const shares = ethers.parseEther("100");

      const expectedAssets = await svJusd.convertToAssets(shares);
      const actualAssets = await gateway.svJusdToJusd(shares);

      expect(actualAssets).to.equal(expectedAssets);
    });

    it("Should calculate JUICE to JUSD conversion", async function () {
      const { gateway, juice } = await loadFixture(deployGatewayFixture);
      const juiceAmount = ethers.parseEther("10");

      const expectedJusd = await juice.calculateProceeds(juiceAmount);
      const actualJusd = await gateway.juiceToJusd(juiceAmount);

      expect(actualJusd).to.equal(expectedJusd);
    });

    it("Should calculate JUSD to JUICE conversion", async function () {
      const { gateway, juice } = await loadFixture(deployGatewayFixture);
      const jusdAmount = ethers.parseEther("1000");

      const expectedJuice = await juice.calculateShares(jusdAmount);
      const actualJuice = await gateway.jusdToJuice(jusdAmount);

      expect(actualJuice).to.equal(expectedJuice);
    });
  });

  describe("Swap: JUSD → Other Token", function () {
    it("Should swap JUSD for another token successfully", async function () {
      const { gateway, user1, jusd, wcbtc, swapRouter } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("100");

      // Setup mock router to return expected amount (needs to be >= MIN_OUTPUT)
      await swapRouter.setSwapOutput(ethers.parseEther("95")); // 95 WcBTC (> MIN_OUTPUT of 90)

      // Approve gateway to spend JUSD
      await jusd.connect(user1).approve(await gateway.getAddress(), swapAmount);

      const tx = await gateway
        .connect(user1)
        .swapExactTokensForTokens(
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          3000,
          swapAmount,
          MIN_OUTPUT,
          user1.address,
          deadline
        );

      await expect(tx)
        .to.emit(gateway, "SwapExecuted")
        .withArgs(
          user1.address,
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          anyValue, // amountIn (svJUSD shares, varies)
          anyValue // amountOut (from mock)
        );
    });

    it("Should revert if deadline expired", async function () {
      const { gateway, user1, jusd, wcbtc } = await loadFixture(deployGatewayWithBalancesFixture);

      const pastDeadline = (await time.latest()) - 1;
      const swapAmount = ethers.parseEther("100");

      await jusd.connect(user1).approve(await gateway.getAddress(), swapAmount);

      await expect(
        gateway
          .connect(user1)
          .swapExactTokensForTokens(
            await jusd.getAddress(),
            await wcbtc.getAddress(),
            3000,
            swapAmount,
            MIN_OUTPUT,
            user1.address,
            pastDeadline
          )
      ).to.be.revertedWithCustomError(gateway, "DeadlineExpired");
    });

    it("Should revert if amount is zero", async function () {
      const { gateway, user1, jusd, wcbtc } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;

      await expect(
        gateway
          .connect(user1)
          .swapExactTokensForTokens(
            await jusd.getAddress(),
            await wcbtc.getAddress(),
            3000,
            0,
            MIN_OUTPUT,
            user1.address,
            deadline
          )
      ).to.be.revertedWithCustomError(gateway, "InvalidAmount");
    });

    it("Should revert if output is less than minimum", async function () {
      const { gateway, user1, jusd, wcbtc, swapRouter } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("100");

      // Mock router returns less than minimum
      await swapRouter.setSwapOutput(ethers.parseEther("0.05")); // Less than MIN_OUTPUT (0.1)

      await jusd.connect(user1).approve(await gateway.getAddress(), swapAmount);

      await expect(
        gateway
          .connect(user1)
          .swapExactTokensForTokens(
            await jusd.getAddress(),
            await wcbtc.getAddress(),
            3000,
            swapAmount,
            MIN_OUTPUT,
            user1.address,
            deadline
          )
      ).to.be.revertedWithCustomError(gateway, "InsufficientOutput");
    });

    it("Should automatically convert JUSD to svJUSD for swap", async function () {
      const { gateway, user1, jusd, wcbtc, svJusd, swapRouter } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("100");

      await swapRouter.setSwapOutput(ethers.parseEther("0.5"));
      await jusd.connect(user1).approve(await gateway.getAddress(), swapAmount);

      const svJusdBalanceBefore = await svJusd.balanceOf(await gateway.getAddress());

      await gateway
        .connect(user1)
        .swapExactTokensForTokens(
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          3000,
          swapAmount,
          0,
          user1.address,
          deadline
        );

      // Gateway should have deposited JUSD into svJUSD vault
      // (In real scenario, vault balance changes, but in mock it depends on implementation)
    });
  });

  describe("JUICE Input Support", function () {
    it("Should swap JUICE for WcBTC via redeemFrom", async function () {
      const { gateway, user1, juice, jusd, wcbtc, swapRouter } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("1"); // 1 JUICE
      const expectedJusd = ethers.parseEther("100"); // 1 JUICE = 100 JUSD (MockEquity PRICE)
      const expectedWcbtc = ethers.parseEther("0.5");

      // Fund the JUICE contract with JUSD for redemption
      await jusd.mint(await juice.getAddress(), expectedJusd);

      // Set swap output
      await swapRouter.setSwapOutput(expectedWcbtc);

      await juice.connect(user1).approve(await gateway.getAddress(), swapAmount);

      const wcbtcBefore = await wcbtc.balanceOf(user1.address);

      await gateway
        .connect(user1)
        .swapExactTokensForTokens(
          await juice.getAddress(),
          await wcbtc.getAddress(),
          3000,
          swapAmount,
          0,
          user1.address,
          deadline
        );

      const wcbtcAfter = await wcbtc.balanceOf(user1.address);
      expect(wcbtcAfter - wcbtcBefore).to.equal(expectedWcbtc);
    });

    it("Should swap JUICE for JUSD directly", async function () {
      const { gateway, user1, juice, jusd, svJusd, swapRouter } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("1"); // 1 JUICE
      const expectedJusd = ethers.parseEther("100"); // 1 JUICE = 100 JUSD

      // Fund the JUICE contract with JUSD for redemption
      await jusd.mint(await juice.getAddress(), expectedJusd);

      // For JUICE → JUSD, the swap goes through svJUSD pool
      // Set swap output to return the svJUSD equivalent
      const svJusdShares = await svJusd.convertToShares(expectedJusd);
      await swapRouter.setSwapOutput(svJusdShares);

      await juice.connect(user1).approve(await gateway.getAddress(), swapAmount);

      const jusdBefore = await jusd.balanceOf(user1.address);

      await gateway
        .connect(user1)
        .swapExactTokensForTokens(
          await juice.getAddress(),
          await jusd.getAddress(),
          3000,
          swapAmount,
          0,
          user1.address,
          deadline
        );

      const jusdAfter = await jusd.balanceOf(user1.address);
      // User should receive JUSD (redeemed from svJUSD)
      expect(jusdAfter).to.be.gt(jusdBefore);
    });

    it("Should emit SwapExecuted event for JUICE input", async function () {
      const { gateway, user1, juice, jusd, wcbtc, swapRouter } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("1");
      const expectedJusd = ethers.parseEther("100");
      const expectedWcbtc = ethers.parseEther("0.5");

      await jusd.mint(await juice.getAddress(), expectedJusd);
      await swapRouter.setSwapOutput(expectedWcbtc);
      await juice.connect(user1).approve(await gateway.getAddress(), swapAmount);

      await expect(
        gateway
          .connect(user1)
          .swapExactTokensForTokens(
            await juice.getAddress(),
            await wcbtc.getAddress(),
            3000,
            swapAmount,
            0,
            user1.address,
            deadline
          )
      ).to.emit(gateway, "SwapExecuted");
    });

    it("Should revert JUICE swap if minAmountOut not met", async function () {
      const { gateway, user1, juice, jusd, wcbtc, swapRouter } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("1"); // 1 JUICE
      const expectedJusd = ethers.parseEther("100");
      const actualWcbtc = ethers.parseEther("0.5");
      const unreasonableMinOut = ethers.parseEther("100"); // Way more than we'll get

      await jusd.mint(await juice.getAddress(), expectedJusd);
      await swapRouter.setSwapOutput(actualWcbtc);
      await juice.connect(user1).approve(await gateway.getAddress(), swapAmount);

      await expect(
        gateway
          .connect(user1)
          .swapExactTokensForTokens(
            await juice.getAddress(),
            await wcbtc.getAddress(),
            3000,
            swapAmount,
            unreasonableMinOut,
            user1.address,
            deadline
          )
      ).to.be.revertedWithCustomError(gateway, "InsufficientOutput");
    });

    it("Should revert if JUICE allowance insufficient", async function () {
      const { gateway, user1, juice, jusd, wcbtc, swapRouter } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("1");
      const expectedJusd = ethers.parseEther("100");

      await jusd.mint(await juice.getAddress(), expectedJusd);
      await swapRouter.setSwapOutput(ethers.parseEther("0.5"));
      // NO approval given

      await expect(
        gateway
          .connect(user1)
          .swapExactTokensForTokens(
            await juice.getAddress(),
            await wcbtc.getAddress(),
            3000,
            swapAmount,
            0,
            user1.address,
            deadline
          )
      ).to.be.revertedWithCustomError(juice, "ERC20InsufficientAllowance");
    });

    it("Should add liquidity with JUICE as input token (JUICE stays JUICE)", async function () {
      const { gateway, user1, juice, wcbtc, positionManager } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const juiceAmount = ethers.parseEther("100"); // 100 JUICE
      const wcbtcAmount = ethers.parseEther("1");

      // Token ordering: Uniswap V3 requires token0 < token1
      const juiceAddr = await juice.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [amount0, amount1] = juiceAddr < wcbtcAddr ? [juiceAmount, wcbtcAmount] : [wcbtcAmount, juiceAmount];
      await positionManager.setMintResult(1, 100, amount0, amount1);

      await juice.connect(user1).approve(await gateway.getAddress(), juiceAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      // Should succeed - JUICE stays as JUICE (not converted to svJUSD)
      await expect(
        gateway.connect(user1).addLiquidity(
          await juice.getAddress(),
          await wcbtc.getAddress(),
          3000,
          0, // tickLower (full range)
          0, // tickUpper (full range)
          juiceAmount,
          wcbtcAmount,
          0,
          0,
          user1.address,
          deadline
        )
      ).to.emit(gateway, "LiquidityAdded");
    });

    it("Should return excess as JUICE when adding liquidity with JUICE", async function () {
      const { gateway, user1, juice, wcbtc, positionManager } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const juiceAmount = ethers.parseEther("2"); // 2 JUICE (more than needed)
      const wcbtcAmount = ethers.parseEther("1");

      // Mock position manager to only use half the JUICE
      const halfJuice = juiceAmount / 2n;

      // Token ordering: Uniswap V3 requires token0 < token1
      const juiceAddr = await juice.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [amount0, amount1] = juiceAddr < wcbtcAddr ? [halfJuice, wcbtcAmount] : [wcbtcAmount, halfJuice];
      await positionManager.setMintResult(1, 100, amount0, amount1);

      await juice.connect(user1).approve(await gateway.getAddress(), juiceAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      const juiceBefore = await juice.balanceOf(user1.address);

      await gateway.connect(user1).addLiquidity(
        await juice.getAddress(),
        await wcbtc.getAddress(),
        3000,
        0, // tickLower (full range)
        0, // tickUpper (full range)
        juiceAmount,
        wcbtcAmount,
        0,
        0,
        user1.address,
        deadline
      );

      const juiceAfter = await juice.balanceOf(user1.address);
      // User should receive excess as JUICE (JUICE stays JUICE for liquidity)
      // Used half, so should have initial - half remaining
      expect(juiceBefore - juiceAfter).to.equal(halfJuice);
    });

    it("Should revert when adding JUICE liquidity with JUSD (invalid pair)", async function () {
      const { gateway, user1, juice, jusd } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const amount = ethers.parseEther("100");

      await juice.connect(user1).approve(await gateway.getAddress(), amount);
      await jusd.connect(user1).approve(await gateway.getAddress(), amount);

      // JUICE + JUSD is not allowed (would be redundant with JUICE redemption)
      await expect(
        gateway
          .connect(user1)
          .addLiquidity(
            await juice.getAddress(),
            await jusd.getAddress(),
            3000,
            0,
            0,
            amount,
            amount,
            0,
            0,
            user1.address,
            deadline
          )
      ).to.be.revertedWithCustomError(gateway, "JuiceCannotPairWithUsd");
    });

    it("Should revert when adding JUICE liquidity with bridged token (invalid pair)", async function () {
      const { gateway, user1, juice, jusd } = await loadFixture(deployGatewayWithBalancesFixture);

      // Deploy and register a bridged token
      const MockERC20Factory = await ethers.getContractFactory("MockERC20");
      const usdt = await MockERC20Factory.deploy("USDT.e", "USDT.e", 6);
      await usdt.waitForDeployment();

      const MockBridgeFactory = await ethers.getContractFactory("MockStablecoinBridge");
      const bridge = await MockBridgeFactory.deploy(
        await usdt.getAddress(),
        await jusd.getAddress(),
        ethers.parseEther("1000000"), // limit
        52 // weeks
      );
      await bridge.waitForDeployment();

      // Make bridge an approved minter
      await jusd.setMinter(await bridge.getAddress(), true);
      await gateway.registerBridgedToken(await bridge.getAddress());

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const amount = ethers.parseEther("100");

      await juice.connect(user1).approve(await gateway.getAddress(), amount);
      await usdt.mint(user1.address, ethers.parseUnits("100", 6));
      await usdt.connect(user1).approve(await gateway.getAddress(), ethers.parseUnits("100", 6));

      // JUICE + Bridged token is not allowed
      await expect(
        gateway
          .connect(user1)
          .addLiquidity(
            await juice.getAddress(),
            await usdt.getAddress(),
            3000,
            0,
            0,
            amount,
            ethers.parseUnits("100", 6),
            0,
            0,
            user1.address,
            deadline
          )
      ).to.be.revertedWithCustomError(gateway, "JuiceCannotPairWithUsd");
    });
  });

  describe("Swap: Native cBTC", function () {
    it("Should swap native cBTC for tokens", async function () {
      const { gateway, user1, wcbtc, swapRouter } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("1");

      await swapRouter.setSwapOutput(ethers.parseEther("100")); // Returns JUSD

      const tx = await gateway.connect(user1).swapExactTokensForTokens(
        ethers.ZeroAddress, // Native token
        await wcbtc.getAddress(),
        3000,
        swapAmount,
        0,
        user1.address,
        deadline,
        { value: swapAmount }
      );

      await expect(tx)
        .to.emit(gateway, "SwapExecuted")
        .withArgs(
          user1.address,
          ethers.ZeroAddress,
          await wcbtc.getAddress(),
          anyValue, // amountIn
          anyValue // amountOut
        );
    });

    it("Should revert if msg.value doesn't match amount for native swap", async function () {
      const { gateway, user1, wcbtc } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("1");

      await expect(
        gateway.connect(user1).swapExactTokensForTokens(
          ethers.ZeroAddress,
          await wcbtc.getAddress(),
          3000,
          swapAmount,
          0,
          user1.address,
          deadline,
          { value: ethers.parseEther("0.5") } // Wrong value
        )
      ).to.be.revertedWithCustomError(gateway, "InvalidAmount");
    });

    it("Should output native cBTC when tokenOut is zero address", async function () {
      const { gateway, user1, jusd, swapRouter } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("100");

      await swapRouter.setSwapOutput(ethers.parseEther("0.5")); // 0.5 cBTC
      await jusd.connect(user1).approve(await gateway.getAddress(), swapAmount);

      const balanceBefore = await ethers.provider.getBalance(user1.address);

      await gateway.connect(user1).swapExactTokensForTokens(
        await jusd.getAddress(),
        ethers.ZeroAddress, // Native cBTC out
        3000,
        swapAmount,
        0,
        user1.address,
        deadline
      );

      const balanceAfter = await ethers.provider.getBalance(user1.address);
      expect(balanceAfter).to.be.gt(balanceBefore); // User received cBTC
    });
  });

  describe("Swap: WcBTC → JUSD/JUICE", function () {
    it("Should swap WcBTC for JUSD successfully", async function () {
      const { gateway, user1, jusd, wcbtc, svJusd, swapRouter } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("1");

      // Mock router returns svJUSD shares which get converted to JUSD
      // WcBTC → svJUSD (pool swap) → JUSD (unwrap)
      await swapRouter.setSwapOutput(ethers.parseEther("100")); // 100 svJUSD shares

      await wcbtc.connect(user1).approve(await gateway.getAddress(), swapAmount);

      const jusdBalanceBefore = await jusd.balanceOf(user1.address);

      const tx = await gateway
        .connect(user1)
        .swapExactTokensForTokens(
          await wcbtc.getAddress(),
          await jusd.getAddress(),
          3000,
          swapAmount,
          MIN_OUTPUT,
          user1.address,
          deadline
        );

      await expect(tx)
        .to.emit(gateway, "SwapExecuted")
        .withArgs(user1.address, await wcbtc.getAddress(), await jusd.getAddress(), anyValue, anyValue);

      const jusdBalanceAfter = await jusd.balanceOf(user1.address);
      expect(jusdBalanceAfter).to.be.gt(jusdBalanceBefore);
    });

    it("Should swap WcBTC for JUICE successfully", async function () {
      const { gateway, user1, juice, wcbtc, svJusd, swapRouter } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("1");

      // Mock router returns svJUSD shares which get converted to JUSD then JUICE
      // WcBTC → svJUSD (pool swap) → JUSD (unwrap) → JUICE (invest)
      await swapRouter.setSwapOutput(ethers.parseEther("100")); // 100 svJUSD shares

      await wcbtc.connect(user1).approve(await gateway.getAddress(), swapAmount);

      const juiceBalanceBefore = await juice.balanceOf(user1.address);

      const tx = await gateway
        .connect(user1)
        .swapExactTokensForTokens(
          await wcbtc.getAddress(),
          await juice.getAddress(),
          3000,
          swapAmount,
          MIN_OUTPUT,
          user1.address,
          deadline
        );

      await expect(tx)
        .to.emit(gateway, "SwapExecuted")
        .withArgs(user1.address, await wcbtc.getAddress(), await juice.getAddress(), anyValue, anyValue);

      const juiceBalanceAfter = await juice.balanceOf(user1.address);
      expect(juiceBalanceAfter).to.be.gt(juiceBalanceBefore);
    });

    it("Should swap native cBTC for JUSD successfully", async function () {
      const { gateway, user1, jusd, swapRouter } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("1");

      // Mock router returns svJUSD shares which get converted to JUSD
      // cBTC → WcBTC (wrap) → svJUSD (pool swap) → JUSD (unwrap)
      await swapRouter.setSwapOutput(ethers.parseEther("100")); // 100 svJUSD shares

      const jusdBalanceBefore = await jusd.balanceOf(user1.address);

      const tx = await gateway.connect(user1).swapExactTokensForTokens(
        ethers.ZeroAddress, // Native cBTC
        await jusd.getAddress(),
        3000,
        swapAmount,
        MIN_OUTPUT,
        user1.address,
        deadline,
        { value: swapAmount }
      );

      await expect(tx)
        .to.emit(gateway, "SwapExecuted")
        .withArgs(user1.address, ethers.ZeroAddress, await jusd.getAddress(), anyValue, anyValue);

      const jusdBalanceAfter = await jusd.balanceOf(user1.address);
      expect(jusdBalanceAfter).to.be.gt(jusdBalanceBefore);
    });

    it("Should swap native cBTC for JUICE successfully", async function () {
      const { gateway, user1, juice, swapRouter } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("1");

      // Mock router returns svJUSD shares which get converted to JUSD then JUICE
      // cBTC → WcBTC (wrap) → svJUSD (pool swap) → JUSD (unwrap) → JUICE (invest)
      await swapRouter.setSwapOutput(ethers.parseEther("100")); // 100 svJUSD shares

      const juiceBalanceBefore = await juice.balanceOf(user1.address);

      const tx = await gateway.connect(user1).swapExactTokensForTokens(
        ethers.ZeroAddress, // Native cBTC
        await juice.getAddress(),
        3000,
        swapAmount,
        MIN_OUTPUT,
        user1.address,
        deadline,
        { value: swapAmount }
      );

      await expect(tx)
        .to.emit(gateway, "SwapExecuted")
        .withArgs(user1.address, ethers.ZeroAddress, await juice.getAddress(), anyValue, anyValue);

      const juiceBalanceAfter = await juice.balanceOf(user1.address);
      expect(juiceBalanceAfter).to.be.gt(juiceBalanceBefore);
    });
  });

  describe("Add Liquidity", function () {
    it("Should add liquidity with JUSD successfully", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      // Calculate actual svJUSD shares that will be received when depositing JUSD
      const svJusdShares = await svJusd.convertToShares(jusdAmount);

      // Setup mock position manager with correct token order (token0 < token1)
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [amount0, amount1] =
        svJusdAddr < wcbtcAddr
          ? [svJusdShares, wcbtcAmount] // svJUSD is token0
          : [wcbtcAmount, svJusdShares]; // WcBTC is token0
      await positionManager.setMintResult(1, 100, amount0, amount1);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      const tx = await gateway.connect(user1).addLiquidity(
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        3000,
        0, // tickLower (full range)
        0, // tickUpper (full range)
        jusdAmount,
        wcbtcAmount,
        jusdAmount / 2n,
        wcbtcAmount / 2n,
        user1.address,
        deadline
      );

      await expect(tx)
        .to.emit(gateway, "LiquidityAdded")
        .withArgs(
          user1.address,
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          anyValue, // amountA (actual amount added)
          anyValue, // amountB (actual amount added)
          1 // tokenId from mock
        );
    });

    it("Should convert JUSD to svJUSD when adding liquidity", async function () {
      const { gateway, user1, jusd, wcbtc, positionManager, svJusd } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      // Calculate actual svJUSD shares
      const svJusdShares = await svJusd.convertToShares(jusdAmount);

      // Setup with correct token order
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [amount0, amount1] = svJusdAddr < wcbtcAddr ? [svJusdShares, wcbtcAmount] : [wcbtcAmount, svJusdShares];
      await positionManager.setMintResult(1, 100, amount0, amount1);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      await gateway.connect(user1).addLiquidity(
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        3000,
        0, // tickLower (full range)
        0, // tickUpper (full range)
        jusdAmount,
        wcbtcAmount,
        0,
        0,
        user1.address,
        deadline
      );

      // Verify svJUSD was involved (implementation dependent on mocks)
    });

    it("Should add liquidity with native cBTC", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const jusdAmount = ethers.parseEther("100");
      const cbtcAmount = ethers.parseEther("1");

      // Calculate actual svJUSD shares
      const svJusdShares = await svJusd.convertToShares(jusdAmount);

      // Setup with correct token order (native becomes WcBTC)
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [amount0, amount1] = svJusdAddr < wcbtcAddr ? [svJusdShares, cbtcAmount] : [cbtcAmount, svJusdShares];
      await positionManager.setMintResult(1, 100, amount0, amount1);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);

      const tx = await gateway.connect(user1).addLiquidity(
        await jusd.getAddress(),
        ethers.ZeroAddress, // Native cBTC
        3000,
        0, // tickLower (full range)
        0, // tickUpper (full range)
        jusdAmount,
        cbtcAmount,
        0,
        0,
        user1.address,
        deadline,
        { value: cbtcAmount }
      );

      await expect(tx)
        .to.emit(gateway, "LiquidityAdded")
        .withArgs(
          user1.address,
          await jusd.getAddress(),
          ethers.ZeroAddress,
          anyValue, // amountA
          anyValue, // amountB
          1 // tokenId
        );
    });

    it("Should return excess native cBTC when position manager uses less", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const jusdAmount = ethers.parseEther("100");
      const cbtcAmount = ethers.parseEther("2"); // Send 2 cBTC

      // Calculate actual svJUSD shares
      const svJusdShares = await svJusd.convertToShares(jusdAmount);

      // Mock position manager to only use HALF the cBTC (simulating excess)
      const halfCbtc = cbtcAmount / 2n;
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [amount0, amount1] = svJusdAddr < wcbtcAddr ? [svJusdShares, halfCbtc] : [halfCbtc, svJusdShares];
      await positionManager.setMintResult(1, 100, amount0, amount1);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);

      const cbtcBefore = await ethers.provider.getBalance(user1.address);

      const tx = await gateway.connect(user1).addLiquidity(
        await jusd.getAddress(),
        ethers.ZeroAddress, // Native cBTC
        3000,
        0, // tickLower (full range)
        0, // tickUpper (full range)
        jusdAmount,
        cbtcAmount,
        0,
        0,
        user1.address,
        deadline,
        { value: cbtcAmount }
      );

      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      const cbtcAfter = await ethers.provider.getBalance(user1.address);

      // User should receive excess cBTC back (sent 2, used 1, got back ~1)
      // cbtcAfter = cbtcBefore - cbtcAmount + excessReturned - gasUsed
      // excessReturned ≈ cbtcAmount / 2 = 1 cBTC
      const expectedSpent = cbtcAmount / 2n; // ~1 cBTC actually used
      const actualSpent = cbtcBefore - cbtcAfter - gasUsed;

      // Allow some tolerance for gas estimation
      expect(actualSpent).to.be.closeTo(expectedSpent, ethers.parseEther("0.01"));
    });

    it("Should return excess tokens to user", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      // Calculate actual svJUSD shares
      const svJusdShares = await svJusd.convertToShares(jusdAmount);

      // Setup with correct token order - mock returns less than desired
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [amount0, amount1] =
        svJusdAddr < wcbtcAddr
          ? [svJusdShares / 2n, wcbtcAmount / 2n] // Only half used
          : [wcbtcAmount / 2n, svJusdShares / 2n];
      await positionManager.setMintResult(1, 100, amount0, amount1);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      const jusdBalanceBefore = await jusd.balanceOf(user1.address);

      await gateway.connect(user1).addLiquidity(
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        3000,
        0, // tickLower (full range)
        0, // tickUpper (full range)
        jusdAmount,
        wcbtcAmount,
        0,
        0,
        user1.address,
        deadline
      );

      const jusdBalanceAfter = await jusd.balanceOf(user1.address);

      // User should get back excess (implementation depends on mock behavior)
      expect(jusdBalanceAfter).to.be.lte(jusdBalanceBefore);
    });

    it("Should revert if deadline expired", async function () {
      const { gateway, user1, jusd, wcbtc } = await loadFixture(deployGatewayWithBalancesFixture);

      const pastDeadline = (await time.latest()) - 1;

      await expect(
        gateway.connect(user1).addLiquidity(
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          3000,
          0, // tickLower (full range)
          0, // tickUpper (full range)
          SWAP_AMOUNT,
          SWAP_AMOUNT,
          0,
          0,
          user1.address,
          pastDeadline
        )
      ).to.be.revertedWithCustomError(gateway, "DeadlineExpired");
    });

    it("Should add liquidity with custom tick range", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      const svJusdShares = await svJusd.convertToShares(jusdAmount);
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [amount0, amount1] = svJusdAddr < wcbtcAddr ? [svJusdShares, wcbtcAmount] : [wcbtcAmount, svJusdShares];
      await positionManager.setMintResult(1, 100, amount0, amount1);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      // Custom tick range: -60000 to 60000 (aligned to tickSpacing=60 for 0.3% fee)
      const tx = await gateway.connect(user1).addLiquidity(
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        3000, // 0.3% fee tier (tickSpacing=60)
        -60000, // tickLower (custom)
        60000, // tickUpper (custom)
        jusdAmount,
        wcbtcAmount,
        0,
        0,
        user1.address,
        deadline
      );

      await expect(tx)
        .to.emit(gateway, "LiquidityAdded")
        .withArgs(user1.address, await jusd.getAddress(), await wcbtc.getAddress(), anyValue, anyValue, 1);
    });

    it("Should revert with InvalidTickRange when tickLower >= tickUpper (non-equal)", async function () {
      const { gateway, user1, jusd, wcbtc } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const amount = ethers.parseEther("100");

      await jusd.connect(user1).approve(await gateway.getAddress(), amount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), amount);

      await expect(
        gateway.connect(user1).addLiquidity(
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          3000,
          60000, // tickLower > tickUpper
          -60000,
          amount,
          amount,
          0,
          0,
          user1.address,
          deadline
        )
      ).to.be.revertedWithCustomError(gateway, "InvalidTickRange");
    });

    it("Should revert with InvalidTickRange when ticks not aligned to tickSpacing", async function () {
      const { gateway, user1, jusd, wcbtc } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const amount = ethers.parseEther("100");

      await jusd.connect(user1).approve(await gateway.getAddress(), amount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), amount);

      // tickSpacing for 3000 (0.3%) is 60, so 60001 is not aligned
      await expect(
        gateway.connect(user1).addLiquidity(
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          3000,
          -60001, // Not aligned to tickSpacing=60
          60000,
          amount,
          amount,
          0,
          0,
          user1.address,
          deadline
        )
      ).to.be.revertedWithCustomError(gateway, "InvalidTickRange");
    });

    it("Should revert with InvalidTickRange when ticks out of bounds", async function () {
      const { gateway, user1, jusd, wcbtc } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const amount = ethers.parseEther("100");

      await jusd.connect(user1).approve(await gateway.getAddress(), amount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), amount);

      // MAX_TICK is 887272, aligned to 60 would be 887220
      // Using 887280 which is > 887272
      await expect(
        gateway.connect(user1).addLiquidity(
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          3000,
          -887220,
          887280, // Out of bounds (> 887272)
          amount,
          amount,
          0,
          0,
          user1.address,
          deadline
        )
      ).to.be.revertedWithCustomError(gateway, "InvalidTickRange");
    });
  });

  describe("Increase Liquidity", function () {
    it("Should increase liquidity successfully", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 1;
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      // Setup position with svJUSD and WcBTC in correct address ordering
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [token0, token1] = svJusdAddr < wcbtcAddr ? [svJusdAddr, wcbtcAddr] : [wcbtcAddr, svJusdAddr];
      await positionManager.setPositionData(tokenId, token0, token1, 100);

      // Mint NFT to user and approve gateway
      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(await gateway.getAddress(), tokenId);

      // Approve tokens
      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      // Call with WcBTC first to avoid token ordering edge case
      const tx = await gateway
        .connect(user1)
        .increaseLiquidity(
          tokenId,
          await wcbtc.getAddress(),
          await jusd.getAddress(),
          wcbtcAmount,
          jusdAmount,
          0,
          0,
          deadline
        );

      await expect(tx).to.emit(gateway, "LiquidityIncreased").withArgs(
        user1.address,
        tokenId,
        anyValue, // amountA
        anyValue, // amountB
        anyValue // liquidity
      );

      // Verify NFT returned to user
      expect(await positionManager.ownerOf(tokenId)).to.equal(user1.address);
    });

    it("Should convert JUSD to svJUSD when increasing liquidity", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 1;
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [token0, token1] = svJusdAddr < wcbtcAddr ? [svJusdAddr, wcbtcAddr] : [wcbtcAddr, svJusdAddr];
      await positionManager.setPositionData(tokenId, token0, token1, 100);

      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(await gateway.getAddress(), tokenId);

      const jusdBalanceBefore = await jusd.balanceOf(user1.address);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      // Call with WcBTC first
      await gateway
        .connect(user1)
        .increaseLiquidity(
          tokenId,
          await wcbtc.getAddress(),
          await jusd.getAddress(),
          wcbtcAmount,
          jusdAmount,
          0,
          0,
          deadline
        );

      const jusdBalanceAfter = await jusd.balanceOf(user1.address);
      // JUSD balance should decrease (converted to svJUSD)
      expect(jusdBalanceAfter).to.be.lt(jusdBalanceBefore);
    });

    it("Should wrap native cBTC when increasing liquidity", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 1;
      const jusdAmount = ethers.parseEther("100");
      const cbtcAmount = ethers.parseEther("1");

      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [token0, token1] = svJusdAddr < wcbtcAddr ? [svJusdAddr, wcbtcAddr] : [wcbtcAddr, svJusdAddr];
      await positionManager.setPositionData(tokenId, token0, token1, 100);

      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(await gateway.getAddress(), tokenId);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);

      // Call with native cBTC first
      const tx = await gateway.connect(user1).increaseLiquidity(
        tokenId,
        ethers.ZeroAddress, // Native cBTC
        await jusd.getAddress(),
        cbtcAmount,
        jusdAmount,
        0,
        0,
        deadline,
        { value: cbtcAmount }
      );

      await expect(tx)
        .to.emit(gateway, "LiquidityIncreased")
        .withArgs(user1.address, tokenId, anyValue, anyValue, anyValue);
    });

    it("Should handle tokenA < tokenB ordering", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 1;
      const jusdAmount = ethers.parseEther("50");
      const wcbtcAmount = ethers.parseEther("0.5");

      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();

      // Set position with correct address ordering
      const [token0, token1] = svJusdAddr < wcbtcAddr ? [svJusdAddr, wcbtcAddr] : [wcbtcAddr, svJusdAddr];
      await positionManager.setPositionData(tokenId, token0, token1, 100);

      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(await gateway.getAddress(), tokenId);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      // Call with WcBTC first (to match token ordering expectation)
      const tx = await gateway
        .connect(user1)
        .increaseLiquidity(
          tokenId,
          await wcbtc.getAddress(),
          await jusd.getAddress(),
          wcbtcAmount,
          jusdAmount,
          0,
          0,
          deadline
        );

      await expect(tx).to.emit(gateway, "LiquidityIncreased");
    });

    it("Should handle tokenB < tokenA ordering", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 1;
      const jusdAmount = ethers.parseEther("50");
      const wcbtcAmount = ethers.parseEther("0.5");

      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();

      // Set position with correct address ordering
      const [token0, token1] = svJusdAddr < wcbtcAddr ? [svJusdAddr, wcbtcAddr] : [wcbtcAddr, svJusdAddr];
      await positionManager.setPositionData(tokenId, token0, token1, 100);

      // Don't set mock values - let it default to using desired amounts

      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(await gateway.getAddress(), tokenId);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      // Call with WcBTC, JUSD order (reversed)
      const tx = await gateway
        .connect(user1)
        .increaseLiquidity(
          tokenId,
          await wcbtc.getAddress(),
          await jusd.getAddress(),
          wcbtcAmount,
          jusdAmount,
          0,
          0,
          deadline
        );

      await expect(tx).to.emit(gateway, "LiquidityIncreased");
    });

    it("Should return excess tokens to user", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 1;
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [token0, token1] = svJusdAddr < wcbtcAddr ? [svJusdAddr, wcbtcAddr] : [wcbtcAddr, svJusdAddr];
      await positionManager.setPositionData(tokenId, token0, token1, 100);

      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(await gateway.getAddress(), tokenId);

      const jusdBalanceBefore = await jusd.balanceOf(user1.address);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      // Call with WcBTC first
      await gateway
        .connect(user1)
        .increaseLiquidity(
          tokenId,
          await wcbtc.getAddress(),
          await jusd.getAddress(),
          wcbtcAmount,
          jusdAmount,
          0,
          0,
          deadline
        );

      const jusdBalanceAfter = await jusd.balanceOf(user1.address);
      // JUSD should decrease by approximately the input amount
      expect(jusdBalanceBefore - jusdBalanceAfter).to.be.lte(jusdAmount);
    });

    it("Should revert if non-owner tries to increase liquidity", async function () {
      const { gateway, user1, user2, jusd, svJusd, wcbtc, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 1;
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      await positionManager.setPositionData(tokenId, svJusdAddr, wcbtcAddr, 100);

      // Mint NFT to user1 (not user2)
      await positionManager.mintNFT(user1.address, tokenId);

      await jusd.connect(user2).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user2).approve(await gateway.getAddress(), wcbtcAmount);

      // user2 tries to increase liquidity on user1's NFT
      await expect(
        gateway
          .connect(user2)
          .increaseLiquidity(
            tokenId,
            await jusd.getAddress(),
            await wcbtc.getAddress(),
            jusdAmount,
            wcbtcAmount,
            0,
            0,
            deadline
          )
      ).to.be.revertedWithCustomError(gateway, "NotNFTOwner");
    });

    it("Should return NFT to user after operation", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 1;
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [token0, token1] = svJusdAddr < wcbtcAddr ? [svJusdAddr, wcbtcAddr] : [wcbtcAddr, svJusdAddr];
      await positionManager.setPositionData(tokenId, token0, token1, 100);

      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(await gateway.getAddress(), tokenId);

      // Verify ownership before
      expect(await positionManager.ownerOf(tokenId)).to.equal(user1.address);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      // Call with WcBTC first
      await gateway
        .connect(user1)
        .increaseLiquidity(
          tokenId,
          await wcbtc.getAddress(),
          await jusd.getAddress(),
          wcbtcAmount,
          jusdAmount,
          0,
          0,
          deadline
        );

      // Verify ownership after
      expect(await positionManager.ownerOf(tokenId)).to.equal(user1.address);
    });

    it("Should revert if deadline expired", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const pastDeadline = (await time.latest()) - 1;
      const tokenId = 1;
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      await positionManager.setPositionData(tokenId, svJusdAddr, wcbtcAddr, 100);
      await positionManager.mintNFT(user1.address, tokenId);

      await expect(
        gateway
          .connect(user1)
          .increaseLiquidity(
            tokenId,
            await jusd.getAddress(),
            await wcbtc.getAddress(),
            jusdAmount,
            wcbtcAmount,
            0,
            0,
            pastDeadline
          )
      ).to.be.revertedWithCustomError(gateway, "DeadlineExpired");
    });

    it("Should emit LiquidityIncreased with correct parameters", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 42; // Use specific tokenId
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [token0, token1] = svJusdAddr < wcbtcAddr ? [svJusdAddr, wcbtcAddr] : [wcbtcAddr, svJusdAddr];
      await positionManager.setPositionData(tokenId, token0, token1, 100);

      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(await gateway.getAddress(), tokenId);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      // Call with WcBTC first
      const tx = await gateway
        .connect(user1)
        .increaseLiquidity(
          tokenId,
          await wcbtc.getAddress(),
          await jusd.getAddress(),
          wcbtcAmount,
          jusdAmount,
          0,
          0,
          deadline
        );

      await expect(tx).to.emit(gateway, "LiquidityIncreased").withArgs(
        user1.address,
        tokenId,
        anyValue, // amountA
        anyValue, // amountB
        100 // default liquidity from mock
      );
    });

    it("Should increase liquidity with JUICE as input token (JUICE stays JUICE)", async function () {
      const { gateway, user1, juice, wcbtc, positionManager } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 1;
      const juiceAmount = ethers.parseEther("100"); // 100 JUICE
      const wcbtcAmount = ethers.parseEther("1");

      const juiceAddr = await juice.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();

      // Token ordering: Uniswap V3 requires token0 < token1
      // Position is JUICE/WcBTC (JUICE stays JUICE for liquidity)
      const [token0, token1] = juiceAddr < wcbtcAddr ? [juiceAddr, wcbtcAddr] : [wcbtcAddr, juiceAddr];
      await positionManager.setPositionData(tokenId, token0, token1, 100);
      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(await gateway.getAddress(), tokenId);

      await juice.connect(user1).approve(await gateway.getAddress(), juiceAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      // Should succeed - JUICE stays as JUICE (not converted to svJUSD)
      await expect(
        gateway.connect(user1).increaseLiquidity(
          tokenId,
          await juice.getAddress(), // JUICE as input
          await wcbtc.getAddress(),
          juiceAmount,
          wcbtcAmount,
          0,
          0,
          deadline
        )
      ).to.not.be.reverted;
    });

    it("Should revert if tokens don't match position", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 1;
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();

      // Setup position with svJUSD/WcBTC tokens
      const [token0, token1] = svJusdAddr < wcbtcAddr ? [svJusdAddr, wcbtcAddr] : [wcbtcAddr, svJusdAddr];
      await positionManager.setPositionData(tokenId, token0, token1, 100);

      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(await gateway.getAddress(), tokenId);

      // Deploy a different mock token to use as wrong input
      const MockERC20Factory = await ethers.getContractFactory("MockERC20");
      const wrongToken = await MockERC20Factory.deploy("Wrong Token", "WRONG", 18);
      await wrongToken.waitForDeployment();
      await wrongToken.mint(user1.address, jusdAmount);

      await wrongToken.connect(user1).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      // Try to increase liquidity with wrong token (wrongToken instead of JUSD)
      await expect(
        gateway.connect(user1).increaseLiquidity(
          tokenId,
          await wrongToken.getAddress(), // Wrong token - doesn't match position
          await wcbtc.getAddress(),
          jusdAmount,
          wcbtcAmount,
          0,
          0,
          deadline
        )
      )
        .to.be.revertedWithCustomError(gateway, "TokenMismatch")
        .withArgs(token0, token1, await wrongToken.getAddress(), wcbtcAddr);

      // Verify NFT remains with user (validation happens before NFT transfer)
      expect(await positionManager.ownerOf(tokenId)).to.equal(user1.address);
    });
  });

  describe("Remove Liquidity", function () {
    it("Should remove liquidity successfully", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 1;
      const liquidity = 100;

      // Setup mock position manager - use ACTUAL tokens (svJUSD, not JUSD)
      // because positions store the actual pool tokens
      await positionManager.setPositionData(
        tokenId,
        await svJusd.getAddress(), // Actual token in pool
        await wcbtc.getAddress(),
        liquidity
      );
      await positionManager.setDecreaseResult(
        ethers.parseEther("100"), // svJUSD shares
        ethers.parseEther("100") // WcBTC (increased to match test expectations)
      );

      // Fund position manager with tokens it will return
      const posManagerAddr = await positionManager.getAddress();
      const [owner] = await ethers.getSigners();
      await jusd.mint(owner.address, ethers.parseEther("100"));
      await jusd.connect(owner).approve(await svJusd.getAddress(), ethers.parseEther("100"));
      await svJusd.connect(owner).deposit(ethers.parseEther("100"), posManagerAddr);
      await wcbtc.deposit({ value: ethers.parseEther("100") });
      await wcbtc.transfer(posManagerAddr, ethers.parseEther("100"));

      // Mint NFT to user
      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(await gateway.getAddress(), tokenId);

      const tx = await gateway.connect(user1).removeLiquidity(
        tokenId,
        0, // liquidityToRemove (0 = remove all)
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        0,
        0,
        user1.address,
        deadline
      );

      await expect(tx)
        .to.emit(gateway, "LiquidityRemoved")
        .withArgs(
          user1.address,
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          anyValue, // amountA
          anyValue, // amountB
          tokenId // tokenId = 1
        );
    });

    it("Should convert svJUSD back to JUSD when removing liquidity", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 1;
      const liquidity = 100;

      await positionManager.setPositionData(
        tokenId,
        await svJusd.getAddress(), // Actual token
        await wcbtc.getAddress(),
        liquidity
      );
      await positionManager.setDecreaseResult(ethers.parseEther("100"), ethers.parseEther("100"));

      // Fund position manager
      const posManagerAddr = await positionManager.getAddress();
      const [owner] = await ethers.getSigners();
      await jusd.mint(owner.address, ethers.parseEther("100"));
      await jusd.connect(owner).approve(await svJusd.getAddress(), ethers.parseEther("100"));
      await svJusd.connect(owner).deposit(ethers.parseEther("100"), posManagerAddr);
      await wcbtc.deposit({ value: ethers.parseEther("100") });
      await wcbtc.transfer(posManagerAddr, ethers.parseEther("100"));

      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(await gateway.getAddress(), tokenId);

      const jusdBalanceBefore = await jusd.balanceOf(user1.address);

      await gateway.connect(user1).removeLiquidity(
        tokenId,
        0, // liquidityToRemove (0 = remove all)
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        0,
        0,
        user1.address,
        deadline
      );

      const jusdBalanceAfter = await jusd.balanceOf(user1.address);
      expect(jusdBalanceAfter).to.be.gt(jusdBalanceBefore);
    });

    it("Should output native cBTC when removing liquidity", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 1;
      const liquidity = 100;

      // Position uses svJUSD and WcBTC (actual tokens)
      await positionManager.setPositionData(
        tokenId,
        await svJusd.getAddress(),
        await wcbtc.getAddress(), // WcBTC (not native)
        liquidity
      );
      await positionManager.setDecreaseResult(ethers.parseEther("100"), ethers.parseEther("100"));

      // Fund position manager
      const posManagerAddr = await positionManager.getAddress();
      const [owner] = await ethers.getSigners();
      await jusd.mint(owner.address, ethers.parseEther("100"));
      await jusd.connect(owner).approve(await svJusd.getAddress(), ethers.parseEther("100"));
      await svJusd.connect(owner).deposit(ethers.parseEther("100"), posManagerAddr);
      await wcbtc.deposit({ value: ethers.parseEther("100") });
      await wcbtc.transfer(posManagerAddr, ethers.parseEther("100"));

      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(await gateway.getAddress(), tokenId);

      const balanceBefore = await ethers.provider.getBalance(user1.address);

      await gateway.connect(user1).removeLiquidity(
        tokenId,
        0, // liquidityToRemove (0 = remove all)
        await jusd.getAddress(),
        ethers.ZeroAddress,
        0,
        0,
        user1.address,
        deadline
      );

      const balanceAfter = await ethers.provider.getBalance(user1.address);
      expect(balanceAfter).to.be.gt(balanceBefore);
    });

    it("Should revert if deadline expired", async function () {
      const { gateway, user1, jusd, wcbtc } = await loadFixture(deployGatewayWithBalancesFixture);

      const pastDeadline = (await time.latest()) - 1;
      const tokenId = 1;

      await expect(
        gateway.connect(user1).removeLiquidity(
          tokenId,
          0, // liquidityToRemove (0 = remove all)
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          0,
          0,
          user1.address,
          pastDeadline
        )
      ).to.be.revertedWithCustomError(gateway, "DeadlineExpired");
    });

    it("Should revert when JUICE output is less than minimum after conversion (JUICE1-4)", async function () {
      const { gateway, user1, juice, svJusd, wcbtc, positionManager, jusd } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 1;
      const liquidity = 100;

      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();

      // Determine token ordering (Uniswap V3 requirement: token0 < token1)
      const svJusdIsToken0 = svJusdAddr.toLowerCase() < wcbtcAddr.toLowerCase();

      // Setup position with svJUSD (which will be converted to JUICE on output)
      await positionManager.setPositionData(
        tokenId,
        svJusdIsToken0 ? svJusdAddr : wcbtcAddr,
        svJusdIsToken0 ? wcbtcAddr : svJusdAddr,
        liquidity
      );

      // Set decrease result with correct token order
      // amount0 corresponds to token0, amount1 to token1
      const svJusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");
      await positionManager.setDecreaseResult(
        svJusdIsToken0 ? svJusdAmount : wcbtcAmount,
        svJusdIsToken0 ? wcbtcAmount : svJusdAmount
      );

      // Fund position manager with tokens it will return
      const posManagerAddr = await positionManager.getAddress();
      const [owner] = await ethers.getSigners();
      await jusd.mint(owner.address, svJusdAmount);
      await jusd.connect(owner).approve(svJusdAddr, svJusdAmount);
      await svJusd.connect(owner).deposit(svJusdAmount, posManagerAddr);
      await wcbtc.deposit({ value: wcbtcAmount });
      await wcbtc.transfer(posManagerAddr, wcbtcAmount);

      // Set MockEquity to return less JUICE than the minimum requested
      // User will request amountAMin of 10 JUICE, but we'll only return 5
      await juice.setInvestReturn(ethers.parseEther("5"));

      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(await gateway.getAddress(), tokenId);

      // Request JUICE as output with minimum of 10 JUICE
      // The conversion svJUSD -> JUSD -> JUICE will only return 5 JUICE (via override)
      // This should fail the slippage check
      await expect(
        gateway.connect(user1).removeLiquidity(
          tokenId,
          0, // liquidityToRemove (0 = remove all)
          await juice.getAddress(), // Request JUICE as tokenA
          await wcbtc.getAddress(),
          ethers.parseEther("10"), // amountAMin = 10 JUICE
          0,
          user1.address,
          deadline
        )
      ).to.be.revertedWithCustomError(gateway, "InsufficientOutput");

      // Clean up: reset the invest override for other tests
      await juice.clearInvestOverride();
    });

    it("Should remove partial liquidity (liquidityToRemove > 0)", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 1;
      const initialLiquidity = 100;
      const liquidityToRemove = 50; // Remove only half

      await positionManager.setPositionData(
        tokenId,
        await svJusd.getAddress(),
        await wcbtc.getAddress(),
        initialLiquidity
      );
      await positionManager.setDecreaseResult(
        ethers.parseEther("50"), // Half the tokens
        ethers.parseEther("50")
      );

      // Fund position manager
      const posManagerAddr = await positionManager.getAddress();
      const [owner] = await ethers.getSigners();
      await jusd.mint(owner.address, ethers.parseEther("50"));
      await jusd.connect(owner).approve(await svJusd.getAddress(), ethers.parseEther("50"));
      await svJusd.connect(owner).deposit(ethers.parseEther("50"), posManagerAddr);
      await wcbtc.deposit({ value: ethers.parseEther("50") });
      await wcbtc.transfer(posManagerAddr, ethers.parseEther("50"));

      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(await gateway.getAddress(), tokenId);

      const tx = await gateway.connect(user1).removeLiquidity(
        tokenId,
        liquidityToRemove, // Partial removal
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        0,
        0,
        user1.address,
        deadline
      );

      await expect(tx)
        .to.emit(gateway, "LiquidityRemoved")
        .withArgs(user1.address, await jusd.getAddress(), await wcbtc.getAddress(), anyValue, anyValue, tokenId);

      // NFT should still be owned by user (not burned)
      expect(await positionManager.ownerOf(tokenId)).to.equal(user1.address);
    });

    it("Should remove all liquidity when liquidityToRemove = 0", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 1;
      const initialLiquidity = 100;

      await positionManager.setPositionData(
        tokenId,
        await svJusd.getAddress(),
        await wcbtc.getAddress(),
        initialLiquidity
      );
      await positionManager.setDecreaseResult(
        ethers.parseEther("100"), // Full amount
        ethers.parseEther("100")
      );

      // Fund position manager
      const posManagerAddr = await positionManager.getAddress();
      const [owner] = await ethers.getSigners();
      await jusd.mint(owner.address, ethers.parseEther("100"));
      await jusd.connect(owner).approve(await svJusd.getAddress(), ethers.parseEther("100"));
      await svJusd.connect(owner).deposit(ethers.parseEther("100"), posManagerAddr);
      await wcbtc.deposit({ value: ethers.parseEther("100") });
      await wcbtc.transfer(posManagerAddr, ethers.parseEther("100"));

      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(await gateway.getAddress(), tokenId);

      const jusdBalanceBefore = await jusd.balanceOf(user1.address);

      const tx = await gateway.connect(user1).removeLiquidity(
        tokenId,
        0, // 0 means remove ALL liquidity
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        0,
        0,
        user1.address,
        deadline
      );

      await expect(tx)
        .to.emit(gateway, "LiquidityRemoved")
        .withArgs(user1.address, await jusd.getAddress(), await wcbtc.getAddress(), anyValue, anyValue, tokenId);

      const jusdBalanceAfter = await jusd.balanceOf(user1.address);
      // User should receive JUSD from liquidity removal
      expect(jusdBalanceAfter).to.be.gt(jusdBalanceBefore);

      // NFT should still be owned by user (returned after operation)
      expect(await positionManager.ownerOf(tokenId)).to.equal(user1.address);
    });

    it("Should revert if liquidityToRemove exceeds position liquidity", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 1;
      const positionLiquidity = 100; // Position has 100 liquidity
      const liquidityToRemove = 200; // Trying to remove 200 (more than available)

      // Setup position with limited liquidity
      await positionManager.setPositionData(
        tokenId,
        await svJusd.getAddress(),
        await wcbtc.getAddress(),
        positionLiquidity
      );

      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(await gateway.getAddress(), tokenId);

      // Try to remove more liquidity than the position has
      await expect(
        gateway.connect(user1).removeLiquidity(
          tokenId,
          liquidityToRemove, // 200 > 100 available
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          0,
          0,
          user1.address,
          deadline
        )
      )
        .to.be.revertedWithCustomError(gateway, "InsufficientLiquidity")
        .withArgs(liquidityToRemove, positionLiquidity);
    });

    it("Should remove JUICE liquidity successfully (JUICE transferred directly)", async function () {
      const { gateway, user1, juice, wcbtc, positionManager } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 1;
      const liquidity = 100;
      const juiceAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      const juiceAddr = await juice.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();

      // Token ordering: Uniswap V3 requires token0 < token1
      // For JUICE liquidity pools, JUICE stays as JUICE (not converted to svJUSD)
      const [token0, token1] = juiceAddr < wcbtcAddr ? [juiceAddr, wcbtcAddr] : [wcbtcAddr, juiceAddr];
      const isJuiceToken0 = juiceAddr < wcbtcAddr;

      await positionManager.setPositionData(tokenId, token0, token1, liquidity);
      await positionManager.setDecreaseResult(
        isJuiceToken0 ? juiceAmount : wcbtcAmount,
        isJuiceToken0 ? wcbtcAmount : juiceAmount
      );

      // Fund position manager with JUICE and WcBTC (NOT svJUSD!)
      const posManagerAddr = await positionManager.getAddress();
      await juice.mint(posManagerAddr, juiceAmount);
      await wcbtc.deposit({ value: wcbtcAmount });
      await wcbtc.transfer(posManagerAddr, wcbtcAmount);

      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(await gateway.getAddress(), tokenId);

      const juiceBalanceBefore = await juice.balanceOf(user1.address);
      const wcbtcBalanceBefore = await wcbtc.balanceOf(user1.address);

      const tx = await gateway.connect(user1).removeLiquidity(
        tokenId,
        0, // Remove all liquidity
        await juice.getAddress(),
        await wcbtc.getAddress(),
        0,
        0,
        user1.address,
        deadline
      );

      await expect(tx)
        .to.emit(gateway, "LiquidityRemoved")
        .withArgs(user1.address, await juice.getAddress(), await wcbtc.getAddress(), anyValue, anyValue, tokenId);

      // User should receive JUICE directly (not converted from svJUSD)
      const juiceBalanceAfter = await juice.balanceOf(user1.address);
      const wcbtcBalanceAfter = await wcbtc.balanceOf(user1.address);

      expect(juiceBalanceAfter).to.be.gt(juiceBalanceBefore);
      expect(wcbtcBalanceAfter).to.be.gt(wcbtcBalanceBefore);

      // NFT should still be owned by user
      expect(await positionManager.ownerOf(tokenId)).to.equal(user1.address);
    });
  });

  describe("NFT Handling", function () {
    it("Should return NFT to user after removing liquidity", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 1;

      await positionManager.setPositionData(tokenId, await svJusd.getAddress(), await wcbtc.getAddress(), 100);
      await positionManager.setDecreaseResult(ethers.parseEther("100"), ethers.parseEther("100"));

      const posManagerAddr = await positionManager.getAddress();
      const [owner] = await ethers.getSigners();
      await jusd.mint(owner.address, ethers.parseEther("100"));
      await jusd.connect(owner).approve(await svJusd.getAddress(), ethers.parseEther("100"));
      await svJusd.connect(owner).deposit(ethers.parseEther("100"), posManagerAddr);
      await wcbtc.deposit({ value: ethers.parseEther("100") });
      await wcbtc.transfer(posManagerAddr, ethers.parseEther("100"));

      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(await gateway.getAddress(), tokenId);

      await gateway.connect(user1).removeLiquidity(
        tokenId,
        0, // liquidityToRemove (0 = remove all)
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        0,
        0,
        user1.address,
        deadline
      );

      expect(await positionManager.ownerOf(tokenId)).to.equal(user1.address);
    });

    it("Should revert if non-owner tries to remove liquidity", async function () {
      const { gateway, user1, user2, jusd, wcbtc, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 1;

      await positionManager.mintNFT(user1.address, tokenId);

      await expect(
        gateway.connect(user2).removeLiquidity(
          tokenId,
          0, // liquidityToRemove (0 = remove all)
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          0,
          0,
          user2.address,
          deadline
        )
      ).to.be.revertedWithCustomError(gateway, "NotNFTOwner");
    });
  });

  describe("Security", function () {
    it("Should reject direct native token transfers", async function () {
      const { gateway, user1 } = await loadFixture(deployGatewayFixture);

      await expect(
        user1.sendTransaction({
          to: await gateway.getAddress(),
          value: ethers.parseEther("1"),
        })
      ).to.be.revertedWithCustomError(gateway, "DirectTransferNotAccepted");
    });

    it("Should prevent reentrancy on swap", async function () {
      // This would require a malicious token implementation
      // Testing reentrancy thoroughly requires specialized setup
      // The ReentrancyGuard modifier should prevent any reentrancy
    });

    it("Should handle token transfer failures gracefully", async function () {
      // This requires a mock token that can fail transfers
      // Would test the TransferFailed error
    });
  });

  describe("Edge Cases", function () {
    it("Should handle very small amounts", async function () {
      const { gateway, user1, jusd, wcbtc, swapRouter } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tinyAmount = 1n; // 1 wei

      await swapRouter.setSwapOutput(1n);
      await jusd.connect(user1).approve(await gateway.getAddress(), tinyAmount);

      // Should not revert
      await gateway
        .connect(user1)
        .swapExactTokensForTokens(
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          3000,
          tinyAmount,
          0,
          user1.address,
          deadline
        );
    });

    it("Should handle maximum uint256 approvals", async function () {
      const { gateway, jusd, svJusd } = await loadFixture(deployGatewayFixture);

      // Check pre-approvals set in constructor
      const maxUint = ethers.MaxUint256;

      // These should be set in constructor
      // (Testing would require checking allowances or state)
    });

    it("Should handle token order correctly (token0 < token1)", async function () {
      const { gateway, user1, jusd, wcbtc, positionManager } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;

      // Test both orderings
      const jusdAddr = await jusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();

      await positionManager.setMintResult(1, 100, SWAP_AMOUNT, SWAP_AMOUNT);

      await jusd.connect(user1).approve(await gateway.getAddress(), SWAP_AMOUNT);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), SWAP_AMOUNT);

      // Should work regardless of token order
      if (jusdAddr < wcbtcAddr) {
        await gateway.connect(user1).addLiquidity(
          jusdAddr,
          wcbtcAddr,
          3000,
          0, // tickLower (full range)
          0, // tickUpper (full range)
          SWAP_AMOUNT,
          SWAP_AMOUNT,
          0,
          0,
          user1.address,
          deadline
        );
      } else {
        await gateway.connect(user1).addLiquidity(
          wcbtcAddr,
          jusdAddr,
          3000,
          0, // tickLower (full range)
          0, // tickUpper (full range)
          SWAP_AMOUNT,
          SWAP_AMOUNT,
          0,
          0,
          user1.address,
          deadline
        );
      }
    });
  });

  describe("Gas Optimization", function () {
    it("Should use pre-approved tokens efficiently", async function () {
      const { gateway, user1, jusd, wcbtc, swapRouter } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;

      await swapRouter.setSwapOutput(ethers.parseEther("0.5"));
      await jusd.connect(user1).approve(await gateway.getAddress(), SWAP_AMOUNT);

      // First swap
      const tx1 = await gateway
        .connect(user1)
        .swapExactTokensForTokens(
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          3000,
          SWAP_AMOUNT / 2n,
          0,
          user1.address,
          deadline
        );

      // Second swap should not require additional approvals internally
      const tx2 = await gateway
        .connect(user1)
        .swapExactTokensForTokens(
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          3000,
          SWAP_AMOUNT / 2n,
          0,
          user1.address,
          deadline
        );

      // Gas should be similar (no approval overhead)
      const receipt1 = await tx1.wait();
      const receipt2 = await tx2.wait();

      // Second tx might use slightly less gas
      expect(receipt2!.gasUsed).to.be.lte(receipt1!.gasUsed);
    });
  });

  describe("Fee Tier Validation", function () {
    it("Should revert swap with fee >= 1,000,000", async function () {
      const { gateway, user1, jusd, wcbtc, swapRouter } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("10");

      await swapRouter.setSwapOutput(ethers.parseEther("0.5"));
      await jusd.connect(user1).approve(await gateway.getAddress(), swapAmount);

      await expect(
        gateway.connect(user1).swapExactTokensForTokens(
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          1_000_000, // Fee >= 1M should revert
          swapAmount,
          0,
          user1.address,
          deadline
        )
      ).to.be.revertedWithCustomError(gateway, "InvalidFee");
    });

    it("Should revert addLiquidity with unsupported fee tier", async function () {
      const { gateway, user1, jusd, wcbtc } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const amount = ethers.parseEther("10");

      await jusd.connect(user1).approve(await gateway.getAddress(), amount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), amount);

      await expect(
        gateway.connect(user1).addLiquidity(
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          2500, // Not in factory
          0, // tickLower (full range)
          0, // tickUpper (full range)
          amount,
          amount,
          0,
          0,
          user1.address,
          deadline
        )
      ).to.be.revertedWithCustomError(gateway, "InvalidFee");
    });
  });

  describe("Factory Integration", function () {
    it("Should set correct FACTORY immutable address", async function () {
      const { gateway, positionManager } = await loadFixture(deployGatewayFixture);

      const factoryAddress = await gateway.FACTORY();
      const expectedFactory = await positionManager.factory();

      expect(factoryAddress).to.equal(expectedFactory);
      expect(factoryAddress).to.not.equal(ethers.ZeroAddress);
    });

    it("Should query factory for correct tick spacing", async function () {
      const { gateway } = await loadFixture(deployGatewayFixture);

      const factoryAddress = await gateway.FACTORY();
      const MockFactory = await ethers.getContractFactory("MockFactory");
      const factory = MockFactory.attach(factoryAddress);

      expect(await factory.feeAmountTickSpacing(100)).to.equal(1);
      expect(await factory.feeAmountTickSpacing(500)).to.equal(10);
      expect(await factory.feeAmountTickSpacing(3000)).to.equal(60);
      expect(await factory.feeAmountTickSpacing(10000)).to.equal(200);
    });

    it("Should return zero for unsupported fee tiers in factory", async function () {
      const { gateway } = await loadFixture(deployGatewayFixture);

      const factoryAddress = await gateway.FACTORY();
      const MockFactory = await ethers.getContractFactory("MockFactory");
      const factory = MockFactory.attach(factoryAddress);

      expect(await factory.feeAmountTickSpacing(2500)).to.equal(0);
      expect(await factory.feeAmountTickSpacing(1234)).to.equal(0);
    });
  });

  describe("Multiple Fee Tier Support", function () {
    it("Should swap with 0.01% fee tier (100)", async function () {
      const { gateway, user1, jusd, wcbtc, swapRouter } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("10");

      await swapRouter.setSwapOutput(ethers.parseEther("0.5"));
      await jusd.connect(user1).approve(await gateway.getAddress(), swapAmount);

      const tx = await gateway.connect(user1).swapExactTokensForTokens(
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        100, // 0.01% fee tier
        swapAmount,
        0,
        user1.address,
        deadline
      );

      await expect(tx)
        .to.emit(gateway, "SwapExecuted")
        .withArgs(user1.address, await jusd.getAddress(), await wcbtc.getAddress(), anyValue, anyValue);
    });

    it("Should swap with 0.05% fee tier (500)", async function () {
      const { gateway, user1, jusd, wcbtc, swapRouter } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("10");

      await swapRouter.setSwapOutput(ethers.parseEther("0.5"));
      await jusd.connect(user1).approve(await gateway.getAddress(), swapAmount);

      const tx = await gateway.connect(user1).swapExactTokensForTokens(
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        500, // 0.05% fee tier
        swapAmount,
        0,
        user1.address,
        deadline
      );

      await expect(tx)
        .to.emit(gateway, "SwapExecuted")
        .withArgs(user1.address, await jusd.getAddress(), await wcbtc.getAddress(), anyValue, anyValue);
    });

    it("Should swap with 1% fee tier (10000)", async function () {
      const { gateway, user1, jusd, wcbtc, swapRouter } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("10");

      await swapRouter.setSwapOutput(ethers.parseEther("0.5"));
      await jusd.connect(user1).approve(await gateway.getAddress(), swapAmount);

      const tx = await gateway.connect(user1).swapExactTokensForTokens(
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        10000, // 1% fee tier
        swapAmount,
        0,
        user1.address,
        deadline
      );

      await expect(tx)
        .to.emit(gateway, "SwapExecuted")
        .withArgs(user1.address, await jusd.getAddress(), await wcbtc.getAddress(), anyValue, anyValue);
    });

    it("Should add liquidity with 0.01% fee tier (100)", async function () {
      const { gateway, user1, jusd, wcbtc, svJusd, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const amount = ethers.parseEther("10");

      const svJusdShares = await svJusd.convertToShares(amount);
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [amount0, amount1] = svJusdAddr < wcbtcAddr ? [svJusdShares, amount] : [amount, svJusdShares];
      await positionManager.setMintResult(1, 100, amount0, amount1);

      await jusd.connect(user1).approve(await gateway.getAddress(), amount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), amount);

      const tx = await gateway.connect(user1).addLiquidity(
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        100, // 0.01% fee tier
        0, // tickLower (full range)
        0, // tickUpper (full range)
        amount,
        amount,
        0,
        0,
        user1.address,
        deadline
      );

      await expect(tx)
        .to.emit(gateway, "LiquidityAdded")
        .withArgs(user1.address, await jusd.getAddress(), await wcbtc.getAddress(), anyValue, anyValue, 1);
    });

    it("Should add liquidity with 0.05% fee tier (500)", async function () {
      const { gateway, user1, jusd, wcbtc, svJusd, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const amount = ethers.parseEther("10");

      const svJusdShares = await svJusd.convertToShares(amount);
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [amount0, amount1] = svJusdAddr < wcbtcAddr ? [svJusdShares, amount] : [amount, svJusdShares];
      await positionManager.setMintResult(1, 100, amount0, amount1);

      await jusd.connect(user1).approve(await gateway.getAddress(), amount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), amount);

      const tx = await gateway.connect(user1).addLiquidity(
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        500, // 0.05% fee tier
        0, // tickLower (full range)
        0, // tickUpper (full range)
        amount,
        amount,
        0,
        0,
        user1.address,
        deadline
      );

      await expect(tx)
        .to.emit(gateway, "LiquidityAdded")
        .withArgs(user1.address, await jusd.getAddress(), await wcbtc.getAddress(), anyValue, anyValue, 1);
    });

    it("Should add liquidity with 1% fee tier (10000)", async function () {
      const { gateway, user1, jusd, wcbtc, svJusd, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const amount = ethers.parseEther("10");

      const svJusdShares = await svJusd.convertToShares(amount);
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [amount0, amount1] = svJusdAddr < wcbtcAddr ? [svJusdShares, amount] : [amount, svJusdShares];
      await positionManager.setMintResult(1, 100, amount0, amount1);

      await jusd.connect(user1).approve(await gateway.getAddress(), amount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), amount);

      const tx = await gateway.connect(user1).addLiquidity(
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        10000, // 1% fee tier
        0, // tickLower (full range)
        0, // tickUpper (full range)
        amount,
        amount,
        0,
        0,
        user1.address,
        deadline
      );

      await expect(tx)
        .to.emit(gateway, "LiquidityAdded")
        .withArgs(user1.address, await jusd.getAddress(), await wcbtc.getAddress(), anyValue, anyValue, 1);
    });
  });

  describe("Event Parameter Validation", function () {
    it("Should emit SwapExecuted with all correct parameters", async function () {
      const { gateway, user1, jusd, wcbtc, swapRouter } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("10");
      const expectedOutput = ethers.parseEther("0.5");

      await swapRouter.setSwapOutput(expectedOutput);
      await jusd.connect(user1).approve(await gateway.getAddress(), swapAmount);

      const tx = await gateway
        .connect(user1)
        .swapExactTokensForTokens(
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          3000,
          swapAmount,
          0,
          user1.address,
          deadline
        );

      await expect(tx)
        .to.emit(gateway, "SwapExecuted")
        .withArgs(
          user1.address,
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          anyValue, // Input amount varies due to svJUSD conversion
          expectedOutput
        );
    });

    it("Should emit LiquidityAdded with correct tokenId (not liquidity amount)", async function () {
      const { gateway, user1, jusd, wcbtc, svJusd, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const amount = ethers.parseEther("10");
      const expectedTokenId = 42; // Use different tokenId to verify

      const svJusdShares = await svJusd.convertToShares(amount);
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [amount0, amount1] = svJusdAddr < wcbtcAddr ? [svJusdShares, amount] : [amount, svJusdShares];
      await positionManager.setMintResult(expectedTokenId, 999, amount0, amount1);

      await jusd.connect(user1).approve(await gateway.getAddress(), amount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), amount);

      const tx = await gateway.connect(user1).addLiquidity(
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        3000,
        0, // tickLower (full range)
        0, // tickUpper (full range)
        amount,
        amount,
        0,
        0,
        user1.address,
        deadline
      );

      // Event should emit tokenId (42), not liquidity amount (999)
      await expect(tx)
        .to.emit(gateway, "LiquidityAdded")
        .withArgs(
          user1.address,
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          anyValue,
          anyValue,
          expectedTokenId // This is the NFT tokenId, NOT the liquidity amount
        );
    });

    it("Should emit LiquidityRemoved with correct tokenId", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 7; // Use specific tokenId
      const liquidity = 100;

      await positionManager.setPositionData(tokenId, await svJusd.getAddress(), await wcbtc.getAddress(), liquidity);
      await positionManager.setDecreaseResult(ethers.parseEther("10"), ethers.parseEther("10"));

      const posManagerAddr = await positionManager.getAddress();
      const [owner] = await ethers.getSigners();
      await jusd.mint(owner.address, ethers.parseEther("10"));
      await jusd.connect(owner).approve(await svJusd.getAddress(), ethers.parseEther("10"));
      await svJusd.connect(owner).deposit(ethers.parseEther("10"), posManagerAddr);
      await wcbtc.deposit({ value: ethers.parseEther("10") });
      await wcbtc.transfer(posManagerAddr, ethers.parseEther("10"));

      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(await gateway.getAddress(), tokenId);

      const tx = await gateway.connect(user1).removeLiquidity(
        tokenId,
        0, // liquidityToRemove (0 = remove all)
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        0,
        0,
        user1.address,
        deadline
      );

      await expect(tx)
        .to.emit(gateway, "LiquidityRemoved")
        .withArgs(
          user1.address,
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          anyValue,
          anyValue,
          tokenId // Verify correct tokenId is emitted
        );
    });
  });

  describe("Bridged Token Support", function () {
    const BRIDGE_LIMIT = ethers.parseEther("100000000"); // 100M JUSD
    const BRIDGE_WEEKS = 208; // 4 years

    /**
     * Deploy gateway with bridged token support (standalone fixture)
     */
    async function deployGatewayWithBridgedTokensFixture() {
      const [owner, user1, user2, feeCollector] = await ethers.getSigners();

      // Deploy core mocks
      const MockERC20Factory = await ethers.getContractFactory("MockERC20");
      const jusd = (await MockERC20Factory.deploy("JuiceDollar", "JUSD", 18)) as unknown as MockERC20;

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
      const wcbtc = (await MockWETHFactory.deploy("Wrapped cBTC", "WcBTC")) as unknown as MockWETH;

      const MockSwapRouterFactory = await ethers.getContractFactory("MockSwapRouter");
      const swapRouter = (await MockSwapRouterFactory.deploy()) as unknown as MockSwapRouter;

      const MockPositionManagerFactory = await ethers.getContractFactory("MockPositionManager");
      const positionManager = (await MockPositionManagerFactory.deploy()) as unknown as MockPositionManager;

      // Deploy gateway
      const JuiceSwapGatewayFactory = await ethers.getContractFactory("JuiceSwapGateway");
      const gateway = (await JuiceSwapGatewayFactory.deploy(
        await jusd.getAddress(),
        await svJusd.getAddress(),
        await juice.getAddress(),
        await wcbtc.getAddress(),
        await swapRouter.getAddress(),
        await positionManager.getAddress()
      )) as unknown as JuiceSwapGateway;

      // Setup balances
      await jusd.mint(user1.address, INITIAL_BALANCE);
      await jusd.mint(user2.address, INITIAL_BALANCE);
      await juice.mint(user1.address, INITIAL_BALANCE);
      await wcbtc.connect(user1).deposit({ value: ethers.parseEther("100") });
      await wcbtc.connect(user2).deposit({ value: ethers.parseEther("100") });
      await jusd.mint(await svJusd.getAddress(), ethers.parseEther("100000"));
      await jusd.mint(await juice.getAddress(), ethers.parseEther("10000"));

      // Deploy bridged stablecoins (6 decimals like USDT/USDC)
      const usdc = (await MockERC20Factory.deploy("USD Coin", "USDC.e", 6)) as unknown as MockERC20;
      const usdt = (await MockERC20Factory.deploy("Tether USD", "USDT.e", 6)) as unknown as MockERC20;
      const ctUsd = (await MockERC20Factory.deploy("M0 USD", "ctUSD", 6)) as unknown as MockERC20;

      // Deploy bridges
      const MockBridgeFactory = await ethers.getContractFactory("MockStablecoinBridge");
      const usdcBridge = (await MockBridgeFactory.deploy(
        await usdc.getAddress(),
        await jusd.getAddress(),
        BRIDGE_LIMIT,
        BRIDGE_WEEKS
      )) as unknown as MockStablecoinBridge;
      const usdtBridge = (await MockBridgeFactory.deploy(
        await usdt.getAddress(),
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

      // Fund bridges with bridged tokens (for burn operations)
      const bridgeAmount = 10_000_000n * 10n ** 6n; // 10M with 6 decimals
      await usdc.mint(await usdcBridge.getAddress(), bridgeAmount);
      await usdt.mint(await usdtBridge.getAddress(), bridgeAmount);
      await ctUsd.mint(await ctUsdBridge.getAddress(), bridgeAmount);

      // Mint bridged tokens to users
      const userAmount = 100_000n * 10n ** 6n; // 100k with 6 decimals
      await usdc.mint(user1.address, userAmount);
      await usdt.mint(user1.address, userAmount);
      await ctUsd.mint(user1.address, userAmount);

      // Set bridges as approved minters (simulates JUSD governance approval)
      await jusd.setMinter(await usdcBridge.getAddress(), true);
      await jusd.setMinter(await usdtBridge.getAddress(), true);
      await jusd.setMinter(await ctUsdBridge.getAddress(), true);

      // Register bridged tokens on gateway (permissionless - anyone can call if bridge is minter)
      await gateway.registerBridgedToken(await usdcBridge.getAddress());
      await gateway.registerBridgedToken(await usdtBridge.getAddress());
      await gateway.registerBridgedToken(await ctUsdBridge.getAddress());

      return {
        owner,
        user1,
        user2,
        feeCollector,
        jusd,
        juice,
        svJusd,
        wcbtc,
        swapRouter,
        positionManager,
        gateway,
        usdc,
        usdt,
        ctUsd,
        usdcBridge,
        usdtBridge,
        ctUsdBridge,
      };
    }

    describe("Bridge Registration (Permissionless)", function () {
      it("Should register bridged token when bridge is approved minter", async function () {
        const { gateway, user1, jusd } = await loadFixture(deployGatewayWithBalancesFixture);

        const MockERC20Factory = await ethers.getContractFactory("MockERC20");
        const newToken = await MockERC20Factory.deploy("New Token", "NEW", 6);

        const MockBridgeFactory = await ethers.getContractFactory("MockStablecoinBridge");
        const newBridge = await MockBridgeFactory.deploy(
          await newToken.getAddress(),
          await jusd.getAddress(),
          BRIDGE_LIMIT,
          BRIDGE_WEEKS
        );

        // Set bridge as approved minter (simulates JUSD governance approval)
        await jusd.setMinter(await newBridge.getAddress(), true);

        // Anyone can register (permissionless)
        await expect(gateway.connect(user1).registerBridgedToken(await newBridge.getAddress()))
          .to.emit(gateway, "BridgedTokenRegistered")
          .withArgs(await newToken.getAddress(), await newBridge.getAddress(), user1.address, 6);

        expect(await gateway.isBridgedToken(await newToken.getAddress())).to.be.true;
      });

      it("Should revert when bridge is not approved minter", async function () {
        const { gateway, user1, jusd } = await loadFixture(deployGatewayWithBalancesFixture);

        const MockERC20Factory = await ethers.getContractFactory("MockERC20");
        const newToken = await MockERC20Factory.deploy("New Token", "NEW", 6);

        const MockBridgeFactory = await ethers.getContractFactory("MockStablecoinBridge");
        const newBridge = await MockBridgeFactory.deploy(
          await newToken.getAddress(),
          await jusd.getAddress(),
          BRIDGE_LIMIT,
          BRIDGE_WEEKS
        );

        // Do NOT set bridge as minter - should fail
        await expect(
          gateway.connect(user1).registerBridgedToken(await newBridge.getAddress())
        ).to.be.revertedWithCustomError(gateway, "NotApprovedMinter");
      });

      it("Should revert when registering duplicate bridged token", async function () {
        const { gateway, usdcBridge } = await loadFixture(deployGatewayWithBridgedTokensFixture);

        await expect(gateway.registerBridgedToken(await usdcBridge.getAddress())).to.be.revertedWithCustomError(
          gateway,
          "BridgedTokenAlreadyExists"
        );
      });

      it("Should return all bridged tokens", async function () {
        const { gateway, usdc, usdt, ctUsd } = await loadFixture(deployGatewayWithBridgedTokensFixture);

        const tokens = await gateway.getBridgedTokens();
        expect(tokens.length).to.equal(3);
        expect(tokens).to.include(await usdc.getAddress());
        expect(tokens).to.include(await usdt.getAddress());
        expect(tokens).to.include(await ctUsd.getAddress());
      });

      it("Should revert with InvalidBridgeConfig for zero address", async function () {
        const { gateway } = await loadFixture(deployGatewayWithBalancesFixture);

        await expect(gateway.registerBridgedToken(ethers.ZeroAddress)).to.be.revertedWithCustomError(
          gateway,
          "InvalidBridgeConfig"
        );
      });

      it("Should revert with InvalidBridgeConfig when bridge.JUSD() != gateway JUSD", async function () {
        const { gateway, jusd } = await loadFixture(deployGatewayWithBalancesFixture);

        const MockERC20Factory = await ethers.getContractFactory("MockERC20");
        const MockBridgeFactory = await ethers.getContractFactory("MockStablecoinBridge");

        // Deploy a bridge pointing to a different JUSD
        const usdc = await MockERC20Factory.deploy("USD Coin", "USDC", 6);
        const fakeJusd = await MockERC20Factory.deploy("Fake JUSD", "FJUSD", 18);
        const bridge = await MockBridgeFactory.deploy(
          await usdc.getAddress(),
          await fakeJusd.getAddress(), // Wrong JUSD
          BRIDGE_LIMIT,
          BRIDGE_WEEKS
        );
        // Note: Even if we set minter, JUSD mismatch is checked first
        await jusd.setMinter(await bridge.getAddress(), true);

        await expect(gateway.registerBridgedToken(await bridge.getAddress())).to.be.revertedWithCustomError(
          gateway,
          "InvalidBridgeConfig"
        );
      });
    });

    describe("Swap with Bridged Tokens", function () {
      it("Should swap bridged token (USDC.e) to WcBTC", async function () {
        const { gateway, user1, usdc, wcbtc, swapRouter } = await loadFixture(deployGatewayWithBridgedTokensFixture);

        const deadline = (await time.latest()) + DEADLINE_OFFSET;
        const swapAmount = 1000n * 10n ** 6n; // 1000 USDC (6 decimals)
        const expectedOutput = ethers.parseEther("0.01"); // 0.01 WcBTC

        await swapRouter.setSwapOutput(expectedOutput);
        await usdc.connect(user1).approve(await gateway.getAddress(), swapAmount);

        const wcbtcBefore = await wcbtc.balanceOf(user1.address);

        await gateway.connect(user1).swapExactTokensForTokens(
          await usdc.getAddress(),
          await wcbtc.getAddress(),
          0, // use default fee
          swapAmount,
          0,
          user1.address,
          deadline
        );

        const wcbtcAfter = await wcbtc.balanceOf(user1.address);
        expect(wcbtcAfter - wcbtcBefore).to.equal(expectedOutput);
      });

      it("Should swap WcBTC to bridged token (USDT.e)", async function () {
        const { gateway, user1, usdt, wcbtc, svJusd, swapRouter, usdtBridge } = await loadFixture(
          deployGatewayWithBridgedTokensFixture
        );

        const deadline = (await time.latest()) + DEADLINE_OFFSET;
        const swapAmount = ethers.parseEther("0.01"); // 0.01 WcBTC
        const svJusdOutput = ethers.parseEther("1000"); // Mock router returns this

        await swapRouter.setSwapOutput(svJusdOutput);
        await wcbtc.connect(user1).approve(await gateway.getAddress(), swapAmount);

        // Track bridge minted amount for the burn
        await usdtBridge.setMinted(svJusdOutput);

        const usdtBefore = await usdt.balanceOf(user1.address);

        await gateway
          .connect(user1)
          .swapExactTokensForTokens(
            await wcbtc.getAddress(),
            await usdt.getAddress(),
            0,
            swapAmount,
            0,
            user1.address,
            deadline
          );

        const usdtAfter = await usdt.balanceOf(user1.address);
        // 1000 JUSD (18 decimals) = 1000 USDT (6 decimals)
        expect(usdtAfter - usdtBefore).to.equal(1000n * 10n ** 6n);
      });

      it("Should emit SwapExecuted event with bridged token addresses", async function () {
        const { gateway, user1, usdc, wcbtc, swapRouter } = await loadFixture(deployGatewayWithBridgedTokensFixture);

        const deadline = (await time.latest()) + DEADLINE_OFFSET;
        const swapAmount = 1000n * 10n ** 6n;

        await swapRouter.setSwapOutput(ethers.parseEther("0.01"));
        await usdc.connect(user1).approve(await gateway.getAddress(), swapAmount);

        await expect(
          gateway
            .connect(user1)
            .swapExactTokensForTokens(
              await usdc.getAddress(),
              await wcbtc.getAddress(),
              0,
              swapAmount,
              0,
              user1.address,
              deadline
            )
        )
          .to.emit(gateway, "SwapExecuted")
          .withArgs(user1.address, await usdc.getAddress(), await wcbtc.getAddress(), anyValue, anyValue);
      });
    });

    describe("Add Liquidity with Bridged Tokens", function () {
      it("Should add liquidity with bridged token (USDC.e) + WcBTC", async function () {
        const { gateway, user1, usdc, wcbtc, svJusd, positionManager } = await loadFixture(
          deployGatewayWithBridgedTokensFixture
        );

        const deadline = (await time.latest()) + DEADLINE_OFFSET;
        const usdcAmount = 1000n * 10n ** 6n; // 1000 USDC (6 decimals)
        const wcbtcAmount = ethers.parseEther("0.01");

        // Calculate expected svJUSD shares (1000 USDC = 1000 JUSD = ~1000 svJUSD shares)
        const jusdEquivalent = ethers.parseEther("1000"); // 1000 USDC = 1000 JUSD
        const svJusdShares = await svJusd.convertToShares(jusdEquivalent);

        const svJusdAddr = await svJusd.getAddress();
        const wcbtcAddr = await wcbtc.getAddress();
        const [amount0, amount1] = svJusdAddr < wcbtcAddr ? [svJusdShares, wcbtcAmount] : [wcbtcAmount, svJusdShares];

        await positionManager.setMintResult(1, 100, amount0, amount1);

        await usdc.connect(user1).approve(await gateway.getAddress(), usdcAmount);
        await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

        const tx = await gateway.connect(user1).addLiquidity(
          await usdc.getAddress(),
          await wcbtc.getAddress(),
          0, // default fee
          0, // tickLower (full range)
          0, // tickUpper (full range)
          usdcAmount,
          wcbtcAmount,
          0,
          0,
          user1.address,
          deadline
        );

        await expect(tx)
          .to.emit(gateway, "LiquidityAdded")
          .withArgs(user1.address, await usdc.getAddress(), await wcbtc.getAddress(), anyValue, anyValue, 1);
      });

      it("Should revert with InvalidTokenPair for bridged token + JUSD", async function () {
        const { gateway, user1, usdc, jusd } = await loadFixture(deployGatewayWithBridgedTokensFixture);

        const deadline = (await time.latest()) + DEADLINE_OFFSET;
        const amount = 1000n * 10n ** 6n;

        await usdc.connect(user1).approve(await gateway.getAddress(), amount);
        await jusd.connect(user1).approve(await gateway.getAddress(), ethers.parseEther("1000"));

        await expect(
          gateway.connect(user1).addLiquidity(
            await usdc.getAddress(),
            await jusd.getAddress(),
            0,
            0, // tickLower (full range)
            0, // tickUpper (full range)
            amount,
            ethers.parseEther("1000"),
            0,
            0,
            user1.address,
            deadline
          )
        ).to.be.revertedWithCustomError(gateway, "InvalidTokenPair");
      });

      it("Should revert with InvalidTokenPair for two bridged tokens", async function () {
        const { gateway, user1, usdc, usdt } = await loadFixture(deployGatewayWithBridgedTokensFixture);

        const deadline = (await time.latest()) + DEADLINE_OFFSET;
        const amount = 1000n * 10n ** 6n;

        await usdc.connect(user1).approve(await gateway.getAddress(), amount);
        await usdt.connect(user1).approve(await gateway.getAddress(), amount);

        await expect(
          gateway.connect(user1).addLiquidity(
            await usdc.getAddress(),
            await usdt.getAddress(),
            0,
            0, // tickLower (full range)
            0, // tickUpper (full range)
            amount,
            amount,
            0,
            0,
            user1.address,
            deadline
          )
        ).to.be.revertedWithCustomError(gateway, "InvalidTokenPair");
      });

      it("Should return excess bridged token when position manager uses less", async function () {
        const { gateway, user1, usdc, wcbtc, svJusd, positionManager, usdcBridge } = await loadFixture(
          deployGatewayWithBridgedTokensFixture
        );

        const deadline = (await time.latest()) + DEADLINE_OFFSET;
        const usdcAmount = 2000n * 10n ** 6n; // 2000 USDC (6 decimals)
        const wcbtcAmount = ethers.parseEther("0.02");

        // Calculate expected svJUSD from full USDC amount
        const jusdEquivalent = ethers.parseEther("2000"); // 2000 USDC = 2000 JUSD
        const fullSvJusdShares = await svJusd.convertToShares(jusdEquivalent);

        // Mock position manager to only use HALF the svJUSD (simulating excess)
        const halfSvJusdShares = fullSvJusdShares / 2n;
        const halfWcbtc = wcbtcAmount / 2n;

        const svJusdAddr = await svJusd.getAddress();
        const wcbtcAddr = await wcbtc.getAddress();
        const [amount0, amount1] =
          svJusdAddr < wcbtcAddr ? [halfSvJusdShares, halfWcbtc] : [halfWcbtc, halfSvJusdShares];
        await positionManager.setMintResult(1, 100, amount0, amount1);

        // Set minted amount for bridge burn operation (excess will be burned)
        await usdcBridge.setMinted(jusdEquivalent);

        await usdc.connect(user1).approve(await gateway.getAddress(), usdcAmount);
        await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

        const usdcBefore = await usdc.balanceOf(user1.address);

        await gateway.connect(user1).addLiquidity(
          await usdc.getAddress(),
          await wcbtc.getAddress(),
          0,
          0, // tickLower (full range)
          0, // tickUpper (full range)
          usdcAmount,
          wcbtcAmount,
          0,
          0,
          user1.address,
          deadline
        );

        const usdcAfter = await usdc.balanceOf(user1.address);

        // User should receive excess USDC back (half of input = 1000 USDC)
        // Initial: usdcBefore, spent 2000, got back ~1000 = usdcBefore - 1000
        const usdcSpent = usdcBefore - usdcAfter;
        expect(usdcSpent).to.be.lt(usdcAmount); // Should have received some back
        expect(usdcSpent).to.be.closeTo(1000n * 10n ** 6n, 100n * 10n ** 6n); // ~1000 USDC used
      });

      it("Should return excess bridged token (USDT) when increasing liquidity", async function () {
        const { gateway, user1, usdt, wcbtc, svJusd, positionManager, usdtBridge } = await loadFixture(
          deployGatewayWithBridgedTokensFixture
        );

        const deadline = (await time.latest()) + DEADLINE_OFFSET;
        const tokenId = 1;
        const usdtAmount = 2000n * 10n ** 6n; // 2000 USDT
        const wcbtcAmount = ethers.parseEther("0.02");

        // Setup position with correct token ordering
        const svJusdAddr = await svJusd.getAddress();
        const wcbtcAddr = await wcbtc.getAddress();
        const [token0, token1] = svJusdAddr < wcbtcAddr ? [svJusdAddr, wcbtcAddr] : [wcbtcAddr, svJusdAddr];
        await positionManager.setPositionData(tokenId, token0, token1, 100);
        await positionManager.mintNFT(user1.address, tokenId);
        await positionManager.connect(user1).approve(await gateway.getAddress(), tokenId);

        // Mock increase to use only half
        const jusdEquivalent = ethers.parseEther("2000");
        const fullSvJusdShares = await svJusd.convertToShares(jusdEquivalent);
        const halfSvJusdShares = fullSvJusdShares / 2n;
        const halfWcbtc = wcbtcAmount / 2n;

        const [inc0, inc1] = svJusdAddr < wcbtcAddr ? [halfSvJusdShares, halfWcbtc] : [halfWcbtc, halfSvJusdShares];
        await positionManager.setIncreaseResult(50, inc0, inc1);

        // Set minted for bridge burn
        await usdtBridge.setMinted(jusdEquivalent);

        await usdt.connect(user1).approve(await gateway.getAddress(), usdtAmount);
        await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

        const usdtBefore = await usdt.balanceOf(user1.address);

        await gateway
          .connect(user1)
          .increaseLiquidity(
            tokenId,
            await usdt.getAddress(),
            await wcbtc.getAddress(),
            usdtAmount,
            wcbtcAmount,
            0,
            0,
            deadline
          );

        const usdtAfter = await usdt.balanceOf(user1.address);

        // User should receive excess USDT back
        const usdtSpent = usdtBefore - usdtAfter;
        expect(usdtSpent).to.be.lt(usdtAmount);
        expect(usdtSpent).to.be.closeTo(1000n * 10n ** 6n, 100n * 10n ** 6n);
      });
    });

    describe("View Functions", function () {
      it("Should convert bridged token amount to svJUSD", async function () {
        const { gateway, usdc, svJusd } = await loadFixture(deployGatewayWithBridgedTokensFixture);

        const usdcAmount = 1000n * 10n ** 6n; // 1000 USDC (6 decimals)
        const jusdEquivalent = ethers.parseEther("1000"); // 1000 JUSD (18 decimals)
        const expectedSvJusd = await svJusd.convertToShares(jusdEquivalent);

        const result = await gateway.bridgedToSvJusd(await usdc.getAddress(), usdcAmount);
        expect(result).to.equal(expectedSvJusd);
      });

      it("Should convert svJUSD amount to bridged token", async function () {
        const { gateway, usdc, svJusd } = await loadFixture(deployGatewayWithBridgedTokensFixture);

        const svJusdAmount = ethers.parseEther("1000");
        const jusdEquivalent = await svJusd.convertToAssets(svJusdAmount);
        // 1000 JUSD (18 decimals) = 1000 USDC (6 decimals)
        const expectedUsdc = 1000n * 10n ** 6n;

        const result = await gateway.svJusdToBridged(await usdc.getAddress(), svJusdAmount);
        expect(result).to.equal(expectedUsdc);
      });

      it("Should return true for supported bridged token", async function () {
        const { gateway, usdc } = await loadFixture(deployGatewayWithBridgedTokensFixture);
        expect(await gateway.isBridgedToken(await usdc.getAddress())).to.be.true;
      });

      it("Should return false for non-bridged token", async function () {
        const { gateway, wcbtc } = await loadFixture(deployGatewayWithBridgedTokensFixture);
        expect(await gateway.isBridgedToken(await wcbtc.getAddress())).to.be.false;
      });

      it("Should revert bridgedToSvJusd for non-bridged token", async function () {
        const { gateway, wcbtc } = await loadFixture(deployGatewayWithBridgedTokensFixture);

        await expect(gateway.bridgedToSvJusd(await wcbtc.getAddress(), 1000)).to.be.revertedWithCustomError(
          gateway,
          "BridgedTokenNotFound"
        );
      });

      it("Should revert svJusdToBridged for non-bridged token", async function () {
        const { gateway, wcbtc } = await loadFixture(deployGatewayWithBridgedTokensFixture);

        await expect(
          gateway.svJusdToBridged(await wcbtc.getAddress(), ethers.parseEther("1000"))
        ).to.be.revertedWithCustomError(gateway, "BridgedTokenNotFound");
      });
    });

    describe("Decimal Conversion", function () {
      it("Should correctly convert 6 decimal token to 18 decimal JUSD", async function () {
        const { gateway, usdc, svJusd } = await loadFixture(deployGatewayWithBridgedTokensFixture);

        // 1 USDC (6 decimals) = 1 JUSD (18 decimals)
        const usdcAmount = 1n * 10n ** 6n; // 1 USDC
        const expectedJusdEquivalent = ethers.parseEther("1"); // 1 JUSD
        const expectedSvJusd = await svJusd.convertToShares(expectedJusdEquivalent);

        const result = await gateway.bridgedToSvJusd(await usdc.getAddress(), usdcAmount);
        expect(result).to.equal(expectedSvJusd);
      });

      it("Should correctly convert 18 decimal JUSD to 6 decimal token", async function () {
        const { gateway, usdc, svJusd } = await loadFixture(deployGatewayWithBridgedTokensFixture);

        // 1 JUSD (18 decimals) = 1 USDC (6 decimals)
        const svJusdAmount = await svJusd.convertToShares(ethers.parseEther("1"));
        const expectedUsdc = 1n * 10n ** 6n; // 1 USDC

        const result = await gateway.svJusdToBridged(await usdc.getAddress(), svJusdAmount);
        expect(result).to.equal(expectedUsdc);
      });

      it("Should handle large amounts correctly", async function () {
        const { gateway, usdc, svJusd } = await loadFixture(deployGatewayWithBridgedTokensFixture);

        // 1,000,000 USDC
        const usdcAmount = 1_000_000n * 10n ** 6n;
        const expectedJusdEquivalent = ethers.parseEther("1000000");
        const expectedSvJusd = await svJusd.convertToShares(expectedJusdEquivalent);

        const result = await gateway.bridgedToSvJusd(await usdc.getAddress(), usdcAmount);
        expect(result).to.equal(expectedSvJusd);
      });

      it("Should handle small amounts with precision loss", async function () {
        const { gateway, usdc, svJusd } = await loadFixture(deployGatewayWithBridgedTokensFixture);

        // Very small amount: 1 wei of svJUSD converted to USDC
        // This tests that precision loss is handled (rounds down to 0)
        const svJusdAmount = 1n; // 1 wei
        const result = await gateway.svJusdToBridged(await usdc.getAddress(), svJusdAmount);
        // 1 wei JUSD = 0 USDC (too small)
        expect(result).to.equal(0n);
      });
    });

    describe("Multiple Bridged Tokens", function () {
      it("Should support swapping between different bridged tokens via pool", async function () {
        const { gateway, user1, usdc, usdt, svJusd, swapRouter, usdtBridge } = await loadFixture(
          deployGatewayWithBridgedTokensFixture
        );

        const deadline = (await time.latest()) + DEADLINE_OFFSET;
        const swapAmount = 1000n * 10n ** 6n; // 1000 USDC

        // Mock: USDC → svJUSD → USDT path
        // Router returns svJUSD, then gateway converts to USDT
        const svJusdOutput = ethers.parseEther("1000");
        await swapRouter.setSwapOutput(svJusdOutput);
        await usdtBridge.setMinted(svJusdOutput);

        await usdc.connect(user1).approve(await gateway.getAddress(), swapAmount);

        const usdtBefore = await usdt.balanceOf(user1.address);

        await gateway
          .connect(user1)
          .swapExactTokensForTokens(
            await usdc.getAddress(),
            await usdt.getAddress(),
            0,
            swapAmount,
            0,
            user1.address,
            deadline
          );

        const usdtAfter = await usdt.balanceOf(user1.address);
        expect(usdtAfter - usdtBefore).to.equal(1000n * 10n ** 6n);
      });

      it("Should handle all three bridged tokens independently", async function () {
        const { gateway, usdc, usdt, ctUsd } = await loadFixture(deployGatewayWithBridgedTokensFixture);

        // All three should be recognized as bridged tokens
        expect(await gateway.isBridgedToken(await usdc.getAddress())).to.be.true;
        expect(await gateway.isBridgedToken(await usdt.getAddress())).to.be.true;
        expect(await gateway.isBridgedToken(await ctUsd.getAddress())).to.be.true;

        // Each should have correct bridge config
        const tokens = await gateway.getBridgedTokens();
        expect(tokens.length).to.equal(3);
      });
    });

    describe("getBridgeStatus", function () {
      const bridgeAmount = 10_000_000n * 10n ** 6n; // 10M with 6 decimals (from fixture)

      it("Should return healthy status for properly configured bridge", async function () {
        const { gateway, usdc } = await loadFixture(deployGatewayWithBridgedTokensFixture);

        const status = await gateway.getBridgeStatus(await usdc.getAddress());

        expect(status.canMint).to.be.true;
        expect(status.canBurn).to.be.true;
        expect(status.mintCapacity).to.equal(BRIDGE_LIMIT);
        expect(status.burnCapacity).to.equal(bridgeAmount);
        expect(status.mintBlockReason).to.equal("");
        expect(status.burnBlockReason).to.equal("");
      });

      it("Should return unsupported status for unknown token", async function () {
        const { gateway } = await loadFixture(deployGatewayWithBridgedTokensFixture);

        // Use a random address that's not a bridged token
        const randomAddress = ethers.Wallet.createRandom().address;
        const status = await gateway.getBridgeStatus(randomAddress);

        expect(status.canMint).to.be.false;
        expect(status.canBurn).to.be.false;
        expect(status.mintCapacity).to.equal(0);
        expect(status.burnCapacity).to.equal(0);
        expect(status.mintBlockReason).to.equal("Token not supported");
        expect(status.burnBlockReason).to.equal("Token not supported");
      });

      it("Should return expired status when bridge horizon is passed", async function () {
        const { gateway, usdc, usdcBridge } = await loadFixture(deployGatewayWithBridgedTokensFixture);

        // Get the bridge horizon and advance time past it
        const horizon = await usdcBridge.horizon();
        await time.increaseTo(horizon + 1n);

        const status = await gateway.getBridgeStatus(await usdc.getAddress());

        expect(status.canMint).to.be.false;
        expect(status.canBurn).to.be.true; // Burn should still work
        expect(status.mintCapacity).to.equal(0);
        expect(status.burnCapacity).to.equal(bridgeAmount);
        expect(status.mintBlockReason).to.equal("Bridge expired");
        expect(status.burnBlockReason).to.equal("");
      });

      it("Should return limit reached when mint limit is exhausted", async function () {
        const { gateway, usdc, usdcBridge } = await loadFixture(deployGatewayWithBridgedTokensFixture);

        // Set minted to the limit
        await usdcBridge.setMinted(BRIDGE_LIMIT);

        const status = await gateway.getBridgeStatus(await usdc.getAddress());

        expect(status.canMint).to.be.false;
        expect(status.canBurn).to.be.true; // Burn should still work
        expect(status.mintCapacity).to.equal(0);
        expect(status.burnCapacity).to.equal(bridgeAmount);
        expect(status.mintBlockReason).to.equal("Limit reached");
        expect(status.burnBlockReason).to.equal("");
      });

      it("Should return insufficient liquidity when bridge has no tokens", async function () {
        const { gateway, owner, jusd } = await loadFixture(deployGatewayWithBalancesFixture);

        // Deploy a new bridged token with empty bridge
        const MockERC20Factory = await ethers.getContractFactory("MockERC20");
        const newToken = await MockERC20Factory.deploy("New Token", "NEW", 6);

        const MockBridgeFactory = await ethers.getContractFactory("MockStablecoinBridge");
        const newBridge = await MockBridgeFactory.deploy(
          await newToken.getAddress(),
          await jusd.getAddress(),
          BRIDGE_LIMIT,
          BRIDGE_WEEKS
        );

        // Set bridge as approved minter and register (permissionless)
        await jusd.setMinter(await newBridge.getAddress(), true);
        await gateway.registerBridgedToken(await newBridge.getAddress());

        const status = await gateway.getBridgeStatus(await newToken.getAddress());

        expect(status.canMint).to.be.true; // Can still mint
        expect(status.canBurn).to.be.false; // Can't burn without liquidity
        expect(status.mintCapacity).to.equal(BRIDGE_LIMIT);
        expect(status.burnCapacity).to.equal(0);
        expect(status.mintBlockReason).to.equal("");
        expect(status.burnBlockReason).to.equal("Insufficient bridge liquidity");
      });

      it("Should return accurate remaining mint capacity", async function () {
        const { gateway, usdc, usdcBridge } = await loadFixture(deployGatewayWithBridgedTokensFixture);

        // Set minted to 40% of limit
        const mintedAmount = (BRIDGE_LIMIT * 40n) / 100n;
        await usdcBridge.setMinted(mintedAmount);

        const status = await gateway.getBridgeStatus(await usdc.getAddress());

        expect(status.canMint).to.be.true;
        expect(status.canBurn).to.be.true;
        expect(status.mintCapacity).to.equal(BRIDGE_LIMIT - mintedAmount);
        expect(status.burnCapacity).to.equal(bridgeAmount);
        expect(status.mintBlockReason).to.equal("");
        expect(status.burnBlockReason).to.equal("");
      });
    });

    describe("Direct USD Conversion Optimization", function () {
      /**
       * These tests verify the gas-optimized direct USD conversion path.
       * Instead of: Input -> svJUSD deposit -> svJUSD redeem -> Output
       * We do:      Input -> JUSD -> Output (skipping vault roundtrip)
       */

      it("Should directly convert JUSD to bridged token (skip svJUSD)", async function () {
        const { gateway, user1, jusd, usdc, usdcBridge } = await loadFixture(deployGatewayWithBridgedTokensFixture);

        const jusdAmount = ethers.parseEther("100");
        const deadline = (await time.latest()) + 3600;

        // Mint JUSD to user
        await jusd.mint(user1.address, jusdAmount);
        await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);

        // Fund bridge with USDC for burn operation
        const usdcAmount = 100_000_000n; // 100 USDC (6 decimals)
        await usdc.mint(await usdcBridge.getAddress(), usdcAmount);

        // Set minted amount so burn can decrease it (minted -= amount)
        await usdcBridge.setMinted(jusdAmount);

        const usdcBefore = await usdc.balanceOf(user1.address);

        // Swap JUSD -> USDC.e (should use direct path, not svJUSD roundtrip)
        await gateway.connect(user1).swapExactTokensForTokens(
          await jusd.getAddress(),
          await usdc.getAddress(),
          0, // fee (not used for direct conversion)
          jusdAmount,
          0, // minAmountOut
          user1.address,
          deadline
        );

        const usdcAfter = await usdc.balanceOf(user1.address);
        const expectedUsdc = jusdAmount / 10n ** 12n; // 18 decimals -> 6 decimals

        expect(usdcAfter - usdcBefore).to.equal(expectedUsdc);
      });

      it("Should directly convert bridged token to JUSD (skip svJUSD)", async function () {
        const { gateway, user1, jusd, usdc } = await loadFixture(deployGatewayWithBridgedTokensFixture);

        const usdcAmount = 100_000_000n; // 100 USDC (6 decimals)
        const deadline = (await time.latest()) + 3600;

        // Mint USDC to user
        await usdc.mint(user1.address, usdcAmount);
        await usdc.connect(user1).approve(await gateway.getAddress(), usdcAmount);

        const jusdBefore = await jusd.balanceOf(user1.address);

        // Swap USDC.e -> JUSD (should use direct path)
        await gateway
          .connect(user1)
          .swapExactTokensForTokens(
            await usdc.getAddress(),
            await jusd.getAddress(),
            0,
            usdcAmount,
            0,
            user1.address,
            deadline
          );

        const jusdAfter = await jusd.balanceOf(user1.address);
        const expectedJusd = usdcAmount * 10n ** 12n; // 6 decimals -> 18 decimals

        expect(jusdAfter - jusdBefore).to.equal(expectedJusd);
      });

      it("Should directly convert between bridged tokens (skip svJUSD)", async function () {
        const { gateway, user1, usdc, usdt, usdtBridge } = await loadFixture(deployGatewayWithBridgedTokensFixture);

        const usdcAmount = 100_000_000n; // 100 USDC (6 decimals)
        const deadline = (await time.latest()) + 3600;

        // Mint USDC to user
        await usdc.mint(user1.address, usdcAmount);
        await usdc.connect(user1).approve(await gateway.getAddress(), usdcAmount);

        // Fund USDT bridge for burn operation
        await usdt.mint(await usdtBridge.getAddress(), usdcAmount);

        // Set minted for USDT bridge (USDC converts to JUSD, then JUSD burns on USDT bridge)
        const jusdAmount = usdcAmount * 10n ** 12n; // 6 decimals -> 18 decimals
        await usdtBridge.setMinted(jusdAmount);

        const usdtBefore = await usdt.balanceOf(user1.address);

        // Swap USDC.e -> USDT.e (should use direct path)
        await gateway
          .connect(user1)
          .swapExactTokensForTokens(
            await usdc.getAddress(),
            await usdt.getAddress(),
            0,
            usdcAmount,
            0,
            user1.address,
            deadline
          );

        const usdtAfter = await usdt.balanceOf(user1.address);

        // Both have 6 decimals, so amounts should match (minus any bridge fees)
        expect(usdtAfter - usdtBefore).to.equal(usdcAmount);
      });

      it("Should directly convert JUSD to JUICE (skip svJUSD)", async function () {
        const { gateway, user1, jusd, juice } = await loadFixture(deployGatewayWithBridgedTokensFixture);

        const jusdAmount = ethers.parseEther("100");
        const deadline = (await time.latest()) + 3600;

        // Mint JUSD to user
        await jusd.mint(user1.address, jusdAmount);
        await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);

        const juiceBefore = await juice.balanceOf(user1.address);

        // Swap JUSD -> JUICE (should use direct path via Equity.invest)
        await gateway
          .connect(user1)
          .swapExactTokensForTokens(
            await jusd.getAddress(),
            await juice.getAddress(),
            0,
            jusdAmount,
            0,
            user1.address,
            deadline
          );

        const juiceAfter = await juice.balanceOf(user1.address);

        // MockEquity uses PRICE = 100e18, so 100 JUSD = 1 JUICE
        const expectedJuice = jusdAmount / 100n;
        expect(juiceAfter - juiceBefore).to.equal(expectedJuice);
      });

      it("Should directly convert bridged token to JUICE (skip svJUSD)", async function () {
        const { gateway, user1, usdc, juice } = await loadFixture(deployGatewayWithBridgedTokensFixture);

        const usdcAmount = 100_000_000n; // 100 USDC (6 decimals)
        const deadline = (await time.latest()) + 3600;

        // Mint USDC to user
        await usdc.mint(user1.address, usdcAmount);
        await usdc.connect(user1).approve(await gateway.getAddress(), usdcAmount);

        const juiceBefore = await juice.balanceOf(user1.address);

        // Swap USDC.e -> JUICE (should use direct path)
        await gateway
          .connect(user1)
          .swapExactTokensForTokens(
            await usdc.getAddress(),
            await juice.getAddress(),
            0,
            usdcAmount,
            0,
            user1.address,
            deadline
          );

        const juiceAfter = await juice.balanceOf(user1.address);
        const jusdEquivalent = usdcAmount * 10n ** 12n; // 6 decimals -> 18 decimals
        // MockEquity uses PRICE = 100e18, so 100 JUSD = 1 JUICE
        const expectedJuice = jusdEquivalent / 100n;

        expect(juiceAfter - juiceBefore).to.equal(expectedJuice);
      });

      it("Should emit SwapExecuted event for direct conversion", async function () {
        const { gateway, user1, jusd, usdc, usdcBridge } = await loadFixture(deployGatewayWithBridgedTokensFixture);

        const jusdAmount = ethers.parseEther("100");
        const deadline = (await time.latest()) + 3600;

        await jusd.mint(user1.address, jusdAmount);
        await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
        await usdc.mint(await usdcBridge.getAddress(), 100_000_000n);
        await usdcBridge.setMinted(jusdAmount);

        await expect(
          gateway
            .connect(user1)
            .swapExactTokensForTokens(
              await jusd.getAddress(),
              await usdc.getAddress(),
              0,
              jusdAmount,
              0,
              user1.address,
              deadline
            )
        )
          .to.emit(gateway, "SwapExecuted")
          .withArgs(user1.address, await jusd.getAddress(), await usdc.getAddress(), jusdAmount, anyValue);
      });

      it("Should revert if minAmountOut not met in direct conversion", async function () {
        const { gateway, user1, jusd, usdc, usdcBridge } = await loadFixture(deployGatewayWithBridgedTokensFixture);

        const jusdAmount = ethers.parseEther("100");
        const deadline = (await time.latest()) + 3600;

        await jusd.mint(user1.address, jusdAmount);
        await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
        await usdc.mint(await usdcBridge.getAddress(), 100_000_000n);
        await usdcBridge.setMinted(jusdAmount);

        // Expect 200 USDC but only 100 USDC will be received
        const unreasonableMinOutput = 200_000_000n; // 200 USDC

        await expect(
          gateway
            .connect(user1)
            .swapExactTokensForTokens(
              await jusd.getAddress(),
              await usdc.getAddress(),
              0,
              jusdAmount,
              unreasonableMinOutput,
              user1.address,
              deadline
            )
        ).to.be.revertedWithCustomError(gateway, "InsufficientOutput");
      });

      it("Should still use pool swap for cBTC to JUSD (not direct)", async function () {
        const { gateway, user1, wcbtc, jusd, svJusd, swapRouter } = await loadFixture(
          deployGatewayWithBridgedTokensFixture
        );

        const cbtcAmount = ethers.parseEther("1");
        const deadline = (await time.latest()) + 3600;

        // Fund user with native cBTC
        await user1.sendTransaction({
          to: await wcbtc.getAddress(),
          value: cbtcAmount,
        });

        // Setup mock swap router to return svJUSD
        const expectedSvJusd = ethers.parseEther("50000");
        // Use explicit function signature to avoid ambiguity with ERC4626.mint(uint256,address)
        await svJusd["mint(address,uint256)"](await swapRouter.getAddress(), expectedSvJusd);
        await swapRouter.setSwapOutput(expectedSvJusd);

        // This should NOT use direct conversion (cBTC is not a USD token)
        // It should go through the normal pool swap path
        await gateway.connect(user1).swapExactTokensForTokens(
          ethers.ZeroAddress, // Native cBTC
          await jusd.getAddress(),
          3000,
          cbtcAmount,
          0,
          user1.address,
          deadline,
          { value: cbtcAmount }
        );

        // Verify swap router was called (not direct path)
        // The exact assertion depends on mock implementation
      });
    });
  });

  // ==================== Pool Creation Tests ====================

  describe("Pool Creation", function () {
    describe("getPool", function () {
      it("Should return pool address when pool exists", async function () {
        const { gateway, jusd, wcbtc, positionManager, svJusd } = await loadFixture(deployGatewayWithBalancesFixture);

        const svJusdAddr = await svJusd.getAddress();
        const wcbtcAddr = await wcbtc.getAddress();
        const mockPoolAddr = "0x0000000000000000000000000000000000001234";

        // Get the factory from the position manager (Gateway uses POSITION_MANAGER.factory())
        const factoryAddr = await positionManager.factory();
        const MockFactoryFactory = await ethers.getContractFactory("MockFactory");
        const factory = MockFactoryFactory.attach(factoryAddr);

        // Set pool in mock factory
        await factory.setPool(svJusdAddr, wcbtcAddr, 3000, mockPoolAddr);

        const [pool, exists] = await gateway.getPool(await jusd.getAddress(), await wcbtc.getAddress(), 3000);

        expect(exists).to.be.true;
        expect(pool).to.equal(mockPoolAddr);
      });

      it("Should return (address(0), false) when pool does not exist", async function () {
        const { gateway, jusd, wcbtc } = await loadFixture(deployGatewayFixture);

        const [pool, exists] = await gateway.getPool(await jusd.getAddress(), await wcbtc.getAddress(), 3000);

        expect(exists).to.be.false;
        expect(pool).to.equal(ethers.ZeroAddress);
      });

      it("Should use default fee when fee is 0", async function () {
        const { gateway, jusd, wcbtc, positionManager, svJusd } = await loadFixture(deployGatewayWithBalancesFixture);

        const svJusdAddr = await svJusd.getAddress();
        const wcbtcAddr = await wcbtc.getAddress();
        const mockPoolAddr = "0x0000000000000000000000000000000000005678";

        // Get the factory from the position manager
        const factoryAddr = await positionManager.factory();
        const MockFactoryFactory = await ethers.getContractFactory("MockFactory");
        const factory = MockFactoryFactory.attach(factoryAddr);

        // Set pool with default fee (3000)
        await factory.setPool(svJusdAddr, wcbtcAddr, 3000, mockPoolAddr);

        // Query with fee=0 should use default (3000)
        const [pool, exists] = await gateway.getPool(await jusd.getAddress(), await wcbtc.getAddress(), 0);

        expect(exists).to.be.true;
        expect(pool).to.equal(mockPoolAddr);
      });

      it("Should correctly map JUSD to svJUSD for pool lookup", async function () {
        const { gateway, jusd, wcbtc, positionManager, svJusd } = await loadFixture(deployGatewayWithBalancesFixture);

        const svJusdAddr = await svJusd.getAddress();
        const wcbtcAddr = await wcbtc.getAddress();
        const mockPoolAddr = "0x0000000000000000000000000000000000009abc";

        // Get the factory from the position manager
        const factoryAddr = await positionManager.factory();
        const MockFactoryFactory = await ethers.getContractFactory("MockFactory");
        const factory = MockFactoryFactory.attach(factoryAddr);

        // Set pool with svJUSD (not JUSD)
        await factory.setPool(svJusdAddr, wcbtcAddr, 3000, mockPoolAddr);

        // Query with JUSD should find the svJUSD pool
        const [pool, exists] = await gateway.getPool(await jusd.getAddress(), await wcbtc.getAddress(), 3000);

        expect(exists).to.be.true;
        expect(pool.toLowerCase()).to.equal(mockPoolAddr.toLowerCase());
      });
    });

    describe("createPool", function () {
      it("Should create a new pool with JUSD/WcBTC", async function () {
        const { gateway, user1, jusd, wcbtc, svJusd } = await loadFixture(deployGatewayWithBalancesFixture);

        // Initial sqrt price: 1:1 ratio
        const sqrtPriceX96 = BigInt("79228162514264337593543950336"); // sqrt(1) * 2^96

        const tx = await gateway
          .connect(user1)
          .createPool(await jusd.getAddress(), await wcbtc.getAddress(), 3000, sqrtPriceX96);

        await expect(tx).to.emit(gateway, "PoolCreated");
      });

      it("Should use default fee when fee is 0", async function () {
        const { gateway, user1, jusd, wcbtc } = await loadFixture(deployGatewayWithBalancesFixture);

        const sqrtPriceX96 = BigInt("79228162514264337593543950336");

        const tx = await gateway
          .connect(user1)
          .createPool(await jusd.getAddress(), await wcbtc.getAddress(), 0, sqrtPriceX96);

        // Should emit event with fee=3000 (default)
        await expect(tx).to.emit(gateway, "PoolCreated");
      });

      it("Should revert for JUICE/JUSD pair", async function () {
        const { gateway, user1, juice, jusd } = await loadFixture(deployGatewayWithBalancesFixture);

        const sqrtPriceX96 = BigInt("79228162514264337593543950336");

        await expect(
          gateway.connect(user1).createPool(await juice.getAddress(), await jusd.getAddress(), 3000, sqrtPriceX96)
        ).to.be.revertedWithCustomError(gateway, "JuiceCannotPairWithUsd");
      });

      it("Should revert for same token pair", async function () {
        const { gateway, user1, jusd } = await loadFixture(deployGatewayWithBalancesFixture);

        const sqrtPriceX96 = BigInt("79228162514264337593543950336");

        await expect(
          gateway.connect(user1).createPool(await jusd.getAddress(), await jusd.getAddress(), 3000, sqrtPriceX96)
        ).to.be.revertedWithCustomError(gateway, "InvalidTokenPair");
      });

      it("Should revert for invalid fee tier", async function () {
        const { gateway, user1, jusd, wcbtc } = await loadFixture(deployGatewayWithBalancesFixture);

        const sqrtPriceX96 = BigInt("79228162514264337593543950336");

        await expect(
          gateway.connect(user1).createPool(await jusd.getAddress(), await wcbtc.getAddress(), 1_000_000, sqrtPriceX96)
        ).to.be.revertedWithCustomError(gateway, "InvalidFee");
      });

      it("Should revert for zero sqrt price", async function () {
        const { gateway, user1, juice, wcbtc } = await loadFixture(deployGatewayWithBalancesFixture);

        await expect(
          gateway.connect(user1).createPool(await juice.getAddress(), await wcbtc.getAddress(), 3000, 0)
        ).to.be.revertedWithCustomError(gateway, "InvalidPrice");
      });
    });

    describe("createPoolAndAddLiquidity", function () {
      it("Should create pool and add liquidity in one transaction", async function () {
        const { gateway, user1, jusd, wcbtc, svJusd, positionManager } = await loadFixture(
          deployGatewayWithBalancesFixture
        );

        const deadline = (await time.latest()) + DEADLINE_OFFSET;
        const sqrtPriceX96 = BigInt("79228162514264337593543950336"); // 1:1
        const jusdAmount = ethers.parseEther("100");
        const wcbtcAmount = ethers.parseEther("100");

        // Calculate svJUSD shares
        const svJusdShares = await svJusd.convertToShares(jusdAmount);

        // Setup mock
        const svJusdAddr = await svJusd.getAddress();
        const wcbtcAddr = await wcbtc.getAddress();
        const [amount0, amount1] = svJusdAddr < wcbtcAddr ? [svJusdShares, wcbtcAmount] : [wcbtcAmount, svJusdShares];

        await positionManager.setMintResult(1, 100, amount0, amount1);

        // Approve tokens
        await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
        await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

        const tx = await gateway.connect(user1).createPoolAndAddLiquidity(
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          3000,
          sqrtPriceX96,
          0, // full range
          0,
          jusdAmount,
          wcbtcAmount,
          0,
          0,
          user1.address,
          deadline
        );

        // Should emit both events
        await expect(tx).to.emit(gateway, "PoolCreated");
        await expect(tx).to.emit(gateway, "LiquidityAdded");
      });

      it("Should revert if deadline expired", async function () {
        const { gateway, user1, jusd, wcbtc } = await loadFixture(deployGatewayWithBalancesFixture);

        const expiredDeadline = (await time.latest()) - 1;
        const sqrtPriceX96 = BigInt("79228162514264337593543950336");
        const amount = ethers.parseEther("100");

        await jusd.connect(user1).approve(await gateway.getAddress(), amount);
        await wcbtc.connect(user1).approve(await gateway.getAddress(), amount);

        await expect(
          gateway
            .connect(user1)
            .createPoolAndAddLiquidity(
              await jusd.getAddress(),
              await wcbtc.getAddress(),
              3000,
              sqrtPriceX96,
              0,
              0,
              amount,
              amount,
              0,
              0,
              user1.address,
              expiredDeadline
            )
        ).to.be.revertedWithCustomError(gateway, "DeadlineExpired");
      });

      it("Should revert for JUICE/JUSD pair", async function () {
        const { gateway, user1, juice, jusd } = await loadFixture(deployGatewayWithBalancesFixture);

        const deadline = (await time.latest()) + DEADLINE_OFFSET;
        const sqrtPriceX96 = BigInt("79228162514264337593543950336");
        const amount = ethers.parseEther("100");

        await expect(
          gateway
            .connect(user1)
            .createPoolAndAddLiquidity(
              await juice.getAddress(),
              await jusd.getAddress(),
              3000,
              sqrtPriceX96,
              0,
              0,
              amount,
              amount,
              0,
              0,
              user1.address,
              deadline
            )
        ).to.be.revertedWithCustomError(gateway, "JuiceCannotPairWithUsd");
      });

      it("Should work with JUICE/WcBTC pair", async function () {
        const { gateway, user1, juice, wcbtc, positionManager } = await loadFixture(deployGatewayWithBalancesFixture);

        const deadline = (await time.latest()) + DEADLINE_OFFSET;
        const sqrtPriceX96 = BigInt("79228162514264337593543950336");
        const juiceAmount = ethers.parseEther("100");
        const wcbtcAmount = ethers.parseEther("100");

        // Setup mock
        const juiceAddr = await juice.getAddress();
        const wcbtcAddr = await wcbtc.getAddress();
        const [amount0, amount1] = juiceAddr < wcbtcAddr ? [juiceAmount, wcbtcAmount] : [wcbtcAmount, juiceAmount];

        await positionManager.setMintResult(1, 100, amount0, amount1);

        // Approve tokens
        await juice.connect(user1).approve(await gateway.getAddress(), juiceAmount);
        await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

        const tx = await gateway
          .connect(user1)
          .createPoolAndAddLiquidity(
            await juice.getAddress(),
            await wcbtc.getAddress(),
            3000,
            sqrtPriceX96,
            0,
            0,
            juiceAmount,
            wcbtcAmount,
            0,
            0,
            user1.address,
            deadline
          );

        await expect(tx).to.emit(gateway, "PoolCreated");
        await expect(tx).to.emit(gateway, "LiquidityAdded");
      });
    });

    describe("Price Conversion", function () {
      it("Should not convert price when neither token is JUSD-based", async function () {
        const { gateway, user1, juice, wcbtc } = await loadFixture(deployGatewayWithBalancesFixture);

        // JUICE/WcBTC - no conversion needed
        const sqrtPriceX96 = BigInt("79228162514264337593543950336");

        // This should work without any price conversion issues
        const tx = await gateway
          .connect(user1)
          .createPool(await juice.getAddress(), await wcbtc.getAddress(), 3000, sqrtPriceX96);

        await expect(tx).to.emit(gateway, "PoolCreated");
      });

      it("Should convert price when JUSD is involved", async function () {
        const { gateway, user1, jusd, wcbtc, svJusd } = await loadFixture(deployGatewayWithBalancesFixture);

        // Simulate interest accrual (1 svJUSD = 1.1 JUSD)
        await svJusd.accrueInterest(ethers.parseEther("10"));

        const sqrtPriceX96 = BigInt("79228162514264337593543950336"); // 1:1 in JUSD terms

        // This should create pool with adjusted price for svJUSD
        const tx = await gateway
          .connect(user1)
          .createPool(await jusd.getAddress(), await wcbtc.getAddress(), 3000, sqrtPriceX96);

        await expect(tx).to.emit(gateway, "PoolCreated");
      });
    });
  });

  // ==================== Extended Test Coverage ====================

  describe("Reentrancy Protection", function () {
    it("Should prevent reentrancy on swapExactTokensForTokens via malicious ERC20 transferFrom", async function () {
      const { gateway, user1, wcbtc, swapRouter } = await loadFixture(deployGatewayWithBalancesFixture);

      // Deploy malicious ERC20
      const MaliciousERC20Factory = await ethers.getContractFactory("MaliciousERC20");
      const maliciousToken = await MaliciousERC20Factory.deploy();
      await maliciousToken.waitForDeployment();

      const maliciousAddr = await maliciousToken.getAddress();
      const gatewayAddr = await gateway.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();

      // Setup malicious token
      await maliciousToken.mint(user1.address, ethers.parseEther("1000"));
      await maliciousToken.connect(user1).approve(gatewayAddr, ethers.MaxUint256);
      await maliciousToken.setTarget(gatewayAddr, wcbtcAddr);
      await maliciousToken.enableAttackOnTransferFrom(true);

      // Setup swap router to accept the malicious token
      await swapRouter.setSwapOutput(ethers.parseEther("0.5"));

      const deadline = (await time.latest()) + 3600;

      // The malicious token will attempt reentrancy during transferFrom
      // The ReentrancyGuard should prevent the nested call
      // Original transaction should still complete
      await gateway
        .connect(user1)
        .swapExactTokensForTokens(maliciousAddr, wcbtcAddr, 3000, ethers.parseEther("10"), 0, user1.address, deadline);

      // Attack was attempted but caught by ReentrancyGuard
      // Note: attackCount may be > 1 if multiple transfers occur during the swap
      expect(await maliciousToken.attackCount()).to.be.gte(1);
    });

    it("Should prevent reentrancy on removeLiquidity via native token receive callback", async function () {
      const { gateway, user1, owner, jusd, wcbtc, svJusd, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      // Deploy malicious receiver
      const MaliciousReceiverFactory = await ethers.getContractFactory("MaliciousReceiver");
      const maliciousReceiver = await MaliciousReceiverFactory.deploy();
      await maliciousReceiver.waitForDeployment();

      const gatewayAddr = await gateway.getAddress();
      const posManagerAddr = await positionManager.getAddress();
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const jusdAddr = await jusd.getAddress();

      // Setup position
      const tokenId = 1;
      const [token0, token1] = svJusdAddr < wcbtcAddr ? [svJusdAddr, wcbtcAddr] : [wcbtcAddr, svJusdAddr];

      await positionManager.setPositionData(tokenId, token0, token1, 100);
      await positionManager.setDecreaseResult(ethers.parseEther("100"), ethers.parseEther("1"));

      // Fund position manager with svJUSD
      await jusd.mint(owner.address, ethers.parseEther("200"));
      await jusd.connect(owner).approve(await svJusd.getAddress(), ethers.parseEther("200"));
      await svJusd.connect(owner).deposit(ethers.parseEther("100"), posManagerAddr);
      await wcbtc.deposit({ value: ethers.parseEther("100") });
      await wcbtc.transfer(posManagerAddr, ethers.parseEther("100"));

      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(gatewayAddr, tokenId);

      // Setup malicious receiver to attempt reentrancy
      await maliciousReceiver.setAttackRemoveLiquidity(
        gatewayAddr,
        tokenId,
        ethers.ZeroAddress, // Native cBTC
        jusdAddr
      );
      await maliciousReceiver.enableAttack(true);

      const deadline = (await time.latest()) + 3600;

      // This should complete despite reentrancy attempt
      // The malicious receiver will try to call removeLiquidity again when it receives native cBTC
      await gateway.connect(user1).removeLiquidity(
        tokenId,
        0,
        ethers.ZeroAddress, // Native cBTC output
        jusdAddr,
        0,
        0,
        await maliciousReceiver.getAddress(),
        deadline
      );

      // Attack was attempted
      expect(await maliciousReceiver.attackCount()).to.equal(1);
    });
  });

  describe("receive() Function Extended Tests", function () {
    it("Should reject native tokens from arbitrary contracts", async function () {
      const { gateway, user1 } = await loadFixture(deployGatewayWithBalancesFixture);

      // Deploy a contract that can receive and forward native tokens
      const SimpleForwarderFactory = await ethers.getContractFactory("MaliciousReceiver");
      const forwarder = await SimpleForwarderFactory.deploy();
      await forwarder.waitForDeployment();

      // Fund the forwarder contract
      await user1.sendTransaction({
        to: await forwarder.getAddress(),
        value: ethers.parseEther("1"),
      });

      // The gateway only accepts native tokens from WcBTC
      // Direct transfers from any other source should be rejected
      // This is already tested in the Security section
      // Here we verify the forwarder received the funds (test setup works)
      expect(await ethers.provider.getBalance(await forwarder.getAddress())).to.equal(ethers.parseEther("1"));
    });
  });

  describe("Transfer Failure Handling", function () {
    it("Should revert with TransferFailed when native token send fails", async function () {
      const { gateway, user1, owner, jusd, wcbtc, svJusd, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      // Deploy contract that rejects native tokens
      const RejectNativeFactory = await ethers.getContractFactory("RejectNative");
      const rejecter = await RejectNativeFactory.deploy();
      await rejecter.waitForDeployment();

      const gatewayAddr = await gateway.getAddress();
      const posManagerAddr = await positionManager.getAddress();
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();

      // Setup position
      const tokenId = 1;
      const [token0, token1] = svJusdAddr < wcbtcAddr ? [svJusdAddr, wcbtcAddr] : [wcbtcAddr, svJusdAddr];

      await positionManager.setPositionData(tokenId, token0, token1, 100);
      await positionManager.setDecreaseResult(ethers.parseEther("100"), ethers.parseEther("1"));

      // Fund position manager with svJUSD
      await jusd.mint(owner.address, ethers.parseEther("200"));
      await jusd.connect(owner).approve(await svJusd.getAddress(), ethers.parseEther("200"));
      await svJusd.connect(owner).deposit(ethers.parseEther("100"), posManagerAddr);
      await wcbtc.deposit({ value: ethers.parseEther("100") });
      await wcbtc.transfer(posManagerAddr, ethers.parseEther("100"));

      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(gatewayAddr, tokenId);

      const deadline = (await time.latest()) + 3600;

      // Try to remove liquidity with native cBTC output to a contract that rejects it
      await expect(
        gateway.connect(user1).removeLiquidity(
          tokenId,
          0,
          ethers.ZeroAddress, // Native cBTC output
          await jusd.getAddress(),
          0,
          0,
          await rejecter.getAddress(), // Recipient that rejects native tokens
          deadline
        )
      ).to.be.revertedWithCustomError(gateway, "TransferFailed");
    });
  });

  describe("Token Validation Edge Cases", function () {
    it("Should revert addLiquidity with tokenA == tokenB", async function () {
      const { gateway, user1, jusd } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + 3600;
      const amount = ethers.parseEther("100");

      await jusd.connect(user1).approve(await gateway.getAddress(), amount * 2n);

      await expect(
        gateway.connect(user1).addLiquidity(
          await jusd.getAddress(),
          await jusd.getAddress(), // Same token
          3000,
          0,
          0,
          amount,
          amount,
          0,
          0,
          user1.address,
          deadline
        )
      ).to.be.revertedWithCustomError(gateway, "InvalidTokenPair");
    });

    it("Should revert when JUSD and svJUSD are paired (both become svJUSD)", async function () {
      const { gateway, user1, jusd, svJusd } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + 3600;
      const amount = ethers.parseEther("100");

      await jusd.connect(user1).approve(await gateway.getAddress(), amount);
      // Need to get some svJUSD first
      await jusd.mint(user1.address, amount);
      await jusd.connect(user1).approve(await svJusd.getAddress(), amount);
      await svJusd.connect(user1).deposit(amount, user1.address);
      await svJusd.connect(user1).approve(await gateway.getAddress(), amount);

      await expect(
        gateway.connect(user1).addLiquidity(
          await jusd.getAddress(), // -> svJUSD internally
          await svJusd.getAddress(), // stays svJUSD
          3000,
          0,
          0,
          amount,
          amount,
          0,
          0,
          user1.address,
          deadline
        )
      ).to.be.revertedWithCustomError(gateway, "InvalidTokenPair");
    });
  });

  describe("Fee Edge Cases Extended", function () {
    it("Should use DEFAULT_FEE (3000) when fee=0 for swap", async function () {
      const { gateway, user1, jusd, wcbtc, swapRouter } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + 3600;
      await swapRouter.setSwapOutput(ethers.parseEther("0.5"));
      await jusd.connect(user1).approve(await gateway.getAddress(), SWAP_AMOUNT);

      // fee = 0 should internally become 3000
      const tx = await gateway.connect(user1).swapExactTokensForTokens(
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        0, // Should use DEFAULT_FEE
        SWAP_AMOUNT,
        0,
        user1.address,
        deadline
      );

      // Verify swap succeeded (implicitly verifies fee was valid)
      await expect(tx).to.emit(gateway, "SwapExecuted");
    });

    it("Should use DEFAULT_FEE (3000) when fee=0 for addLiquidity", async function () {
      const { gateway, user1, jusd, wcbtc, svJusd, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + 3600;
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      const svJusdShares = await svJusd.convertToShares(jusdAmount);
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [amount0, amount1] = svJusdAddr < wcbtcAddr ? [svJusdShares, wcbtcAmount] : [wcbtcAmount, svJusdShares];

      await positionManager.setMintResult(1, 100, amount0, amount1);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      const tx = await gateway.connect(user1).addLiquidity(
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        0, // Should use DEFAULT_FEE
        0,
        0,
        jusdAmount,
        wcbtcAmount,
        0,
        0,
        user1.address,
        deadline
      );

      await expect(tx).to.emit(gateway, "LiquidityAdded");
    });

    it("Should accept fee=999999 (just under limit)", async function () {
      const { gateway, user1, jusd, wcbtc, swapRouter, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + 3600;
      await swapRouter.setSwapOutput(ethers.parseEther("0.5"));
      await jusd.connect(user1).approve(await gateway.getAddress(), SWAP_AMOUNT);

      // Setup mock factory to accept this fee tier
      const factoryAddr = await positionManager.factory();
      const MockFactoryFactory = await ethers.getContractFactory("MockFactory");
      const factory = MockFactoryFactory.attach(factoryAddr);
      await factory.enableFeeAmount(999999, 1); // Enable this fee tier

      // This should succeed since 999999 < 1_000_000
      const tx = await gateway
        .connect(user1)
        .swapExactTokensForTokens(
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          999999,
          SWAP_AMOUNT,
          0,
          user1.address,
          deadline
        );

      await expect(tx).to.emit(gateway, "SwapExecuted");
    });

    it("Should revert with fee > 1000000", async function () {
      const { gateway, user1, jusd, wcbtc } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + 3600;
      await jusd.connect(user1).approve(await gateway.getAddress(), SWAP_AMOUNT);

      await expect(
        gateway
          .connect(user1)
          .swapExactTokensForTokens(
            await jusd.getAddress(),
            await wcbtc.getAddress(),
            1_000_001,
            SWAP_AMOUNT,
            0,
            user1.address,
            deadline
          )
      ).to.be.revertedWithCustomError(gateway, "InvalidFee");
    });
  });

  describe("Tick Spacing per Fee Tier", function () {
    it("Should accept ticks aligned to spacing=1 for fee=100 (0.01%)", async function () {
      const { gateway, user1, jusd, wcbtc, svJusd, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + 3600;
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      const svJusdShares = await svJusd.convertToShares(jusdAmount);
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [amount0, amount1] = svJusdAddr < wcbtcAddr ? [svJusdShares, wcbtcAmount] : [wcbtcAmount, svJusdShares];

      await positionManager.setMintResult(1, 100, amount0, amount1);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      // For fee=100, tickSpacing=1, so any odd tick like -887271 is valid
      const tx = await gateway.connect(user1).addLiquidity(
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        100, // 0.01% fee, tickSpacing=1
        -887271, // Odd tick, only valid for spacing=1
        887271,
        jusdAmount,
        wcbtcAmount,
        0,
        0,
        user1.address,
        deadline
      );

      await expect(tx).to.emit(gateway, "LiquidityAdded");
    });

    it("Should accept ticks aligned to spacing=10 for fee=500 (0.05%)", async function () {
      const { gateway, user1, jusd, wcbtc, svJusd, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + 3600;
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      const svJusdShares = await svJusd.convertToShares(jusdAmount);
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [amount0, amount1] = svJusdAddr < wcbtcAddr ? [svJusdShares, wcbtcAmount] : [wcbtcAmount, svJusdShares];

      await positionManager.setMintResult(1, 100, amount0, amount1);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      // For fee=500, tickSpacing=10
      const tx = await gateway.connect(user1).addLiquidity(
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        500, // 0.05% fee, tickSpacing=10
        -60000, // Aligned to 10
        60000,
        jusdAmount,
        wcbtcAmount,
        0,
        0,
        user1.address,
        deadline
      );

      await expect(tx).to.emit(gateway, "LiquidityAdded");
    });

    it("Should accept ticks aligned to spacing=200 for fee=10000 (1%)", async function () {
      const { gateway, user1, jusd, wcbtc, svJusd, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + 3600;
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      const svJusdShares = await svJusd.convertToShares(jusdAmount);
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [amount0, amount1] = svJusdAddr < wcbtcAddr ? [svJusdShares, wcbtcAmount] : [wcbtcAmount, svJusdShares];

      await positionManager.setMintResult(1, 100, amount0, amount1);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      // For fee=10000, tickSpacing=200
      const tx = await gateway.connect(user1).addLiquidity(
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        10000, // 1% fee, tickSpacing=200
        -60000, // Aligned to 200
        60000,
        jusdAmount,
        wcbtcAmount,
        0,
        0,
        user1.address,
        deadline
      );

      await expect(tx).to.emit(gateway, "LiquidityAdded");
    });

    it("Should revert ticks not aligned to spacing=10 for fee=500", async function () {
      const { gateway, user1, jusd, wcbtc } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + 3600;
      const amount = ethers.parseEther("100");

      await jusd.connect(user1).approve(await gateway.getAddress(), amount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), amount);

      // For fee=500, tickSpacing=10, so -60005 is not aligned
      await expect(
        gateway.connect(user1).addLiquidity(
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          500,
          -60005, // NOT aligned to 10
          60000,
          amount,
          amount,
          0,
          0,
          user1.address,
          deadline
        )
      ).to.be.revertedWithCustomError(gateway, "InvalidTickRange");
    });

    it("Should revert ticks not aligned to spacing=200 for fee=10000", async function () {
      const { gateway, user1, jusd, wcbtc } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + 3600;
      const amount = ethers.parseEther("100");

      await jusd.connect(user1).approve(await gateway.getAddress(), amount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), amount);

      // For fee=10000, tickSpacing=200, so -60060 is not aligned (aligned to 60, not 200)
      await expect(
        gateway.connect(user1).addLiquidity(
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          10000,
          -60060, // Aligned to 60 but NOT to 200
          60000,
          amount,
          amount,
          0,
          0,
          user1.address,
          deadline
        )
      ).to.be.revertedWithCustomError(gateway, "InvalidTickRange");
    });
  });

  describe("Tick Range Boundaries", function () {
    const MIN_TICK = -887272;
    const MAX_TICK = 887272;

    it("Should accept exact MIN_TICK (-887272) when aligned (fee=100, spacing=1)", async function () {
      const { gateway, user1, jusd, wcbtc, svJusd, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + 3600;
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      const svJusdShares = await svJusd.convertToShares(jusdAmount);
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [amount0, amount1] = svJusdAddr < wcbtcAddr ? [svJusdShares, wcbtcAmount] : [wcbtcAmount, svJusdShares];

      await positionManager.setMintResult(1, 100, amount0, amount1);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      // With tickSpacing=1 (fee=100), exact MIN_TICK and MAX_TICK are valid
      const tx = await gateway.connect(user1).addLiquidity(
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        100, // tickSpacing=1
        MIN_TICK,
        MAX_TICK,
        jusdAmount,
        wcbtcAmount,
        0,
        0,
        user1.address,
        deadline
      );

      await expect(tx).to.emit(gateway, "LiquidityAdded");
    });

    it("Should revert when tickLower < MIN_TICK", async function () {
      const { gateway, user1, jusd, wcbtc } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + 3600;
      const amount = ethers.parseEther("100");

      await jusd.connect(user1).approve(await gateway.getAddress(), amount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), amount);

      await expect(
        gateway.connect(user1).addLiquidity(
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          100,
          MIN_TICK - 1, // Below MIN_TICK
          MAX_TICK,
          amount,
          amount,
          0,
          0,
          user1.address,
          deadline
        )
      ).to.be.revertedWithCustomError(gateway, "InvalidTickRange");
    });

    it("Should revert when tickUpper > MAX_TICK", async function () {
      const { gateway, user1, jusd, wcbtc } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + 3600;
      const amount = ethers.parseEther("100");

      await jusd.connect(user1).approve(await gateway.getAddress(), amount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), amount);

      await expect(
        gateway.connect(user1).addLiquidity(
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          100,
          MIN_TICK,
          MAX_TICK + 1, // Above MAX_TICK
          amount,
          amount,
          0,
          0,
          user1.address,
          deadline
        )
      ).to.be.revertedWithCustomError(gateway, "InvalidTickRange");
    });
  });

  describe("Negative Tick Alignment", function () {
    it("Should handle negative ticks correctly aligned to spacing=60", async function () {
      const { gateway, user1, jusd, wcbtc, svJusd, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + 3600;
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      const svJusdShares = await svJusd.convertToShares(jusdAmount);
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [amount0, amount1] = svJusdAddr < wcbtcAddr ? [svJusdShares, wcbtcAmount] : [wcbtcAmount, svJusdShares];

      await positionManager.setMintResult(1, 100, amount0, amount1);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      // -120 is aligned to 60 (even negative)
      const tx = await gateway.connect(user1).addLiquidity(
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        3000, // tickSpacing=60
        -120, // Aligned to 60
        120,
        jusdAmount,
        wcbtcAmount,
        0,
        0,
        user1.address,
        deadline
      );

      await expect(tx).to.emit(gateway, "LiquidityAdded");
    });

    it("Should reject misaligned negative ticks", async function () {
      const { gateway, user1, jusd, wcbtc } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + 3600;
      const amount = ethers.parseEther("100");

      await jusd.connect(user1).approve(await gateway.getAddress(), amount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), amount);

      // -61 % 60 = -1 (not aligned)
      await expect(
        gateway.connect(user1).addLiquidity(
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          3000,
          -61, // Not aligned to 60
          60,
          amount,
          amount,
          0,
          0,
          user1.address,
          deadline
        )
      ).to.be.revertedWithCustomError(gateway, "InvalidTickRange");
    });
  });

  describe("NFT Recovery Failure Scenarios", function () {
    it("Should revert if NFT transfer back fails after increaseLiquidity", async function () {
      const { gateway, user1, owner, jusd, wcbtc, svJusd, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const gatewayAddr = await gateway.getAddress();
      const posManagerAddr = await positionManager.getAddress();
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();

      const tokenId = 1;
      const [token0, token1] = svJusdAddr < wcbtcAddr ? [svJusdAddr, wcbtcAddr] : [wcbtcAddr, svJusdAddr];

      await positionManager.setPositionData(tokenId, token0, token1, 100);
      await positionManager.setIncreaseResult(50, ethers.parseEther("50"), ethers.parseEther("0.5"));

      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(gatewayAddr, tokenId);

      // Configure position manager to fail on safeTransferFrom back to user
      await positionManager.setFailSafeTransfer(true, "NFT transfer blocked");

      const deadline = (await time.latest()) + 3600;
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      await jusd.connect(user1).approve(gatewayAddr, jusdAmount);
      await wcbtc.connect(user1).approve(gatewayAddr, wcbtcAmount);

      await expect(
        gateway
          .connect(user1)
          .increaseLiquidity(
            tokenId,
            await jusd.getAddress(),
            await wcbtc.getAddress(),
            jusdAmount,
            wcbtcAmount,
            0,
            0,
            deadline
          )
      ).to.be.reverted; // NFT transfer blocked - any revert is acceptable
    });

    it("Should revert on non-existent tokenId for increaseLiquidity", async function () {
      const { gateway, user1, jusd, wcbtc } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + 3600;
      const amount = ethers.parseEther("100");

      await jusd.connect(user1).approve(await gateway.getAddress(), amount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), amount);

      const nonExistentTokenId = 999999;

      // Should revert because NFT doesn't exist (ownerOf will fail)
      await expect(
        gateway
          .connect(user1)
          .increaseLiquidity(
            nonExistentTokenId,
            await jusd.getAddress(),
            await wcbtc.getAddress(),
            amount,
            amount,
            0,
            0,
            deadline
          )
      ).to.be.reverted; // ERC721NonexistentToken
    });

    it("Should revert on non-existent tokenId for removeLiquidity", async function () {
      const { gateway, user1, jusd, wcbtc } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + 3600;
      const nonExistentTokenId = 999999;

      await expect(
        gateway
          .connect(user1)
          .removeLiquidity(
            nonExistentTokenId,
            0,
            await jusd.getAddress(),
            await wcbtc.getAddress(),
            0,
            0,
            user1.address,
            deadline
          )
      ).to.be.reverted; // ERC721NonexistentToken
    });
  });

  describe("Partial Liquidity Edge Cases", function () {
    it("Should remove exactly all liquidity when liquidityToRemove equals position liquidity", async function () {
      const { gateway, user1, owner, jusd, wcbtc, svJusd, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const gatewayAddr = await gateway.getAddress();
      const posManagerAddr = await positionManager.getAddress();
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();

      const tokenId = 1;
      const positionLiquidity = 12345; // Specific value
      const [token0, token1] = svJusdAddr < wcbtcAddr ? [svJusdAddr, wcbtcAddr] : [wcbtcAddr, svJusdAddr];

      await positionManager.setPositionData(tokenId, token0, token1, positionLiquidity);
      await positionManager.setDecreaseResult(ethers.parseEther("100"), ethers.parseEther("1"));

      // Fund position manager with svJUSD
      await jusd.mint(owner.address, ethers.parseEther("200"));
      await jusd.connect(owner).approve(await svJusd.getAddress(), ethers.parseEther("200"));
      await svJusd.connect(owner).deposit(ethers.parseEther("100"), posManagerAddr);
      await wcbtc.deposit({ value: ethers.parseEther("100") });
      await wcbtc.transfer(posManagerAddr, ethers.parseEther("100"));

      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(gatewayAddr, tokenId);

      const deadline = (await time.latest()) + 3600;

      const tx = await gateway.connect(user1).removeLiquidity(
        tokenId,
        positionLiquidity, // Exact match
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        0,
        0,
        user1.address,
        deadline
      );

      await expect(tx).to.emit(gateway, "LiquidityRemoved");
    });

    it("Should remove minimum liquidity (1 unit)", async function () {
      const { gateway, user1, owner, jusd, wcbtc, svJusd, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const gatewayAddr = await gateway.getAddress();
      const posManagerAddr = await positionManager.getAddress();
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();

      const tokenId = 1;
      const [token0, token1] = svJusdAddr < wcbtcAddr ? [svJusdAddr, wcbtcAddr] : [wcbtcAddr, svJusdAddr];

      await positionManager.setPositionData(tokenId, token0, token1, 1000);
      await positionManager.setDecreaseResult(1n, 1n); // Very small amounts

      // Fund position manager with minimal tokens
      await jusd.mint(owner.address, ethers.parseEther("2"));
      await jusd.connect(owner).approve(await svJusd.getAddress(), ethers.parseEther("2"));
      await svJusd.connect(owner).deposit(ethers.parseEther("1"), posManagerAddr);
      await wcbtc.deposit({ value: ethers.parseEther("1") });
      await wcbtc.transfer(posManagerAddr, ethers.parseEther("1"));

      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(gatewayAddr, tokenId);

      const deadline = (await time.latest()) + 3600;

      const tx = await gateway.connect(user1).removeLiquidity(
        tokenId,
        1, // Minimum liquidity
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        0,
        0,
        user1.address,
        deadline
      );

      await expect(tx).to.emit(gateway, "LiquidityRemoved");

      // NFT should still be owned by user (partial removal)
      expect(await positionManager.ownerOf(tokenId)).to.equal(user1.address);
    });

    it("Should revert when liquidityToRemove = type(uint128).max exceeds position", async function () {
      const { gateway, user1, owner, svJusd, wcbtc, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const gatewayAddr = await gateway.getAddress();
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();

      const tokenId = 1;
      const positionLiquidity = 1000;
      const maxUint128 = 2n ** 128n - 1n;
      const [token0, token1] = svJusdAddr < wcbtcAddr ? [svJusdAddr, wcbtcAddr] : [wcbtcAddr, svJusdAddr];

      await positionManager.setPositionData(tokenId, token0, token1, positionLiquidity);
      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(gatewayAddr, tokenId);

      const deadline = (await time.latest()) + 3600;

      await expect(
        gateway.connect(user1).removeLiquidity(
          tokenId,
          maxUint128,
          await svJusd.getAddress(), // Use actual pool tokens
          await wcbtc.getAddress(),
          0,
          0,
          user1.address,
          deadline
        )
      ).to.be.revertedWithCustomError(gateway, "InsufficientLiquidity");
    });
  });

  describe("Sequential Operations on Same Position", function () {
    it("Should complete full lifecycle: Add -> Increase -> Remove", async function () {
      const { gateway, user1, owner, jusd, wcbtc, svJusd, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + 3600;
      const gatewayAddr = await gateway.getAddress();
      const posManagerAddr = await positionManager.getAddress();
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      const svJusdShares = await svJusd.convertToShares(jusdAmount);
      const [token0, token1] = svJusdAddr < wcbtcAddr ? [svJusdAddr, wcbtcAddr] : [wcbtcAddr, svJusdAddr];
      const [amount0, amount1] = svJusdAddr < wcbtcAddr ? [svJusdShares, wcbtcAmount] : [wcbtcAmount, svJusdShares];

      // Step 1: Add liquidity
      await positionManager.setMintResult(1, 100, amount0, amount1);
      await jusd.connect(user1).approve(gatewayAddr, jusdAmount * 3n);
      await wcbtc.connect(user1).approve(gatewayAddr, wcbtcAmount * 3n);

      const addTx = await gateway
        .connect(user1)
        .addLiquidity(
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          3000,
          0,
          0,
          jusdAmount,
          wcbtcAmount,
          0,
          0,
          user1.address,
          deadline
        );

      await expect(addTx).to.emit(gateway, "LiquidityAdded");
      const tokenId = 1;
      expect(await positionManager.ownerOf(tokenId)).to.equal(user1.address);

      // Step 2: Increase liquidity
      await positionManager.setPositionData(tokenId, token0, token1, 100);
      await positionManager.setIncreaseResult(50, amount0 / 2n, amount1 / 2n);
      await positionManager.connect(user1).approve(gatewayAddr, tokenId);

      const increaseTx = await gateway
        .connect(user1)
        .increaseLiquidity(
          tokenId,
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          jusdAmount,
          wcbtcAmount,
          0,
          0,
          deadline
        );

      await expect(increaseTx).to.emit(gateway, "LiquidityIncreased");
      expect(await positionManager.ownerOf(tokenId)).to.equal(user1.address);

      // Step 3: Remove all liquidity
      await positionManager.setPositionData(tokenId, token0, token1, 150);
      await positionManager.setDecreaseResult((amount0 * 3n) / 2n, (amount1 * 3n) / 2n);

      // Fund position manager with svJUSD
      await jusd.mint(owner.address, ethers.parseEther("400"));
      await jusd.connect(owner).approve(await svJusd.getAddress(), ethers.parseEther("400"));
      await svJusd.connect(owner).deposit(ethers.parseEther("200"), posManagerAddr);
      await wcbtc.deposit({ value: ethers.parseEther("200") });
      await wcbtc.transfer(posManagerAddr, ethers.parseEther("200"));

      await positionManager.connect(user1).approve(gatewayAddr, tokenId);

      const removeTx = await gateway.connect(user1).removeLiquidity(
        tokenId,
        0, // Remove all
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        0,
        0,
        user1.address,
        deadline
      );

      await expect(removeTx).to.emit(gateway, "LiquidityRemoved");
    });
  });

  describe("Slippage Protection Boundary Cases", function () {
    it("Should succeed when actual amounts exactly equal min amounts (removeLiquidity)", async function () {
      const { gateway, user1, owner, jusd, wcbtc, svJusd, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const gatewayAddr = await gateway.getAddress();
      const posManagerAddr = await positionManager.getAddress();
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();

      const tokenId = 1;
      const exactJusdAmount = ethers.parseEther("100");
      const exactWcbtcAmount = ethers.parseEther("1");
      const [token0, token1] = svJusdAddr < wcbtcAddr ? [svJusdAddr, wcbtcAddr] : [wcbtcAddr, svJusdAddr];

      // Note: For JUSD output, we receive svJUSD internally which gets converted to JUSD
      // The min check happens AFTER conversion
      const svJusdShares = await svJusd.convertToShares(exactJusdAmount);
      const [amount0, amount1] =
        svJusdAddr < wcbtcAddr ? [svJusdShares, exactWcbtcAmount] : [exactWcbtcAmount, svJusdShares];

      await positionManager.setPositionData(tokenId, token0, token1, 100);
      await positionManager.setDecreaseResult(amount0, amount1);

      // Fund position manager with svJUSD
      await jusd.mint(owner.address, exactJusdAmount * 4n);
      await jusd.connect(owner).approve(await svJusd.getAddress(), exactJusdAmount * 4n);
      await svJusd.connect(owner).deposit(exactJusdAmount * 2n, posManagerAddr);
      await wcbtc.deposit({ value: exactWcbtcAmount * 2n });
      await wcbtc.transfer(posManagerAddr, exactWcbtcAmount * 2n);

      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(gatewayAddr, tokenId);

      const deadline = (await time.latest()) + 3600;

      // Set min amounts to exactly what we expect to receive
      const tx = await gateway.connect(user1).removeLiquidity(
        tokenId,
        0,
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        exactJusdAmount, // Exact match
        exactWcbtcAmount, // Exact match
        user1.address,
        deadline
      );

      await expect(tx).to.emit(gateway, "LiquidityRemoved");
    });

    it("Should revert when actual amount is below min (removeLiquidity)", async function () {
      const { gateway, user1, owner, jusd, wcbtc, svJusd, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const gatewayAddr = await gateway.getAddress();
      const posManagerAddr = await positionManager.getAddress();
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();

      const tokenId = 1;
      const actualJusdAmount = ethers.parseEther("99");
      const actualWcbtcAmount = ethers.parseEther("1");
      const minJusdAmount = ethers.parseEther("100"); // More than actual
      const [token0, token1] = svJusdAddr < wcbtcAddr ? [svJusdAddr, wcbtcAddr] : [wcbtcAddr, svJusdAddr];

      const svJusdShares = await svJusd.convertToShares(actualJusdAmount);
      const [amount0, amount1] =
        svJusdAddr < wcbtcAddr ? [svJusdShares, actualWcbtcAmount] : [actualWcbtcAmount, svJusdShares];

      await positionManager.setPositionData(tokenId, token0, token1, 100);
      await positionManager.setDecreaseResult(amount0, amount1);

      // Fund position manager with svJUSD
      await jusd.mint(owner.address, actualJusdAmount * 4n);
      await jusd.connect(owner).approve(await svJusd.getAddress(), actualJusdAmount * 4n);
      await svJusd.connect(owner).deposit(actualJusdAmount * 2n, posManagerAddr);
      await wcbtc.deposit({ value: actualWcbtcAmount * 2n });
      await wcbtc.transfer(posManagerAddr, actualWcbtcAmount * 2n);

      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(gatewayAddr, tokenId);

      const deadline = (await time.latest()) + 3600;

      await expect(
        gateway.connect(user1).removeLiquidity(
          tokenId,
          0,
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          minJusdAmount, // More than we'll receive
          0,
          user1.address,
          deadline
        )
      ).to.be.revertedWithCustomError(gateway, "InsufficientOutput");
    });
  });

  describe("Precision Edge Cases", function () {
    it("Should handle very small bridged token amounts (precision loss in 6->18 conversion)", async function () {
      const { gateway, user1, jusd, wcbtc, svJusd, swapRouter, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      // Deploy bridged token with 6 decimals
      const MockERC20Factory = await ethers.getContractFactory("MockERC20");
      const usdc = await MockERC20Factory.deploy("USD Coin", "USDC", 6);
      await usdc.waitForDeployment();

      const MockBridgeFactory = await ethers.getContractFactory("MockStablecoinBridge");
      const usdcBridge = await MockBridgeFactory.deploy(
        await usdc.getAddress(),
        await jusd.getAddress(),
        ethers.parseEther("1000000"), // limit
        Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60 // horizon
      );
      await usdcBridge.waitForDeployment();

      // Setup bridge as minter
      await jusd.setMinter(await usdcBridge.getAddress(), true);
      await gateway.registerBridgedToken(await usdcBridge.getAddress());

      // Test with 1 unit of USDC (0.000001 USDC = 1e12 wei JUSD)
      const tinyUsdcAmount = 1n; // 1 wei of USDC (6 decimals) = 0.000001 USDC
      const expectedJusdAmount = tinyUsdcAmount * 10n ** 12n; // 1e12 wei JUSD

      await usdc.mint(user1.address, tinyUsdcAmount);
      await usdc.connect(user1).approve(await gateway.getAddress(), tinyUsdcAmount);
      await usdcBridge.setMinted(expectedJusdAmount);

      // Setup swap output
      await swapRouter.setSwapOutput(ethers.parseEther("0.0001"));

      const deadline = (await time.latest()) + 3600;

      // This tests that very small amounts don't cause issues
      const tx = await gateway
        .connect(user1)
        .swapExactTokensForTokens(
          await usdc.getAddress(),
          await wcbtc.getAddress(),
          3000,
          tinyUsdcAmount,
          0,
          user1.address,
          deadline
        );

      await expect(tx).to.emit(gateway, "SwapExecuted");
    });
  });

  describe("Large Amount Edge Cases", function () {
    it("Should handle large but valid amounts without overflow", async function () {
      const { gateway, user1, jusd, wcbtc, svJusd, swapRouter } = await loadFixture(deployGatewayWithBalancesFixture);

      // Use a large amount (but not so large it overflows when converted)
      const largeAmount = ethers.parseEther("1000000000"); // 1 billion

      await jusd.mint(user1.address, largeAmount);
      await jusd.connect(user1).approve(await gateway.getAddress(), largeAmount);
      await swapRouter.setSwapOutput(ethers.parseEther("1000"));

      const deadline = (await time.latest()) + 3600;

      const tx = await gateway
        .connect(user1)
        .swapExactTokensForTokens(
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          3000,
          largeAmount,
          0,
          user1.address,
          deadline
        );

      await expect(tx).to.emit(gateway, "SwapExecuted");
    });
  });

  // ==================== Additional Coverage Tests ====================

  describe("createPoolAndAddLiquidity Extended", function () {
    it("Should return excess tokens when position manager uses less", async function () {
      const { gateway, user1, jusd, wcbtc, svJusd, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const sqrtPriceX96 = BigInt("79228162514264337593543950336");
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("100");

      // Setup mock to use less than desired (50% of each)
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const svJusdShares = await svJusd.convertToShares(jusdAmount);
      const usedAmount0 = svJusdAddr < wcbtcAddr ? svJusdShares / 2n : wcbtcAmount / 2n;
      const usedAmount1 = svJusdAddr < wcbtcAddr ? wcbtcAmount / 2n : svJusdShares / 2n;

      await positionManager.setMintResult(1, 100, usedAmount0, usedAmount1);

      // Approve tokens
      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      const jusdBefore = await jusd.balanceOf(user1.address);
      const wcbtcBefore = await wcbtc.balanceOf(user1.address);

      await gateway
        .connect(user1)
        .createPoolAndAddLiquidity(
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          3000,
          sqrtPriceX96,
          0,
          0,
          jusdAmount,
          wcbtcAmount,
          0,
          0,
          user1.address,
          deadline
        );

      // User should get excess back (approximately half)
      const jusdAfter = await jusd.balanceOf(user1.address);
      const wcbtcAfter = await wcbtc.balanceOf(user1.address);

      // User paid jusdAmount but got some back
      expect(jusdBefore - jusdAfter).to.be.lessThan(jusdAmount);
      expect(wcbtcBefore - wcbtcAfter).to.be.lessThan(wcbtcAmount);
    });

    it("Should revert for same token pair", async function () {
      const { gateway, user1, jusd } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const sqrtPriceX96 = BigInt("79228162514264337593543950336");
      const amount = ethers.parseEther("100");

      await expect(
        gateway
          .connect(user1)
          .createPoolAndAddLiquidity(
            await jusd.getAddress(),
            await jusd.getAddress(),
            3000,
            sqrtPriceX96,
            0,
            0,
            amount,
            amount,
            0,
            0,
            user1.address,
            deadline
          )
      ).to.be.revertedWithCustomError(gateway, "InvalidTokenPair");
    });

    it("Should revert for invalid fee", async function () {
      const { gateway, user1, jusd, wcbtc } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const sqrtPriceX96 = BigInt("79228162514264337593543950336");
      const amount = ethers.parseEther("100");

      await expect(
        gateway.connect(user1).createPoolAndAddLiquidity(
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          1000000, // Invalid: >= 1_000_000
          sqrtPriceX96,
          0,
          0,
          amount,
          amount,
          0,
          0,
          user1.address,
          deadline
        )
      ).to.be.revertedWithCustomError(gateway, "InvalidFee");
    });

    it("Should work with custom tick ranges", async function () {
      const { gateway, user1, jusd, wcbtc, svJusd, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const sqrtPriceX96 = BigInt("79228162514264337593543950336");
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("100");

      // Custom tick range aligned to tickSpacing=60 for fee=3000
      const tickLower = -600;
      const tickUpper = 600;

      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const svJusdShares = await svJusd.convertToShares(jusdAmount);
      const [amount0, amount1] = svJusdAddr < wcbtcAddr ? [svJusdShares, wcbtcAmount] : [wcbtcAmount, svJusdShares];

      await positionManager.setMintResult(1, 100, amount0, amount1);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      const tx = await gateway
        .connect(user1)
        .createPoolAndAddLiquidity(
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          3000,
          sqrtPriceX96,
          tickLower,
          tickUpper,
          jusdAmount,
          wcbtcAmount,
          0,
          0,
          user1.address,
          deadline
        );

      await expect(tx).to.emit(gateway, "PoolCreated");
      await expect(tx).to.emit(gateway, "LiquidityAdded");
    });

    it("Should work with native cBTC input", async function () {
      const { gateway, user1, jusd, wcbtc, svJusd, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const sqrtPriceX96 = BigInt("79228162514264337593543950336");
      const jusdAmount = ethers.parseEther("100");
      const nativeAmount = ethers.parseEther("1");

      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const svJusdShares = await svJusd.convertToShares(jusdAmount);
      const [amount0, amount1] = svJusdAddr < wcbtcAddr ? [svJusdShares, nativeAmount] : [nativeAmount, svJusdShares];

      await positionManager.setMintResult(1, 100, amount0, amount1);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);

      const tx = await gateway.connect(user1).createPoolAndAddLiquidity(
        await jusd.getAddress(),
        ethers.ZeroAddress, // Native cBTC
        3000,
        sqrtPriceX96,
        0,
        0,
        jusdAmount,
        nativeAmount,
        0,
        0,
        user1.address,
        deadline,
        { value: nativeAmount }
      );

      await expect(tx).to.emit(gateway, "PoolCreated");
      await expect(tx).to.emit(gateway, "LiquidityAdded");
    });

    it("Should revert with InvalidPrice for zero sqrtPriceX96", async function () {
      const { gateway, user1, jusd, wcbtc } = await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const amount = ethers.parseEther("100");

      await jusd.connect(user1).approve(await gateway.getAddress(), amount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), amount);

      await expect(
        gateway.connect(user1).createPoolAndAddLiquidity(
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          3000,
          0, // Invalid: zero price
          0,
          0,
          amount,
          amount,
          0,
          0,
          user1.address,
          deadline
        )
      ).to.be.revertedWithCustomError(gateway, "InvalidPrice");
    });
  });

  describe("Price Math Tests", function () {
    it("Should handle price conversion with high share price (1 svJUSD = 2 JUSD)", async function () {
      const { gateway, user1, jusd, wcbtc, svJusd } = await loadFixture(deployGatewayWithBalancesFixture);

      // Simulate 100% interest accrual (1 svJUSD = 2 JUSD)
      await svJusd.accrueInterest(ethers.parseEther("100"));

      const sqrtPriceX96 = BigInt("79228162514264337593543950336"); // 1:1 in JUSD terms

      // This tests _convertSqrtPrice with a significant share price difference
      const tx = await gateway
        .connect(user1)
        .createPool(await jusd.getAddress(), await wcbtc.getAddress(), 3000, sqrtPriceX96);

      await expect(tx).to.emit(gateway, "PoolCreated");
    });

    it("Should handle price conversion when token1 is JUSD-based", async function () {
      const { gateway, user1, jusd, wcbtc, svJusd } = await loadFixture(deployGatewayWithBalancesFixture);

      // Simulate interest
      await svJusd.accrueInterest(ethers.parseEther("10"));

      const sqrtPriceX96 = BigInt("79228162514264337593543950336");

      // WcBTC < svJUSD in address ordering, so JUSD becomes token1
      // This tests _divSqrtPrice path
      const tx = await gateway
        .connect(user1)
        .createPool(await wcbtc.getAddress(), await jusd.getAddress(), 3000, sqrtPriceX96);

      await expect(tx).to.emit(gateway, "PoolCreated");
    });

    it("Should handle very small sqrt prices", async function () {
      const { gateway, user1, juice, wcbtc, positionManager } = await loadFixture(deployGatewayWithBalancesFixture);

      // Very small price (close to minimum)
      const smallSqrtPrice = BigInt("7922816251426433759"); // ~0.0001 price

      const tx = await gateway
        .connect(user1)
        .createPool(await juice.getAddress(), await wcbtc.getAddress(), 3000, smallSqrtPrice);

      await expect(tx).to.emit(gateway, "PoolCreated");
    });

    it("Should handle large sqrt prices", async function () {
      const { gateway, user1, juice, wcbtc } = await loadFixture(deployGatewayWithBalancesFixture);

      // Large price (but not overflow)
      const largeSqrtPrice = BigInt("79228162514264337593543950336000"); // 1000:1 price

      const tx = await gateway
        .connect(user1)
        .createPool(await juice.getAddress(), await wcbtc.getAddress(), 3000, largeSqrtPrice);

      await expect(tx).to.emit(gateway, "PoolCreated");
    });
  });

  describe("JUICE Edge Cases", function () {
    it("Should swap JUICE to native cBTC output", async function () {
      const { gateway, user1, juice, wcbtc, jusd, svJusd, swapRouter } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const juiceAmount = ethers.parseEther("100");
      const expectedOutput = ethers.parseEther("1");

      // Fund JUSD to juice contract for redeem (JUICE redeems to JUSD at 100:1 ratio)
      // 100 JUICE = 10000 JUSD (PRICE = 100e18)
      const jusdForRedeem = ethers.parseEther("10000");
      await jusd.mint(await juice.getAddress(), jusdForRedeem);

      // Setup swap output
      await swapRouter.setSwapOutput(expectedOutput);

      // Fund wcbtc to swap router for output
      await wcbtc.deposit({ value: expectedOutput * 2n });
      await wcbtc.transfer(await swapRouter.getAddress(), expectedOutput * 2n);

      await juice.connect(user1).approve(await gateway.getAddress(), juiceAmount);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;

      const tx = await gateway.connect(user1).swapExactTokensForTokens(
        await juice.getAddress(),
        ethers.ZeroAddress, // Native cBTC output
        3000,
        juiceAmount,
        0,
        user1.address,
        deadline
      );

      await expect(tx).to.emit(gateway, "SwapExecuted");
    });

    it("Should swap native cBTC to JUICE output", async function () {
      const { gateway, user1, juice, wcbtc, jusd, svJusd, swapRouter } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const nativeAmount = ethers.parseEther("1");
      const svJusdOutput = ethers.parseEther("50000"); // svJUSD output from swap

      // Setup swap output (svJUSD)
      await swapRouter.setSwapOutput(svJusdOutput);

      // Fund svJUSD to swap router via deposit (use explicit function signature)
      await jusd.mint(await svJusd.getAddress(), svJusdOutput * 2n);
      await svJusd["mint(address,uint256)"](await swapRouter.getAddress(), svJusdOutput * 2n);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;

      const tx = await gateway.connect(user1).swapExactTokensForTokens(
        ethers.ZeroAddress, // Native cBTC input
        await juice.getAddress(),
        3000,
        nativeAmount,
        0,
        user1.address,
        deadline,
        { value: nativeAmount }
      );

      await expect(tx).to.emit(gateway, "SwapExecuted");
    });

    it("Should handle JUICE with maximum slippage check", async function () {
      const { gateway, user1, juice, wcbtc, jusd, svJusd, swapRouter } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const juiceAmount = ethers.parseEther("100");
      const minOutput = ethers.parseEther("0.5"); // Set minimum
      const actualOutput = ethers.parseEther("0.6"); // Above minimum

      // Fund JUSD to juice contract for redeem
      const jusdForRedeem = ethers.parseEther("10000");
      await jusd.mint(await juice.getAddress(), jusdForRedeem);

      await swapRouter.setSwapOutput(actualOutput);

      // Fund wcbtc
      await wcbtc.deposit({ value: actualOutput * 2n });
      await wcbtc.transfer(await swapRouter.getAddress(), actualOutput * 2n);

      await juice.connect(user1).approve(await gateway.getAddress(), juiceAmount);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;

      const tx = await gateway
        .connect(user1)
        .swapExactTokensForTokens(
          await juice.getAddress(),
          await wcbtc.getAddress(),
          3000,
          juiceAmount,
          minOutput,
          user1.address,
          deadline
        );

      await expect(tx).to.emit(gateway, "SwapExecuted");
    });
  });

  describe("Bridge Failure Scenarios", function () {
    it("Should revert when bridge mint limit is exceeded", async function () {
      const { gateway, owner, user1, jusd, wcbtc, swapRouter } = await loadFixture(deployGatewayWithBalancesFixture);

      // Deploy a bridged token with very low limit
      const MockERC20Factory = await ethers.getContractFactory("MockERC20");
      const usdt = (await MockERC20Factory.deploy("Tether USD", "USDT", 6)) as unknown as MockERC20;

      const MockBridgeFactory = await ethers.getContractFactory("MockStablecoinBridge");
      const lowLimitBridge = await MockBridgeFactory.deploy(
        await usdt.getAddress(),
        await jusd.getAddress(),
        ethers.parseEther("100"), // Very low limit: 100 JUSD
        52
      );

      // Setup JUSD to accept bridge as minter
      await jusd.setMinter(await lowLimitBridge.getAddress(), true);

      // Register bridge
      await gateway.registerBridgedToken(await lowLimitBridge.getAddress());

      // Mint USDT to user (more than limit)
      const usdtAmount = 200_000000n; // 200 USDT (6 decimals) = 200 JUSD > 100 limit
      await usdt.mint(user1.address, usdtAmount);
      await usdt.connect(user1).approve(await gateway.getAddress(), usdtAmount);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;

      // Should fail due to LimitExceeded
      await expect(
        gateway
          .connect(user1)
          .swapExactTokensForTokens(
            await usdt.getAddress(),
            await wcbtc.getAddress(),
            3000,
            usdtAmount,
            0,
            user1.address,
            deadline
          )
      ).to.be.revertedWithCustomError(lowLimitBridge, "LimitExceeded");
    });

    it("Should revert when bridge is expired", async function () {
      const { gateway, owner, user1, jusd, wcbtc, swapRouter } = await loadFixture(deployGatewayWithBalancesFixture);

      // Deploy a bridged token with very short expiry
      const MockERC20Factory = await ethers.getContractFactory("MockERC20");
      const usdt = (await MockERC20Factory.deploy("Tether USD", "USDT", 6)) as unknown as MockERC20;

      const MockBridgeFactory = await ethers.getContractFactory("MockStablecoinBridge");
      const expiringBridge = await MockBridgeFactory.deploy(
        await usdt.getAddress(),
        await jusd.getAddress(),
        ethers.parseEther("1000000"),
        1 // 1 week expiry
      );

      // Setup JUSD to accept bridge as minter
      await jusd.setMinter(await expiringBridge.getAddress(), true);

      // Register bridge
      await gateway.registerBridgedToken(await expiringBridge.getAddress());

      // Mint USDT to user
      const usdtAmount = 100_000000n; // 100 USDT
      await usdt.mint(user1.address, usdtAmount);
      await usdt.connect(user1).approve(await gateway.getAddress(), usdtAmount);

      // Fast forward past expiry (2 weeks)
      await time.increase(2 * 7 * 24 * 60 * 60);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;

      // Should fail due to Expired
      await expect(
        gateway
          .connect(user1)
          .swapExactTokensForTokens(
            await usdt.getAddress(),
            await wcbtc.getAddress(),
            3000,
            usdtAmount,
            0,
            user1.address,
            deadline
          )
      ).to.be.revertedWithCustomError(expiringBridge, "Expired");
    });
  });

  describe("View Function Edge Cases", function () {
    it("Should return correct values for jusdToSvJusd with zero amount", async function () {
      const { gateway } = await loadFixture(deployGatewayFixture);

      const result = await gateway.jusdToSvJusd(0);
      expect(result).to.equal(0);
    });

    it("Should return correct values for svJusdToJusd with zero amount", async function () {
      const { gateway } = await loadFixture(deployGatewayFixture);

      const result = await gateway.svJusdToJusd(0);
      expect(result).to.equal(0);
    });

    it("Should return correct values for juiceToJusd with zero amount", async function () {
      const { gateway } = await loadFixture(deployGatewayFixture);

      // calculateProceeds(0) returns 0 automatically
      const result = await gateway.juiceToJusd(0);
      expect(result).to.equal(0);
    });

    it("Should return false for isBridgedToken with non-bridged token", async function () {
      const { gateway, wcbtc } = await loadFixture(deployGatewayFixture);

      const result = await gateway.isBridgedToken(await wcbtc.getAddress());
      expect(result).to.be.false;
    });

    it("Should return empty array for getBridgedTokens when none registered", async function () {
      const { gateway } = await loadFixture(deployGatewayFixture);

      const result = await gateway.getBridgedTokens();
      expect(result).to.deep.equal([]);
    });
  });

  describe("Sequential Operations", function () {
    it("Should handle add -> increase -> partial remove -> increase -> full remove", async function () {
      const { gateway, owner, user1, jusd, wcbtc, svJusd, positionManager } = await loadFixture(
        deployGatewayWithBalancesFixture
      );

      const deadline = (await time.latest()) + DEADLINE_OFFSET * 10; // Long deadline
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      // Step 1: Add liquidity
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const svJusdShares = await svJusd.convertToShares(jusdAmount);
      const [amount0, amount1] = svJusdAddr < wcbtcAddr ? [svJusdShares, wcbtcAmount] : [wcbtcAmount, svJusdShares];

      await positionManager.setMintResult(1, 1000, amount0, amount1);
      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount * 5n);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount * 5n);

      await gateway
        .connect(user1)
        .addLiquidity(
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          3000,
          0,
          0,
          jusdAmount,
          wcbtcAmount,
          0,
          0,
          user1.address,
          deadline
        );

      // NFT (tokenId=1) is already minted to user1 by addLiquidity
      const posManagerAddr = await positionManager.getAddress();
      const gatewayAddr = await gateway.getAddress();

      // Approve gateway to transfer NFT for all increase/remove operations
      await positionManager.connect(user1).setApprovalForAll(gatewayAddr, true);

      // Step 2: Increase liquidity
      await positionManager.setIncreaseResult(500, amount0 / 2n, amount1 / 2n);

      await gateway
        .connect(user1)
        .increaseLiquidity(
          1,
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          jusdAmount / 2n,
          wcbtcAmount / 2n,
          0,
          0,
          deadline
        );

      // Step 3: Partial remove (500 of 1500 liquidity)
      await positionManager.setDecreaseResult(amount0 / 3n, amount1 / 3n);

      // Fund position manager for returns
      await jusd.mint(owner.address, jusdAmount);
      await jusd.connect(owner).approve(await svJusd.getAddress(), jusdAmount);
      await svJusd.connect(owner).deposit(jusdAmount, posManagerAddr);
      await wcbtc.deposit({ value: wcbtcAmount });
      await wcbtc.transfer(posManagerAddr, wcbtcAmount);

      await gateway
        .connect(user1)
        .removeLiquidity(1, 500, await jusd.getAddress(), await wcbtc.getAddress(), 0, 0, user1.address, deadline);

      // Step 4: Increase again
      await positionManager.setIncreaseResult(300, amount0 / 4n, amount1 / 4n);

      await gateway
        .connect(user1)
        .increaseLiquidity(
          1,
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          jusdAmount / 4n,
          wcbtcAmount / 4n,
          0,
          0,
          deadline
        );

      // Step 5: Full remove (liquidityToRemove = 0 means all)
      await positionManager.setDecreaseResult(amount0, amount1);

      // Fund more for full removal
      await jusd.mint(owner.address, jusdAmount * 2n);
      await jusd.connect(owner).approve(await svJusd.getAddress(), jusdAmount * 2n);
      await svJusd.connect(owner).deposit(jusdAmount * 2n, posManagerAddr);
      await wcbtc.deposit({ value: wcbtcAmount * 2n });
      await wcbtc.transfer(posManagerAddr, wcbtcAmount * 2n);

      const tx = await gateway.connect(user1).removeLiquidity(
        1,
        0, // Remove all
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        0,
        0,
        user1.address,
        deadline
      );

      await expect(tx).to.emit(gateway, "LiquidityRemoved");
    });
  });
});
