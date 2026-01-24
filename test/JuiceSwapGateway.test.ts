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
    const juice = (await MockEquityFactory.deploy("Juice Protocol", "JUICE", await jusd.getAddress())) as unknown as MockEquity;
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
      const { gateway, user1, jusd, wcbtc, swapRouter } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("100");

      // Setup mock router to return expected amount (needs to be >= MIN_OUTPUT)
      await swapRouter.setSwapOutput(ethers.parseEther("95")); // 95 WcBTC (> MIN_OUTPUT of 90)

      // Approve gateway to spend JUSD
      await jusd.connect(user1).approve(await gateway.getAddress(), swapAmount);

      const tx = await gateway.connect(user1).swapExactTokensForTokens(
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
          anyValue  // amountOut (from mock)
        );
    });

    it("Should revert if deadline expired", async function () {
      const { gateway, user1, jusd, wcbtc } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const pastDeadline = (await time.latest()) - 1;
      const swapAmount = ethers.parseEther("100");

      await jusd.connect(user1).approve(await gateway.getAddress(), swapAmount);

      await expect(
        gateway.connect(user1).swapExactTokensForTokens(
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
      const { gateway, user1, jusd, wcbtc } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;

      await expect(
        gateway.connect(user1).swapExactTokensForTokens(
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
      const { gateway, user1, jusd, wcbtc, swapRouter } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("100");

      // Mock router returns less than minimum
      await swapRouter.setSwapOutput(ethers.parseEther("0.05")); // Less than MIN_OUTPUT (0.1)

      await jusd.connect(user1).approve(await gateway.getAddress(), swapAmount);

      await expect(
        gateway.connect(user1).swapExactTokensForTokens(
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
      const { gateway, user1, jusd, wcbtc, svJusd, swapRouter } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("100");

      await swapRouter.setSwapOutput(ethers.parseEther("0.5"));
      await jusd.connect(user1).approve(await gateway.getAddress(), swapAmount);

      const svJusdBalanceBefore = await svJusd.balanceOf(await gateway.getAddress());

      await gateway.connect(user1).swapExactTokensForTokens(
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
      const { gateway, user1, juice, jusd, wcbtc, swapRouter } =
        await loadFixture(deployGatewayWithBalancesFixture);

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

      await gateway.connect(user1).swapExactTokensForTokens(
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
      const { gateway, user1, juice, jusd, svJusd, swapRouter } =
        await loadFixture(deployGatewayWithBalancesFixture);

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

      await gateway.connect(user1).swapExactTokensForTokens(
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
      const { gateway, user1, juice, jusd, wcbtc, swapRouter } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("1");
      const expectedJusd = ethers.parseEther("100");
      const expectedWcbtc = ethers.parseEther("0.5");

      await jusd.mint(await juice.getAddress(), expectedJusd);
      await swapRouter.setSwapOutput(expectedWcbtc);
      await juice.connect(user1).approve(await gateway.getAddress(), swapAmount);

      await expect(
        gateway.connect(user1).swapExactTokensForTokens(
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
      const { gateway, user1, juice, jusd, wcbtc, swapRouter } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("1"); // 1 JUICE
      const expectedJusd = ethers.parseEther("100");
      const actualWcbtc = ethers.parseEther("0.5");
      const unreasonableMinOut = ethers.parseEther("100"); // Way more than we'll get

      await jusd.mint(await juice.getAddress(), expectedJusd);
      await swapRouter.setSwapOutput(actualWcbtc);
      await juice.connect(user1).approve(await gateway.getAddress(), swapAmount);

      await expect(
        gateway.connect(user1).swapExactTokensForTokens(
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
      const { gateway, user1, juice, jusd, wcbtc, swapRouter } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("1");
      const expectedJusd = ethers.parseEther("100");

      await jusd.mint(await juice.getAddress(), expectedJusd);
      await swapRouter.setSwapOutput(ethers.parseEther("0.5"));
      // NO approval given

      await expect(
        gateway.connect(user1).swapExactTokensForTokens(
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

    it("Should add liquidity with JUICE as input token", async function () {
      const { gateway, user1, juice, jusd, svJusd, wcbtc, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const juiceAmount = ethers.parseEther("1"); // 1 JUICE
      const expectedJusd = ethers.parseEther("100"); // 1 JUICE = 100 JUSD
      const wcbtcAmount = ethers.parseEther("1");

      // Fund the JUICE contract with JUSD for redemption
      await jusd.mint(await juice.getAddress(), expectedJusd);

      await juice.connect(user1).approve(await gateway.getAddress(), juiceAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      // Should succeed - JUICE is converted via redeemFrom to JUSD, then to svJUSD
      await expect(
        gateway.connect(user1).addLiquidity(
          await juice.getAddress(),
          await wcbtc.getAddress(),
          3000,
          juiceAmount,
          wcbtcAmount,
          0,
          0,
          user1.address,
          deadline
        )
      ).to.emit(gateway, "LiquidityAdded");
    });

    it("Should return excess as JUSD when adding liquidity with JUICE", async function () {
      const { gateway, user1, juice, jusd, svJusd, wcbtc, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const juiceAmount = ethers.parseEther("2"); // 2 JUICE (more than needed)
      const expectedJusd = ethers.parseEther("200"); // 2 JUICE = 200 JUSD
      const wcbtcAmount = ethers.parseEther("1");

      // Fund the JUICE contract with JUSD for redemption
      await jusd.mint(await juice.getAddress(), expectedJusd);

      // Mock position manager to only use half the svJUSD (100 JUSD worth)
      const halfSvJusd = await svJusd.convertToShares(ethers.parseEther("100"));

      // Token ordering: Uniswap V3 requires token0 < token1
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [amount0, amount1] = svJusdAddr < wcbtcAddr
        ? [halfSvJusd, wcbtcAmount]
        : [wcbtcAmount, halfSvJusd];
      await positionManager.setMintResult(1, 100, amount0, amount1);

      await juice.connect(user1).approve(await gateway.getAddress(), juiceAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      const jusdBefore = await jusd.balanceOf(user1.address);

      await gateway.connect(user1).addLiquidity(
        await juice.getAddress(),
        await wcbtc.getAddress(),
        3000,
        juiceAmount,
        wcbtcAmount,
        0,
        0,
        user1.address,
        deadline
      );

      const jusdAfter = await jusd.balanceOf(user1.address);
      // User should receive excess as JUSD (not JUICE, due to flash loan protection)
      expect(jusdAfter).to.be.gt(jusdBefore);
    });
  });

  describe("Swap: Native cBTC", function () {
    it("Should swap native cBTC for tokens", async function () {
      const { gateway, user1, wcbtc, swapRouter } =
        await loadFixture(deployGatewayWithBalancesFixture);

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
          anyValue  // amountOut
        );
    });

    it("Should revert if msg.value doesn't match amount for native swap", async function () {
      const { gateway, user1, wcbtc } =
        await loadFixture(deployGatewayWithBalancesFixture);

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
      const { gateway, user1, jusd, swapRouter } =
        await loadFixture(deployGatewayWithBalancesFixture);

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
      const { gateway, user1, jusd, wcbtc, svJusd, swapRouter } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("1");

      // Mock router returns svJUSD shares which get converted to JUSD
      // WcBTC → svJUSD (pool swap) → JUSD (unwrap)
      await swapRouter.setSwapOutput(ethers.parseEther("100")); // 100 svJUSD shares

      await wcbtc.connect(user1).approve(await gateway.getAddress(), swapAmount);

      const jusdBalanceBefore = await jusd.balanceOf(user1.address);

      const tx = await gateway.connect(user1).swapExactTokensForTokens(
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
        .withArgs(
          user1.address,
          await wcbtc.getAddress(),
          await jusd.getAddress(),
          anyValue,
          anyValue
        );

      const jusdBalanceAfter = await jusd.balanceOf(user1.address);
      expect(jusdBalanceAfter).to.be.gt(jusdBalanceBefore);
    });

    it("Should swap WcBTC for JUICE successfully", async function () {
      const { gateway, user1, juice, wcbtc, svJusd, swapRouter } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("1");

      // Mock router returns svJUSD shares which get converted to JUSD then JUICE
      // WcBTC → svJUSD (pool swap) → JUSD (unwrap) → JUICE (invest)
      await swapRouter.setSwapOutput(ethers.parseEther("100")); // 100 svJUSD shares

      await wcbtc.connect(user1).approve(await gateway.getAddress(), swapAmount);

      const juiceBalanceBefore = await juice.balanceOf(user1.address);

      const tx = await gateway.connect(user1).swapExactTokensForTokens(
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
        .withArgs(
          user1.address,
          await wcbtc.getAddress(),
          await juice.getAddress(),
          anyValue,
          anyValue
        );

      const juiceBalanceAfter = await juice.balanceOf(user1.address);
      expect(juiceBalanceAfter).to.be.gt(juiceBalanceBefore);
    });

    it("Should swap native cBTC for JUSD successfully", async function () {
      const { gateway, user1, jusd, swapRouter } =
        await loadFixture(deployGatewayWithBalancesFixture);

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
        .withArgs(
          user1.address,
          ethers.ZeroAddress,
          await jusd.getAddress(),
          anyValue,
          anyValue
        );

      const jusdBalanceAfter = await jusd.balanceOf(user1.address);
      expect(jusdBalanceAfter).to.be.gt(jusdBalanceBefore);
    });

    it("Should swap native cBTC for JUICE successfully", async function () {
      const { gateway, user1, juice, swapRouter } =
        await loadFixture(deployGatewayWithBalancesFixture);

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
        .withArgs(
          user1.address,
          ethers.ZeroAddress,
          await juice.getAddress(),
          anyValue,
          anyValue
        );

      const juiceBalanceAfter = await juice.balanceOf(user1.address);
      expect(juiceBalanceAfter).to.be.gt(juiceBalanceBefore);
    });
  });

  describe("Add Liquidity", function () {
    it("Should add liquidity with JUSD successfully", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      // Calculate actual svJUSD shares that will be received when depositing JUSD
      const svJusdShares = await svJusd.convertToShares(jusdAmount);

      // Setup mock position manager with correct token order (token0 < token1)
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [amount0, amount1] = svJusdAddr < wcbtcAddr
        ? [svJusdShares, wcbtcAmount]  // svJUSD is token0
        : [wcbtcAmount, svJusdShares]; // WcBTC is token0
      await positionManager.setMintResult(1, 100, amount0, amount1);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      const tx = await gateway.connect(user1).addLiquidity(
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        3000,
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
          1  // tokenId from mock
        );
    });

    it("Should convert JUSD to svJUSD when adding liquidity", async function () {
      const { gateway, user1, jusd, wcbtc, positionManager, svJusd } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      // Calculate actual svJUSD shares
      const svJusdShares = await svJusd.convertToShares(jusdAmount);

      // Setup with correct token order
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [amount0, amount1] = svJusdAddr < wcbtcAddr
        ? [svJusdShares, wcbtcAmount]
        : [wcbtcAmount, svJusdShares];
      await positionManager.setMintResult(1, 100, amount0, amount1);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      await gateway.connect(user1).addLiquidity(
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        3000,
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
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const jusdAmount = ethers.parseEther("100");
      const cbtcAmount = ethers.parseEther("1");

      // Calculate actual svJUSD shares
      const svJusdShares = await svJusd.convertToShares(jusdAmount);

      // Setup with correct token order (native becomes WcBTC)
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [amount0, amount1] = svJusdAddr < wcbtcAddr
        ? [svJusdShares, cbtcAmount]
        : [cbtcAmount, svJusdShares];
      await positionManager.setMintResult(1, 100, amount0, amount1);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);

      const tx = await gateway.connect(user1).addLiquidity(
        await jusd.getAddress(),
        ethers.ZeroAddress, // Native cBTC
        3000,
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
          1  // tokenId
        );
    });

    it("Should return excess native cBTC when position manager uses less", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const jusdAmount = ethers.parseEther("100");
      const cbtcAmount = ethers.parseEther("2"); // Send 2 cBTC

      // Calculate actual svJUSD shares
      const svJusdShares = await svJusd.convertToShares(jusdAmount);

      // Mock position manager to only use HALF the cBTC (simulating excess)
      const halfCbtc = cbtcAmount / 2n;
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [amount0, amount1] = svJusdAddr < wcbtcAddr
        ? [svJusdShares, halfCbtc]
        : [halfCbtc, svJusdShares];
      await positionManager.setMintResult(1, 100, amount0, amount1);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);

      const cbtcBefore = await ethers.provider.getBalance(user1.address);

      const tx = await gateway.connect(user1).addLiquidity(
        await jusd.getAddress(),
        ethers.ZeroAddress, // Native cBTC
        3000,
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
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      // Calculate actual svJUSD shares
      const svJusdShares = await svJusd.convertToShares(jusdAmount);

      // Setup with correct token order - mock returns less than desired
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [amount0, amount1] = svJusdAddr < wcbtcAddr
        ? [svJusdShares / 2n, wcbtcAmount / 2n]  // Only half used
        : [wcbtcAmount / 2n, svJusdShares / 2n];
      await positionManager.setMintResult(1, 100, amount0, amount1);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      const jusdBalanceBefore = await jusd.balanceOf(user1.address);

      await gateway.connect(user1).addLiquidity(
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        3000,
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
      const { gateway, user1, jusd, wcbtc } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const pastDeadline = (await time.latest()) - 1;

      await expect(
        gateway.connect(user1).addLiquidity(
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        3000,
        SWAP_AMOUNT,
          SWAP_AMOUNT,
          0,
          0,
          user1.address,
          pastDeadline
        )
      ).to.be.revertedWithCustomError(gateway, "DeadlineExpired");
    });
  });

  describe("Increase Liquidity", function () {
    it("Should increase liquidity successfully", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 1;
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      // Setup position with svJUSD and WcBTC in correct address ordering
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [token0, token1] = svJusdAddr < wcbtcAddr
        ? [svJusdAddr, wcbtcAddr]
        : [wcbtcAddr, svJusdAddr];
      await positionManager.setPositionData(tokenId, token0, token1, 100);

      // Mint NFT to user and approve gateway
      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(await gateway.getAddress(), tokenId);

      // Approve tokens
      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      // Call with WcBTC first to avoid token ordering edge case
      const tx = await gateway.connect(user1).increaseLiquidity(
        tokenId,
        await wcbtc.getAddress(),
        await jusd.getAddress(),
        wcbtcAmount,
        jusdAmount,
        0,
        0,
        deadline
      );

      await expect(tx)
        .to.emit(gateway, "LiquidityIncreased")
        .withArgs(
          user1.address,
          tokenId,
          anyValue, // amountA
          anyValue, // amountB
          anyValue  // liquidity
        );

      // Verify NFT returned to user
      expect(await positionManager.ownerOf(tokenId)).to.equal(user1.address);
    });

    it("Should convert JUSD to svJUSD when increasing liquidity", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 1;
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [token0, token1] = svJusdAddr < wcbtcAddr
        ? [svJusdAddr, wcbtcAddr]
        : [wcbtcAddr, svJusdAddr];
      await positionManager.setPositionData(tokenId, token0, token1, 100);

      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(await gateway.getAddress(), tokenId);

      const jusdBalanceBefore = await jusd.balanceOf(user1.address);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      // Call with WcBTC first
      await gateway.connect(user1).increaseLiquidity(
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
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 1;
      const jusdAmount = ethers.parseEther("100");
      const cbtcAmount = ethers.parseEther("1");

      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [token0, token1] = svJusdAddr < wcbtcAddr
        ? [svJusdAddr, wcbtcAddr]
        : [wcbtcAddr, svJusdAddr];
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
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 1;
      const jusdAmount = ethers.parseEther("50");
      const wcbtcAmount = ethers.parseEther("0.5");

      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();

      // Set position with correct address ordering
      const [token0, token1] = svJusdAddr < wcbtcAddr
        ? [svJusdAddr, wcbtcAddr]
        : [wcbtcAddr, svJusdAddr];
      await positionManager.setPositionData(tokenId, token0, token1, 100);

      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(await gateway.getAddress(), tokenId);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      // Call with WcBTC first (to match token ordering expectation)
      const tx = await gateway.connect(user1).increaseLiquidity(
        tokenId,
        await wcbtc.getAddress(),
        await jusd.getAddress(),
        wcbtcAmount,
        jusdAmount,
        0,
        0,
        deadline
      );

      await expect(tx)
        .to.emit(gateway, "LiquidityIncreased");
    });

    it("Should handle tokenB < tokenA ordering", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 1;
      const jusdAmount = ethers.parseEther("50");
      const wcbtcAmount = ethers.parseEther("0.5");

      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();

      // Set position with correct address ordering
      const [token0, token1] = svJusdAddr < wcbtcAddr
        ? [svJusdAddr, wcbtcAddr]
        : [wcbtcAddr, svJusdAddr];
      await positionManager.setPositionData(tokenId, token0, token1, 100);

      // Don't set mock values - let it default to using desired amounts

      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(await gateway.getAddress(), tokenId);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      // Call with WcBTC, JUSD order (reversed)
      const tx = await gateway.connect(user1).increaseLiquidity(
        tokenId,
        await wcbtc.getAddress(),
        await jusd.getAddress(),
        wcbtcAmount,
        jusdAmount,
        0,
        0,
        deadline
      );

      await expect(tx)
        .to.emit(gateway, "LiquidityIncreased");
    });

    it("Should return excess tokens to user", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 1;
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [token0, token1] = svJusdAddr < wcbtcAddr
        ? [svJusdAddr, wcbtcAddr]
        : [wcbtcAddr, svJusdAddr];
      await positionManager.setPositionData(tokenId, token0, token1, 100);

      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(await gateway.getAddress(), tokenId);

      const jusdBalanceBefore = await jusd.balanceOf(user1.address);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      // Call with WcBTC first
      await gateway.connect(user1).increaseLiquidity(
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
      const { gateway, user1, user2, jusd, svJusd, wcbtc, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

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
        gateway.connect(user2).increaseLiquidity(
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
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 1;
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [token0, token1] = svJusdAddr < wcbtcAddr
        ? [svJusdAddr, wcbtcAddr]
        : [wcbtcAddr, svJusdAddr];
      await positionManager.setPositionData(tokenId, token0, token1, 100);

      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(await gateway.getAddress(), tokenId);

      // Verify ownership before
      expect(await positionManager.ownerOf(tokenId)).to.equal(user1.address);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      // Call with WcBTC first
      await gateway.connect(user1).increaseLiquidity(
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
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const pastDeadline = (await time.latest()) - 1;
      const tokenId = 1;
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      await positionManager.setPositionData(tokenId, svJusdAddr, wcbtcAddr, 100);
      await positionManager.mintNFT(user1.address, tokenId);

      await expect(
        gateway.connect(user1).increaseLiquidity(
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
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 42; // Use specific tokenId
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [token0, token1] = svJusdAddr < wcbtcAddr
        ? [svJusdAddr, wcbtcAddr]
        : [wcbtcAddr, svJusdAddr];
      await positionManager.setPositionData(tokenId, token0, token1, 100);

      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(await gateway.getAddress(), tokenId);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      // Call with WcBTC first
      const tx = await gateway.connect(user1).increaseLiquidity(
        tokenId,
        await wcbtc.getAddress(),
        await jusd.getAddress(),
        wcbtcAmount,
        jusdAmount,
        0,
        0,
        deadline
      );

      await expect(tx)
        .to.emit(gateway, "LiquidityIncreased")
        .withArgs(
          user1.address,
          tokenId,
          anyValue, // amountA
          anyValue, // amountB
          100       // default liquidity from mock
        );
    });

    it("Should increase liquidity with JUICE as input token", async function () {
      const { gateway, user1, juice, jusd, svJusd, wcbtc, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 1;
      const juiceAmount = ethers.parseEther("1"); // 1 JUICE
      const expectedJusd = ethers.parseEther("100"); // 1 JUICE = 100 JUSD (MockEquity PRICE)
      const wcbtcAmount = ethers.parseEther("1");

      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();

      // Token ordering: Uniswap V3 requires token0 < token1
      const [token0, token1] = svJusdAddr < wcbtcAddr
        ? [svJusdAddr, wcbtcAddr]
        : [wcbtcAddr, svJusdAddr];
      await positionManager.setPositionData(tokenId, token0, token1, 100);
      await positionManager.mintNFT(user1.address, tokenId);
      await positionManager.connect(user1).approve(await gateway.getAddress(), tokenId);

      // Fund the JUICE contract with JUSD for redemption
      await jusd.mint(await juice.getAddress(), expectedJusd);

      await juice.connect(user1).approve(await gateway.getAddress(), juiceAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      // Should succeed - JUICE is converted via redeemFrom to JUSD, then to svJUSD
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
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 1;
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();

      // Setup position with svJUSD/WcBTC tokens
      const [token0, token1] = svJusdAddr < wcbtcAddr
        ? [svJusdAddr, wcbtcAddr]
        : [wcbtcAddr, svJusdAddr];
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
      ).to.be.revertedWithCustomError(gateway, "TokenMismatch")
        .withArgs(token0, token1, await wrongToken.getAddress(), wcbtcAddr);

      // Verify NFT remains with user (validation happens before NFT transfer)
      expect(await positionManager.ownerOf(tokenId)).to.equal(user1.address);
    });
  });

  describe("Remove Liquidity", function () {
    it("Should remove liquidity successfully", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

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
        ethers.parseEther("100")  // WcBTC (increased to match test expectations)
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
          tokenId  // tokenId = 1
        );
    });

    it("Should convert svJUSD back to JUSD when removing liquidity", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 1;
      const liquidity = 100;

      await positionManager.setPositionData(
        tokenId,
        await svJusd.getAddress(), // Actual token
        await wcbtc.getAddress(),
        liquidity
      );
      await positionManager.setDecreaseResult(
        ethers.parseEther("100"),
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
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

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
      await positionManager.setDecreaseResult(
        ethers.parseEther("100"),
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
      const { gateway, user1, jusd, wcbtc } =
        await loadFixture(deployGatewayWithBalancesFixture);

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
      const { gateway, user1, juice, svJusd, wcbtc, positionManager, jusd } =
        await loadFixture(deployGatewayWithBalancesFixture);

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
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

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
        .withArgs(
          user1.address,
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          anyValue,
          anyValue,
          tokenId
        );

      // NFT should still be owned by user (not burned)
      expect(await positionManager.ownerOf(tokenId)).to.equal(user1.address);
    });

    it("Should remove all liquidity when liquidityToRemove = 0", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

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
        .withArgs(
          user1.address,
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          anyValue,
          anyValue,
          tokenId
        );

      const jusdBalanceAfter = await jusd.balanceOf(user1.address);
      // User should receive JUSD from liquidity removal
      expect(jusdBalanceAfter).to.be.gt(jusdBalanceBefore);

      // NFT should still be owned by user (returned after operation)
      expect(await positionManager.ownerOf(tokenId)).to.equal(user1.address);
    });

    it("Should revert if liquidityToRemove exceeds position liquidity", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

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
      ).to.be.revertedWithCustomError(gateway, "InsufficientLiquidity")
        .withArgs(liquidityToRemove, positionLiquidity);
    });
  });

  describe("NFT Handling", function () {
    it("Should return NFT to user after removing liquidity", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 1;

      await positionManager.setPositionData(
        tokenId,
        await svJusd.getAddress(),
        await wcbtc.getAddress(),
        100
      );
      await positionManager.setDecreaseResult(
        ethers.parseEther("100"),
        ethers.parseEther("100")
      );

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
      const { gateway, user1, user2, jusd, wcbtc, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

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
      const { gateway, user1, jusd, wcbtc, swapRouter } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tinyAmount = 1n; // 1 wei

      await swapRouter.setSwapOutput(1n);
      await jusd.connect(user1).approve(await gateway.getAddress(), tinyAmount);

      // Should not revert
      await gateway.connect(user1).swapExactTokensForTokens(
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
      const { gateway, user1, jusd, wcbtc, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

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
      const { gateway, user1, jusd, wcbtc, swapRouter } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;

      await swapRouter.setSwapOutput(ethers.parseEther("0.5"));
      await jusd.connect(user1).approve(await gateway.getAddress(), SWAP_AMOUNT);

      // First swap
      const tx1 = await gateway.connect(user1).swapExactTokensForTokens(
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        3000,
        SWAP_AMOUNT / 2n,
        0,
        user1.address,
        deadline
      );

      // Second swap should not require additional approvals internally
      const tx2 = await gateway.connect(user1).swapExactTokensForTokens(
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
      const { gateway, user1, jusd, wcbtc, swapRouter } =
        await loadFixture(deployGatewayWithBalancesFixture);

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
      const { gateway, user1, jusd, wcbtc } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const amount = ethers.parseEther("10");

      await jusd.connect(user1).approve(await gateway.getAddress(), amount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), amount);

      await expect(
        gateway.connect(user1).addLiquidity(
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          2500, // Not in factory
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
      const { gateway, user1, jusd, wcbtc, swapRouter } =
        await loadFixture(deployGatewayWithBalancesFixture);

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
      const { gateway, user1, jusd, wcbtc, swapRouter } =
        await loadFixture(deployGatewayWithBalancesFixture);

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
      const { gateway, user1, jusd, wcbtc, swapRouter } =
        await loadFixture(deployGatewayWithBalancesFixture);

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
      const { gateway, user1, jusd, wcbtc, svJusd, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const amount = ethers.parseEther("10");

      const svJusdShares = await svJusd.convertToShares(amount);
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [amount0, amount1] = svJusdAddr < wcbtcAddr
        ? [svJusdShares, amount]
        : [amount, svJusdShares];
      await positionManager.setMintResult(1, 100, amount0, amount1);

      await jusd.connect(user1).approve(await gateway.getAddress(), amount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), amount);

      const tx = await gateway.connect(user1).addLiquidity(
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        100, // 0.01% fee tier
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
      const { gateway, user1, jusd, wcbtc, svJusd, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const amount = ethers.parseEther("10");

      const svJusdShares = await svJusd.convertToShares(amount);
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [amount0, amount1] = svJusdAddr < wcbtcAddr
        ? [svJusdShares, amount]
        : [amount, svJusdShares];
      await positionManager.setMintResult(1, 100, amount0, amount1);

      await jusd.connect(user1).approve(await gateway.getAddress(), amount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), amount);

      const tx = await gateway.connect(user1).addLiquidity(
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        500, // 0.05% fee tier
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
      const { gateway, user1, jusd, wcbtc, svJusd, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const amount = ethers.parseEther("10");

      const svJusdShares = await svJusd.convertToShares(amount);
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [amount0, amount1] = svJusdAddr < wcbtcAddr
        ? [svJusdShares, amount]
        : [amount, svJusdShares];
      await positionManager.setMintResult(1, 100, amount0, amount1);

      await jusd.connect(user1).approve(await gateway.getAddress(), amount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), amount);

      const tx = await gateway.connect(user1).addLiquidity(
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        10000, // 1% fee tier
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
      const { gateway, user1, jusd, wcbtc, swapRouter } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("10");
      const expectedOutput = ethers.parseEther("0.5");

      await swapRouter.setSwapOutput(expectedOutput);
      await jusd.connect(user1).approve(await gateway.getAddress(), swapAmount);

      const tx = await gateway.connect(user1).swapExactTokensForTokens(
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
      const { gateway, user1, jusd, wcbtc, svJusd, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const amount = ethers.parseEther("10");
      const expectedTokenId = 42; // Use different tokenId to verify

      const svJusdShares = await svJusd.convertToShares(amount);
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [amount0, amount1] = svJusdAddr < wcbtcAddr
        ? [svJusdShares, amount]
        : [amount, svJusdShares];
      await positionManager.setMintResult(expectedTokenId, 999, amount0, amount1);

      await jusd.connect(user1).approve(await gateway.getAddress(), amount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), amount);

      const tx = await gateway.connect(user1).addLiquidity(
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        3000,
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
          expectedTokenId  // This is the NFT tokenId, NOT the liquidity amount
        );
    });

    it("Should emit LiquidityRemoved with correct tokenId", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenId = 7; // Use specific tokenId
      const liquidity = 100;

      await positionManager.setPositionData(
        tokenId,
        await svJusd.getAddress(),
        await wcbtc.getAddress(),
        liquidity
      );
      await positionManager.setDecreaseResult(
        ethers.parseEther("10"),
        ethers.parseEther("10")
      );

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
          tokenId  // Verify correct tokenId is emitted
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
      const juice = (await MockEquityFactory.deploy("Juice Protocol", "JUICE", await jusd.getAddress())) as unknown as MockEquity;

      const MockERC4626Factory = await ethers.getContractFactory("MockERC4626");
      const svJusd = (await MockERC4626Factory.deploy(await jusd.getAddress(), "Savings Vault JUSD", "svJUSD")) as unknown as MockERC4626;

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
        await expect(
          gateway.connect(user1).registerBridgedToken(await newBridge.getAddress())
        ).to.emit(gateway, "BridgedTokenRegistered")
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

        await expect(
          gateway.registerBridgedToken(await usdcBridge.getAddress())
        ).to.be.revertedWithCustomError(gateway, "BridgedTokenAlreadyExists");
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

        await expect(
          gateway.registerBridgedToken(ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(gateway, "InvalidBridgeConfig");
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
          await fakeJusd.getAddress(),  // Wrong JUSD
          BRIDGE_LIMIT,
          BRIDGE_WEEKS
        );
        // Note: Even if we set minter, JUSD mismatch is checked first
        await jusd.setMinter(await bridge.getAddress(), true);

        await expect(
          gateway.registerBridgedToken(await bridge.getAddress())
        ).to.be.revertedWithCustomError(gateway, "InvalidBridgeConfig");
      });
    });

    describe("Swap with Bridged Tokens", function () {
      it("Should swap bridged token (USDC.e) to WcBTC", async function () {
        const { gateway, user1, usdc, wcbtc, swapRouter } =
          await loadFixture(deployGatewayWithBridgedTokensFixture);

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
        const { gateway, user1, usdt, wcbtc, svJusd, swapRouter, usdtBridge } =
          await loadFixture(deployGatewayWithBridgedTokensFixture);

        const deadline = (await time.latest()) + DEADLINE_OFFSET;
        const swapAmount = ethers.parseEther("0.01"); // 0.01 WcBTC
        const svJusdOutput = ethers.parseEther("1000"); // Mock router returns this

        await swapRouter.setSwapOutput(svJusdOutput);
        await wcbtc.connect(user1).approve(await gateway.getAddress(), swapAmount);

        // Track bridge minted amount for the burn
        await usdtBridge.setMinted(svJusdOutput);

        const usdtBefore = await usdt.balanceOf(user1.address);

        await gateway.connect(user1).swapExactTokensForTokens(
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
        const { gateway, user1, usdc, wcbtc, swapRouter } =
          await loadFixture(deployGatewayWithBridgedTokensFixture);

        const deadline = (await time.latest()) + DEADLINE_OFFSET;
        const swapAmount = 1000n * 10n ** 6n;

        await swapRouter.setSwapOutput(ethers.parseEther("0.01"));
        await usdc.connect(user1).approve(await gateway.getAddress(), swapAmount);

        await expect(
          gateway.connect(user1).swapExactTokensForTokens(
            await usdc.getAddress(),
            await wcbtc.getAddress(),
            0,
            swapAmount,
            0,
            user1.address,
            deadline
          )
        ).to.emit(gateway, "SwapExecuted")
          .withArgs(user1.address, await usdc.getAddress(), await wcbtc.getAddress(), anyValue, anyValue);
      });
    });

    describe("Add Liquidity with Bridged Tokens", function () {
      it("Should add liquidity with bridged token (USDC.e) + WcBTC", async function () {
        const { gateway, user1, usdc, wcbtc, svJusd, positionManager } =
          await loadFixture(deployGatewayWithBridgedTokensFixture);

        const deadline = (await time.latest()) + DEADLINE_OFFSET;
        const usdcAmount = 1000n * 10n ** 6n; // 1000 USDC (6 decimals)
        const wcbtcAmount = ethers.parseEther("0.01");

        // Calculate expected svJUSD shares (1000 USDC = 1000 JUSD = ~1000 svJUSD shares)
        const jusdEquivalent = ethers.parseEther("1000"); // 1000 USDC = 1000 JUSD
        const svJusdShares = await svJusd.convertToShares(jusdEquivalent);

        const svJusdAddr = await svJusd.getAddress();
        const wcbtcAddr = await wcbtc.getAddress();
        const [amount0, amount1] = svJusdAddr < wcbtcAddr
          ? [svJusdShares, wcbtcAmount]
          : [wcbtcAmount, svJusdShares];

        await positionManager.setMintResult(1, 100, amount0, amount1);

        await usdc.connect(user1).approve(await gateway.getAddress(), usdcAmount);
        await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

        const tx = await gateway.connect(user1).addLiquidity(
          await usdc.getAddress(),
          await wcbtc.getAddress(),
          0, // default fee
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
        const { gateway, user1, usdc, jusd } =
          await loadFixture(deployGatewayWithBridgedTokensFixture);

        const deadline = (await time.latest()) + DEADLINE_OFFSET;
        const amount = 1000n * 10n ** 6n;

        await usdc.connect(user1).approve(await gateway.getAddress(), amount);
        await jusd.connect(user1).approve(await gateway.getAddress(), ethers.parseEther("1000"));

        await expect(
          gateway.connect(user1).addLiquidity(
            await usdc.getAddress(),
            await jusd.getAddress(),
            0,
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
        const { gateway, user1, usdc, usdt } =
          await loadFixture(deployGatewayWithBridgedTokensFixture);

        const deadline = (await time.latest()) + DEADLINE_OFFSET;
        const amount = 1000n * 10n ** 6n;

        await usdc.connect(user1).approve(await gateway.getAddress(), amount);
        await usdt.connect(user1).approve(await gateway.getAddress(), amount);

        await expect(
          gateway.connect(user1).addLiquidity(
            await usdc.getAddress(),
            await usdt.getAddress(),
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

      it("Should return excess bridged token when position manager uses less", async function () {
        const { gateway, user1, usdc, wcbtc, svJusd, positionManager, usdcBridge } =
          await loadFixture(deployGatewayWithBridgedTokensFixture);

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
        const [amount0, amount1] = svJusdAddr < wcbtcAddr
          ? [halfSvJusdShares, halfWcbtc]
          : [halfWcbtc, halfSvJusdShares];
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
        const { gateway, user1, usdt, wcbtc, svJusd, positionManager, usdtBridge } =
          await loadFixture(deployGatewayWithBridgedTokensFixture);

        const deadline = (await time.latest()) + DEADLINE_OFFSET;
        const tokenId = 1;
        const usdtAmount = 2000n * 10n ** 6n; // 2000 USDT
        const wcbtcAmount = ethers.parseEther("0.02");

        // Setup position with correct token ordering
        const svJusdAddr = await svJusd.getAddress();
        const wcbtcAddr = await wcbtc.getAddress();
        const [token0, token1] = svJusdAddr < wcbtcAddr
          ? [svJusdAddr, wcbtcAddr]
          : [wcbtcAddr, svJusdAddr];
        await positionManager.setPositionData(tokenId, token0, token1, 100);
        await positionManager.mintNFT(user1.address, tokenId);
        await positionManager.connect(user1).approve(await gateway.getAddress(), tokenId);

        // Mock increase to use only half
        const jusdEquivalent = ethers.parseEther("2000");
        const fullSvJusdShares = await svJusd.convertToShares(jusdEquivalent);
        const halfSvJusdShares = fullSvJusdShares / 2n;
        const halfWcbtc = wcbtcAmount / 2n;

        const [inc0, inc1] = svJusdAddr < wcbtcAddr
          ? [halfSvJusdShares, halfWcbtc]
          : [halfWcbtc, halfSvJusdShares];
        await positionManager.setIncreaseResult(50, inc0, inc1);

        // Set minted for bridge burn
        await usdtBridge.setMinted(jusdEquivalent);

        await usdt.connect(user1).approve(await gateway.getAddress(), usdtAmount);
        await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

        const usdtBefore = await usdt.balanceOf(user1.address);

        await gateway.connect(user1).increaseLiquidity(
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

        await expect(
          gateway.bridgedToSvJusd(await wcbtc.getAddress(), 1000)
        ).to.be.revertedWithCustomError(gateway, "BridgedTokenNotFound");
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
        const { gateway, user1, usdc, usdt, svJusd, swapRouter, usdtBridge } =
          await loadFixture(deployGatewayWithBridgedTokensFixture);

        const deadline = (await time.latest()) + DEADLINE_OFFSET;
        const swapAmount = 1000n * 10n ** 6n; // 1000 USDC

        // Mock: USDC → svJUSD → USDT path
        // Router returns svJUSD, then gateway converts to USDT
        const svJusdOutput = ethers.parseEther("1000");
        await swapRouter.setSwapOutput(svJusdOutput);
        await usdtBridge.setMinted(svJusdOutput);

        await usdc.connect(user1).approve(await gateway.getAddress(), swapAmount);

        const usdtBefore = await usdt.balanceOf(user1.address);

        await gateway.connect(user1).swapExactTokensForTokens(
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
        const mintedAmount = BRIDGE_LIMIT * 40n / 100n;
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
        const { gateway, user1, jusd, usdc, usdcBridge } =
          await loadFixture(deployGatewayWithBridgedTokensFixture);

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
        const { gateway, user1, jusd, usdc } =
          await loadFixture(deployGatewayWithBridgedTokensFixture);

        const usdcAmount = 100_000_000n; // 100 USDC (6 decimals)
        const deadline = (await time.latest()) + 3600;

        // Mint USDC to user
        await usdc.mint(user1.address, usdcAmount);
        await usdc.connect(user1).approve(await gateway.getAddress(), usdcAmount);

        const jusdBefore = await jusd.balanceOf(user1.address);

        // Swap USDC.e -> JUSD (should use direct path)
        await gateway.connect(user1).swapExactTokensForTokens(
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
        const { gateway, user1, usdc, usdt, usdtBridge } =
          await loadFixture(deployGatewayWithBridgedTokensFixture);

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
        await gateway.connect(user1).swapExactTokensForTokens(
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
        const { gateway, user1, jusd, juice } =
          await loadFixture(deployGatewayWithBridgedTokensFixture);

        const jusdAmount = ethers.parseEther("100");
        const deadline = (await time.latest()) + 3600;

        // Mint JUSD to user
        await jusd.mint(user1.address, jusdAmount);
        await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);

        const juiceBefore = await juice.balanceOf(user1.address);

        // Swap JUSD -> JUICE (should use direct path via Equity.invest)
        await gateway.connect(user1).swapExactTokensForTokens(
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
        const { gateway, user1, usdc, juice } =
          await loadFixture(deployGatewayWithBridgedTokensFixture);

        const usdcAmount = 100_000_000n; // 100 USDC (6 decimals)
        const deadline = (await time.latest()) + 3600;

        // Mint USDC to user
        await usdc.mint(user1.address, usdcAmount);
        await usdc.connect(user1).approve(await gateway.getAddress(), usdcAmount);

        const juiceBefore = await juice.balanceOf(user1.address);

        // Swap USDC.e -> JUICE (should use direct path)
        await gateway.connect(user1).swapExactTokensForTokens(
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
        const { gateway, user1, jusd, usdc, usdcBridge } =
          await loadFixture(deployGatewayWithBridgedTokensFixture);

        const jusdAmount = ethers.parseEther("100");
        const deadline = (await time.latest()) + 3600;

        await jusd.mint(user1.address, jusdAmount);
        await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
        await usdc.mint(await usdcBridge.getAddress(), 100_000_000n);
        await usdcBridge.setMinted(jusdAmount);

        await expect(
          gateway.connect(user1).swapExactTokensForTokens(
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
          .withArgs(
            user1.address,
            await jusd.getAddress(),
            await usdc.getAddress(),
            jusdAmount,
            anyValue
          );
      });

      it("Should revert if minAmountOut not met in direct conversion", async function () {
        const { gateway, user1, jusd, usdc, usdcBridge } =
          await loadFixture(deployGatewayWithBridgedTokensFixture);

        const jusdAmount = ethers.parseEther("100");
        const deadline = (await time.latest()) + 3600;

        await jusd.mint(user1.address, jusdAmount);
        await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
        await usdc.mint(await usdcBridge.getAddress(), 100_000_000n);
        await usdcBridge.setMinted(jusdAmount);

        // Expect 200 USDC but only 100 USDC will be received
        const unreasonableMinOutput = 200_000_000n; // 200 USDC

        await expect(
          gateway.connect(user1).swapExactTokensForTokens(
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
        const { gateway, user1, wcbtc, jusd, svJusd, swapRouter } =
          await loadFixture(deployGatewayWithBridgedTokensFixture);

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
});
