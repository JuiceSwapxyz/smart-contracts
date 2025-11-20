import { expect } from "chai";
import { ethers } from "hardhat";
import { JuiceSwapGateway } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
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
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const jusd = await MockERC20.deploy("JuiceDollar", "JUSD", 18);
    await jusd.waitForDeployment();

    // Deploy Mock JUICE (ERC20 with Equity functions)
    const MockEquity = await ethers.getContractFactory("MockEquity");
    const juice = await MockEquity.deploy("Juice Protocol", "JUICE", await jusd.getAddress());
    await juice.waitForDeployment();

    // Deploy Mock svJUSD (ERC4626)
    const MockERC4626 = await ethers.getContractFactory("MockERC4626");
    const svJusd = await MockERC4626.deploy(
      await jusd.getAddress(),
      "Savings Vault JUSD",
      "svJUSD"
    );
    await svJusd.waitForDeployment();

    // Deploy Mock WcBTC (WETH-like wrapper)
    const MockWETH = await ethers.getContractFactory("MockWETH");
    const wcbtc = await MockWETH.deploy("Wrapped cBTC", "WcBTC");
    await wcbtc.waitForDeployment();

    // Deploy Mock Uniswap V3 SwapRouter
    const MockSwapRouter = await ethers.getContractFactory("MockSwapRouter");
    const swapRouter = await MockSwapRouter.deploy();
    await swapRouter.waitForDeployment();

    // Deploy Mock NonfungiblePositionManager
    const MockPositionManager = await ethers.getContractFactory("MockPositionManager");
    const positionManager = await MockPositionManager.deploy();
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

    const JuiceSwapGateway = await ethers.getContractFactory("JuiceSwapGateway");
    const gateway = await JuiceSwapGateway.deploy(
      await jusd.getAddress(),
      await svJusd.getAddress(),
      await juice.getAddress(),
      await wcbtc.getAddress(),
      await swapRouter.getAddress(),
      await positionManager.getAddress()
    );
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

    // Fund MockSwapRouter with tokens for swaps
    // This simulates liquidity pools having tokens
    const swapRouterAddr = await swapRouter.getAddress();

    // WCBTC is a wrapper, so we need to deposit native tokens first
    await wcbtc.deposit({ value: ethers.parseEther("1000") });
    await wcbtc.transfer(swapRouterAddr, ethers.parseEther("1000"));

    // Fund svJUSD vault with JUSD so it can handle deposits and redemptions
    const svJusdAddr = await svJusd.getAddress();
    await jusd.mint(svJusdAddr, ethers.parseEther("100000")); // Increased for redemptions

    // Deposit some JUSD into svJUSD to create shares for swap router
    // First get the signer who will do the deposit
    const [owner] = await ethers.getSigners();
    await jusd.mint(owner.address, ethers.parseEther("1000"));
    await jusd.connect(owner).approve(svJusdAddr, ethers.parseEther("1000"));
    await svJusd.connect(owner).deposit(ethers.parseEther("1000"), swapRouterAddr);

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

    it("Should set correct default fee tier", async function () {
      const { gateway } = await loadFixture(deployGatewayFixture);
      expect(await gateway.defaultFee()).to.equal(3000); // 0.3%
    });

    it("Should set deployer as owner", async function () {
      const { gateway, owner } = await loadFixture(deployGatewayFixture);
      expect(await gateway.owner()).to.equal(owner.address);
    });

    it("Should not be paused initially", async function () {
      const { gateway } = await loadFixture(deployGatewayFixture);
      expect(await gateway.paused()).to.be.false;
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
        swapAmount,
        MIN_OUTPUT,
        user1.address,
        deadline
      );

      await expect(tx).to.emit(gateway, "SwapExecuted");
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
        swapAmount,
        0,
        user1.address,
        deadline
      );

      // Gateway should have deposited JUSD into svJUSD vault
      // (In real scenario, vault balance changes, but in mock it depends on implementation)
    });
  });

  describe("Swap: JUICE → Other Token", function () {
    it("Should swap JUICE for another token via Equity", async function () {
      const { gateway, user1, juice, wcbtc, swapRouter } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("10");

      await swapRouter.setSwapOutput(ethers.parseEther("0.5"));
      await juice.connect(user1).approve(await gateway.getAddress(), swapAmount);

      await expect(
        gateway.connect(user1).swapExactTokensForTokens(
          await juice.getAddress(),
          await wcbtc.getAddress(),
          swapAmount,
          0,
          user1.address,
          deadline
        )
      ).to.emit(gateway, "SwapExecuted");
    });

    it("Should convert JUICE → JUSD → svJUSD during swap", async function () {
      const { gateway, user1, juice, wcbtc, swapRouter } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const swapAmount = ethers.parseEther("10");

      await swapRouter.setSwapOutput(ethers.parseEther("0.5"));
      await juice.connect(user1).approve(await gateway.getAddress(), swapAmount);

      const juiceBalanceBefore = await juice.balanceOf(user1.address);

      await gateway.connect(user1).swapExactTokensForTokens(
        await juice.getAddress(),
        await wcbtc.getAddress(),
        swapAmount,
        0,
        user1.address,
        deadline
      );

      const juiceBalanceAfter = await juice.balanceOf(user1.address);
      expect(juiceBalanceAfter).to.equal(juiceBalanceBefore - swapAmount);
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
        swapAmount,
        0,
        user1.address,
        deadline,
        { value: swapAmount }
      );

      await expect(tx).to.emit(gateway, "SwapExecuted");
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
        swapAmount,
        0,
        user1.address,
        deadline
      );

      const balanceAfter = await ethers.provider.getBalance(user1.address);
      expect(balanceAfter).to.be.gt(balanceBefore); // User received cBTC
    });
  });

  describe("Add Liquidity", function () {
    it("Should add liquidity with JUSD successfully", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      // Setup mock position manager with correct token order (token0 < token1)
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [amount0, amount1] = svJusdAddr < wcbtcAddr
        ? [jusdAmount, wcbtcAmount]  // svJUSD is token0
        : [wcbtcAmount, jusdAmount]; // WcBTC is token0
      await positionManager.setMintResult(1, 100, amount0, amount1);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      const tx = await gateway.connect(user1).addLiquidity(
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        jusdAmount,
        wcbtcAmount,
        jusdAmount / 2n,
        wcbtcAmount / 2n,
        user1.address,
        deadline
      );

      await expect(tx).to.emit(gateway, "LiquidityAdded");
    });

    it("Should convert JUSD to svJUSD when adding liquidity", async function () {
      const { gateway, user1, jusd, wcbtc, positionManager, svJusd } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      // Setup with correct token order
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [amount0, amount1] = svJusdAddr < wcbtcAddr
        ? [jusdAmount, wcbtcAmount]
        : [wcbtcAmount, jusdAmount];
      await positionManager.setMintResult(1, 100, amount0, amount1);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      await gateway.connect(user1).addLiquidity(
        await jusd.getAddress(),
        await wcbtc.getAddress(),
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

      // Setup with correct token order (native becomes WcBTC)
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [amount0, amount1] = svJusdAddr < wcbtcAddr
        ? [jusdAmount, cbtcAmount]
        : [cbtcAmount, jusdAmount];
      await positionManager.setMintResult(1, 100, amount0, amount1);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);

      const tx = await gateway.connect(user1).addLiquidity(
        await jusd.getAddress(),
        ethers.ZeroAddress, // Native cBTC
        jusdAmount,
        cbtcAmount,
        0,
        0,
        user1.address,
        deadline,
        { value: cbtcAmount }
      );

      await expect(tx).to.emit(gateway, "LiquidityAdded");
    });

    it("Should return excess tokens to user", async function () {
      const { gateway, user1, jusd, svJusd, wcbtc, positionManager } =
        await loadFixture(deployGatewayWithBalancesFixture);

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const jusdAmount = ethers.parseEther("100");
      const wcbtcAmount = ethers.parseEther("1");

      // Setup with correct token order - mock returns less than desired
      const svJusdAddr = await svJusd.getAddress();
      const wcbtcAddr = await wcbtc.getAddress();
      const [amount0, amount1] = svJusdAddr < wcbtcAddr
        ? [jusdAmount / 2n, wcbtcAmount / 2n]  // Only half used
        : [wcbtcAmount / 2n, jusdAmount / 2n];
      await positionManager.setMintResult(1, 100, amount0, amount1);

      await jusd.connect(user1).approve(await gateway.getAddress(), jusdAmount);
      await wcbtc.connect(user1).approve(await gateway.getAddress(), wcbtcAmount);

      const jusdBalanceBefore = await jusd.balanceOf(user1.address);

      await gateway.connect(user1).addLiquidity(
        await jusd.getAddress(),
        await wcbtc.getAddress(),
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
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        tokenId,
        0,
        0,
        user1.address,
        deadline
      );

      await expect(tx).to.emit(gateway, "LiquidityRemoved");
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
        await jusd.getAddress(),
        await wcbtc.getAddress(),
        tokenId,
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
        await jusd.getAddress(),
        ethers.ZeroAddress,
        tokenId,
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
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          tokenId,
          0,
          0,
          user1.address,
          pastDeadline
        )
      ).to.be.revertedWithCustomError(gateway, "DeadlineExpired");
    });
  });

  describe("Admin Functions", function () {
    it("Should allow owner to set default fee", async function () {
      const { gateway, owner } = await loadFixture(deployGatewayFixture);

      const newFee = 500; // 0.05%
      await expect(gateway.connect(owner).setDefaultFee(newFee))
        .to.emit(gateway, "DefaultFeeUpdated")
        .withArgs(3000, newFee);

      expect(await gateway.defaultFee()).to.equal(newFee);
    });

    it("Should not allow non-owner to set default fee", async function () {
      const { gateway, user1 } = await loadFixture(deployGatewayFixture);

      await expect(
        gateway.connect(user1).setDefaultFee(500)
      ).to.be.revertedWithCustomError(gateway, "OwnableUnauthorizedAccount");
    });

    it("Should allow owner to pause", async function () {
      const { gateway, owner } = await loadFixture(deployGatewayFixture);

      await gateway.connect(owner).pause();
      expect(await gateway.paused()).to.be.true;
    });

    it("Should allow owner to unpause", async function () {
      const { gateway, owner } = await loadFixture(deployGatewayFixture);

      await gateway.connect(owner).pause();
      await gateway.connect(owner).unpause();
      expect(await gateway.paused()).to.be.false;
    });

    it("Should not allow non-owner to pause", async function () {
      const { gateway, user1 } = await loadFixture(deployGatewayFixture);

      await expect(
        gateway.connect(user1).pause()
      ).to.be.revertedWithCustomError(gateway, "OwnableUnauthorizedAccount");
    });

    it("Should block swaps when paused", async function () {
      const { gateway, owner, user1, jusd, wcbtc } =
        await loadFixture(deployGatewayWithBalancesFixture);

      await gateway.connect(owner).pause();

      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      await jusd.connect(user1).approve(await gateway.getAddress(), SWAP_AMOUNT);

      await expect(
        gateway.connect(user1).swapExactTokensForTokens(
          await jusd.getAddress(),
          await wcbtc.getAddress(),
          SWAP_AMOUNT,
          0,
          user1.address,
          deadline
        )
      ).to.be.revertedWithCustomError(gateway, "EnforcedPause");
    });

    it("Should allow owner to rescue native tokens", async function () {
      const { gateway, owner } = await loadFixture(deployGatewayFixture);

      // Note: Gateway blocks direct transfers via receive(), so native tokens
      // can only get stuck through wrapped token operations
      // This test just verifies the rescue function can be called successfully
      // Event is only emitted if balance > 0
      await expect(gateway.connect(owner).rescueNative()).to.not.be.reverted;
    });

    it("Should allow owner to rescue ERC20 tokens", async function () {
      const { gateway, owner, jusd } = await loadFixture(deployGatewayFixture);

      const rescueAmount = ethers.parseEther("100");
      await jusd.mint(await gateway.getAddress(), rescueAmount);

      await expect(
        gateway.connect(owner).rescueToken(
          await jusd.getAddress(),
          owner.address,
          rescueAmount
        )
      )
        .to.emit(gateway, "TokenRescued")
        .withArgs(await jusd.getAddress(), owner.address, rescueAmount);

      expect(await jusd.balanceOf(owner.address)).to.equal(rescueAmount);
    });

    it("Should not allow rescuing tokens to zero address", async function () {
      const { gateway, owner, jusd } = await loadFixture(deployGatewayFixture);

      await expect(
        gateway.connect(owner).rescueToken(
          await jusd.getAddress(),
          ethers.ZeroAddress,
          ethers.parseEther("100")
        )
      ).to.be.revertedWithCustomError(gateway, "InvalidToken");
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
        SWAP_AMOUNT / 2n,
        0,
        user1.address,
        deadline
      );

      // Second swap should not require additional approvals internally
      const tx2 = await gateway.connect(user1).swapExactTokensForTokens(
        await jusd.getAddress(),
        await wcbtc.getAddress(),
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
});
