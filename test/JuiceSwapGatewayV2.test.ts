import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { readFileSync } from "fs";
import {
  JuiceSwapGatewayV2,
  MockERC20,
  MockEquity,
  MockERC4626,
  MockPositionManager,
  MockSwapRouter,
  MockWETH,
} from "../typechain-types";

describe("JuiceSwapGatewayV2", function () {
  const INITIAL_BALANCE = ethers.parseEther("1000");
  const DEADLINE_OFFSET = 3600;
  const ONE = ethers.parseEther("1");
  const JUICE_PRICE = ethers.parseEther("100");

  async function deployGatewayV2Fixture() {
    const [owner, user, recipient] = await ethers.getSigners();

    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    const jusd = (await MockERC20Factory.deploy("JuiceDollar", "JUSD", 18)) as unknown as MockERC20;
    await jusd.waitForDeployment();

    const outputToken = (await MockERC20Factory.deploy("Output Token", "OUT", 18)) as unknown as MockERC20;
    await outputToken.waitForDeployment();

    const MockEquityFactory = await ethers.getContractFactory("MockEquity");
    const juice = (await MockEquityFactory.deploy(
      "Juice Protocol",
      "JUICE",
      await jusd.getAddress()
    )) as unknown as MockEquity;
    await juice.waitForDeployment();

    const MockERC4626Factory = await ethers.getContractFactory("MockERC4626");
    const svJusd = (await MockERC4626Factory.deploy(
      await jusd.getAddress(),
      "Savings Vault JUSD",
      "svJUSD"
    )) as unknown as MockERC4626;
    await svJusd.waitForDeployment();

    const MockWETHFactory = await ethers.getContractFactory("MockWETH");
    const wcbtc = (await MockWETHFactory.deploy("Wrapped cBTC", "WcBTC")) as unknown as MockWETH;
    await wcbtc.waitForDeployment();

    const MockSwapRouterFactory = await ethers.getContractFactory("MockSwapRouter");
    const swapRouter = (await MockSwapRouterFactory.deploy()) as unknown as MockSwapRouter;
    await swapRouter.waitForDeployment();

    const MockPositionManagerFactory = await ethers.getContractFactory("MockPositionManager");
    const positionManager = (await MockPositionManagerFactory.deploy()) as unknown as MockPositionManager;
    await positionManager.waitForDeployment();

    const JuiceSwapGatewayV2Factory = await ethers.getContractFactory("JuiceSwapGatewayV2");
    const gateway = (await JuiceSwapGatewayV2Factory.deploy(
      await jusd.getAddress(),
      await svJusd.getAddress(),
      await juice.getAddress(),
      await wcbtc.getAddress(),
      await swapRouter.getAddress(),
      await positionManager.getAddress()
    )) as unknown as JuiceSwapGatewayV2;
    await gateway.waitForDeployment();

    await jusd.mint(user.address, INITIAL_BALANCE);

    return {
      owner,
      user,
      recipient,
      jusd,
      outputToken,
      juice,
      svJusd,
      wcbtc,
      swapRouter,
      positionManager,
      gateway,
    };
  }

  function protocolFee(amountIn: bigint) {
    return (amountIn * 25n + 9_999n) / 10_000n;
  }

  function juiceSharesForJusd(jusdAmount: bigint) {
    return (jusdAmount * ONE) / JUICE_PRICE;
  }

  function jusdForJuiceShares(juiceAmount: bigint) {
    return (juiceAmount * JUICE_PRICE) / ONE;
  }

  async function mintSvJusdToUser(jusd: MockERC20, svJusd: MockERC4626, user: HardhatEthersSigner, assets: bigint) {
    await jusd.connect(user).approve(await svJusd.getAddress(), assets);
    await svJusd.connect(user).deposit(assets, user.address);
  }

  async function investJuiceForUser(jusd: MockERC20, juice: MockEquity, user: HardhatEthersSigner, assets: bigint) {
    await jusd.connect(user).approve(await juice.getAddress(), assets);
    return juice.connect(user).invest(assets, 0);
  }

  async function expectNoGatewayStage2aResiduals(
    gateway: JuiceSwapGatewayV2,
    jusd: MockERC20,
    svJusd: MockERC4626,
    juice: MockEquity
  ) {
    const gatewayAddress = await gateway.getAddress();

    expect(await jusd.balanceOf(gatewayAddress)).to.equal(0);
    expect(await svJusd.balanceOf(gatewayAddress)).to.equal(0);
    expect(await juice.balanceOf(gatewayAddress)).to.equal(0);
  }

  describe("Deployment", function () {
    it("mirrors the V1 dependency addresses and exposes Stage 1 fee constants", async function () {
      const { gateway, jusd, svJusd, juice, wcbtc, swapRouter, positionManager } =
        await loadFixture(deployGatewayV2Fixture);

      expect(await gateway.JUSD()).to.equal(await jusd.getAddress());
      expect(await gateway.SV_JUSD()).to.equal(await svJusd.getAddress());
      expect(await gateway.JUICE()).to.equal(await juice.getAddress());
      expect(await gateway.WCBTC()).to.equal(await wcbtc.getAddress());
      expect(await gateway.SWAP_ROUTER()).to.equal(await swapRouter.getAddress());
      expect(await gateway.POSITION_MANAGER()).to.equal(await positionManager.getAddress());
      expect(await gateway.DEFAULT_FEE()).to.equal(3000);
      expect(await gateway.PROTOCOL_FEE_BPS()).to.equal(25);
      expect(await gateway.BPS_DENOMINATOR()).to.equal(10_000);
    });

    it("leaves JuiceSwapGateway.sol as the V1 contract source", async function () {
      const v1Source = readFileSync("contracts/gateway/JuiceSwapGateway.sol", "utf8");

      expect(v1Source).to.include("contract JuiceSwapGateway is IJuiceSwapGateway");
      expect(v1Source).not.to.include("contract JuiceSwapGatewayV2");
      expect(v1Source).not.to.include("PROTOCOL_FEE_BPS");
    });
  });

  describe("JUSD exact-input swaps", function () {
    it("charges a 25 bps ceil fee to Equity and swaps only the remaining trade amount", async function () {
      const { gateway, user, recipient, jusd, outputToken, juice, swapRouter } =
        await loadFixture(deployGatewayV2Fixture);

      const amountIn = 10_001n;
      const expectedFee = protocolFee(amountIn);
      const expectedTradeAmount = amountIn - expectedFee;
      const expectedOutput = ethers.parseEther("7.5");
      const deadline = (await time.latest()) + DEADLINE_OFFSET;

      await swapRouter.setSwapOutput(expectedOutput);
      await jusd.connect(user).approve(await gateway.getAddress(), amountIn);

      await expect(
        gateway
          .connect(user)
          .swapExactTokensForTokens(
            await jusd.getAddress(),
            await outputToken.getAddress(),
            0,
            amountIn,
            expectedOutput,
            recipient.address,
            deadline
          )
      )
        .to.emit(gateway, "ProtocolFeeToEquity")
        .withArgs(user.address, expectedFee)
        .and.to.emit(gateway, "SwapExecuted")
        .withArgs(user.address, await jusd.getAddress(), await outputToken.getAddress(), amountIn, expectedOutput);

      expect(await jusd.balanceOf(await juice.getAddress())).to.equal(expectedFee);
      expect(await jusd.balanceOf(await swapRouter.getAddress())).to.equal(expectedTradeAmount);
      expect(await jusd.balanceOf(await gateway.getAddress())).to.equal(0);
      expect(await outputToken.balanceOf(recipient.address)).to.equal(expectedOutput);
    });

    it("rejects dust where the protocol fee consumes the input", async function () {
      const { gateway, user, recipient, jusd, outputToken } = await loadFixture(deployGatewayV2Fixture);
      const deadline = (await time.latest()) + DEADLINE_OFFSET;

      await jusd.connect(user).approve(await gateway.getAddress(), 1n);

      await expect(
        gateway
          .connect(user)
          .swapExactTokensForTokens(
            await jusd.getAddress(),
            await outputToken.getAddress(),
            3000,
            1n,
            0,
            recipient.address,
            deadline
          )
      )
        .to.be.revertedWithCustomError(gateway, "InsufficientTradeAmount")
        .withArgs(1n, 1n);
    });

    it("keeps unsupported Stage 1 and deferred cBTC swap paths closed", async function () {
      const { gateway, user, recipient, jusd, outputToken, wcbtc } = await loadFixture(deployGatewayV2Fixture);
      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const amountIn = ethers.parseEther("1");

      await jusd.connect(user).approve(await gateway.getAddress(), amountIn);

      await expect(
        gateway
          .connect(user)
          .swapExactTokensForTokens(
            await outputToken.getAddress(),
            await jusd.getAddress(),
            3000,
            amountIn,
            0,
            recipient.address,
            deadline
          )
      ).to.be.revertedWithCustomError(gateway, "NotImplemented");

      for (const unsupportedOut of [await jusd.getAddress(), await wcbtc.getAddress(), ethers.ZeroAddress]) {
        await expect(
          gateway
            .connect(user)
            .swapExactTokensForTokens(
              await jusd.getAddress(),
              unsupportedOut,
              3000,
              amountIn,
              0,
              recipient.address,
              deadline
            )
        ).to.be.revertedWithCustomError(gateway, "NotImplemented");
      }
    });
  });

  describe("Stage 2a direct conversions", function () {
    it("quotes JUSD, svJUSD, and JUICE conversions with the V1 calculators", async function () {
      const { gateway, svJusd, juice } = await loadFixture(deployGatewayV2Fixture);
      const jusdAmount = ethers.parseEther("123");
      const svJusdAmount = ethers.parseEther("45");
      const juiceAmount = ethers.parseEther("2");

      expect(await gateway.jusdToSvJusd(jusdAmount)).to.equal(await svJusd.convertToShares(jusdAmount));
      expect(await gateway.svJusdToJusd(svJusdAmount)).to.equal(await svJusd.convertToAssets(svJusdAmount));
      expect(await gateway.juiceToJusd(juiceAmount)).to.equal(await juice.calculateProceeds(juiceAmount));
      expect(await gateway.jusdToJuice(jusdAmount)).to.equal(await juice.calculateShares(jusdAmount));
    });

    it("converts JUSD to svJUSD after sending one 25 bps JUSD fee to Equity", async function () {
      const { gateway, user, recipient, jusd, svJusd, juice, swapRouter } = await loadFixture(deployGatewayV2Fixture);
      const amountIn = ethers.parseEther("20");
      const expectedFee = protocolFee(amountIn);
      const expectedShares = amountIn - expectedFee;
      const deadline = (await time.latest()) + DEADLINE_OFFSET;

      await jusd.connect(user).approve(await gateway.getAddress(), amountIn);

      await expect(
        gateway
          .connect(user)
          .swapExactTokensForTokens(
            await jusd.getAddress(),
            await svJusd.getAddress(),
            3000,
            amountIn,
            expectedShares,
            recipient.address,
            deadline
          )
      )
        .to.emit(gateway, "ProtocolFeeToEquity")
        .withArgs(user.address, expectedFee)
        .and.to.emit(gateway, "SwapExecuted")
        .withArgs(user.address, await jusd.getAddress(), await svJusd.getAddress(), amountIn, expectedShares);

      expect(await jusd.balanceOf(await juice.getAddress())).to.equal(expectedFee);
      expect(await jusd.balanceOf(await svJusd.getAddress())).to.equal(expectedShares);
      expect(await svJusd.balanceOf(recipient.address)).to.equal(expectedShares);
      expect(await swapRouter.swapCallCount()).to.equal(0);
      await expectNoGatewayStage2aResiduals(gateway, jusd, svJusd, juice);
    });

    it("redeems svJUSD to JUSD, charges the fee on redeemed assets, and sends the net JUSD", async function () {
      const { gateway, user, recipient, jusd, svJusd, juice, swapRouter } = await loadFixture(deployGatewayV2Fixture);
      const sharesIn = ethers.parseEther("20");
      const expectedFee = protocolFee(sharesIn);
      const expectedJusdOut = sharesIn - expectedFee;
      const deadline = (await time.latest()) + DEADLINE_OFFSET;

      await mintSvJusdToUser(jusd, svJusd, user, sharesIn);
      await svJusd.connect(user).approve(await gateway.getAddress(), sharesIn);

      await expect(
        gateway
          .connect(user)
          .swapExactTokensForTokens(
            await svJusd.getAddress(),
            await jusd.getAddress(),
            3000,
            sharesIn,
            expectedJusdOut,
            recipient.address,
            deadline
          )
      )
        .to.emit(gateway, "ProtocolFeeToEquity")
        .withArgs(user.address, expectedFee)
        .and.to.emit(gateway, "SwapExecuted")
        .withArgs(user.address, await svJusd.getAddress(), await jusd.getAddress(), sharesIn, expectedJusdOut);

      expect(await jusd.balanceOf(await juice.getAddress())).to.equal(expectedFee);
      expect(await jusd.balanceOf(recipient.address)).to.equal(expectedJusdOut);
      expect(await jusd.balanceOf(await svJusd.getAddress())).to.equal(0);
      expect(await swapRouter.swapCallCount()).to.equal(0);
      await expectNoGatewayStage2aResiduals(gateway, jusd, svJusd, juice);
    });

    it("invests net JUSD into JUICE after charging the JUSD fee", async function () {
      const { gateway, user, recipient, jusd, svJusd, juice, swapRouter } = await loadFixture(deployGatewayV2Fixture);
      const amountIn = ethers.parseEther("200");
      const expectedFee = protocolFee(amountIn);
      const expectedJuiceOut = juiceSharesForJusd(amountIn - expectedFee);
      const deadline = (await time.latest()) + DEADLINE_OFFSET;

      await jusd.connect(user).approve(await gateway.getAddress(), amountIn);

      await expect(
        gateway
          .connect(user)
          .swapExactTokensForTokens(
            await jusd.getAddress(),
            await juice.getAddress(),
            3000,
            amountIn,
            expectedJuiceOut,
            recipient.address,
            deadline
          )
      )
        .to.emit(gateway, "ProtocolFeeToEquity")
        .withArgs(user.address, expectedFee)
        .and.to.emit(gateway, "SwapExecuted")
        .withArgs(user.address, await jusd.getAddress(), await juice.getAddress(), amountIn, expectedJuiceOut);

      expect(await jusd.balanceOf(await juice.getAddress())).to.equal(amountIn);
      expect(await juice.balanceOf(recipient.address)).to.equal(expectedJuiceOut);
      expect(await swapRouter.swapCallCount()).to.equal(0);
      await expectNoGatewayStage2aResiduals(gateway, jusd, svJusd, juice);
    });

    it("redeems JUICE to JUSD, charges the fee on proceeds, and sends net JUSD", async function () {
      const { gateway, user, recipient, jusd, svJusd, juice, swapRouter } = await loadFixture(deployGatewayV2Fixture);
      const sharesIn = ethers.parseEther("2");
      const grossJusd = jusdForJuiceShares(sharesIn);
      const expectedFee = protocolFee(grossJusd);
      const expectedJusdOut = grossJusd - expectedFee;
      const deadline = (await time.latest()) + DEADLINE_OFFSET;

      await investJuiceForUser(jusd, juice, user, grossJusd);
      await juice.connect(user).approve(await gateway.getAddress(), sharesIn);

      await expect(
        gateway
          .connect(user)
          .swapExactTokensForTokens(
            await juice.getAddress(),
            await jusd.getAddress(),
            3000,
            sharesIn,
            expectedJusdOut,
            recipient.address,
            deadline
          )
      )
        .to.emit(gateway, "ProtocolFeeToEquity")
        .withArgs(user.address, expectedFee)
        .and.to.emit(gateway, "SwapExecuted")
        .withArgs(user.address, await juice.getAddress(), await jusd.getAddress(), sharesIn, expectedJusdOut);

      expect(await jusd.balanceOf(await juice.getAddress())).to.equal(expectedFee);
      expect(await jusd.balanceOf(recipient.address)).to.equal(expectedJusdOut);
      expect(await juice.balanceOf(user.address)).to.equal(0);
      expect(await swapRouter.swapCallCount()).to.equal(0);
      await expectNoGatewayStage2aResiduals(gateway, jusd, svJusd, juice);
    });

    it("redeems svJUSD and invests only the post-fee JUSD into JUICE", async function () {
      const { gateway, user, recipient, jusd, svJusd, juice, swapRouter } = await loadFixture(deployGatewayV2Fixture);
      const sharesIn = ethers.parseEther("200");
      const expectedFee = protocolFee(sharesIn);
      const expectedJuiceOut = juiceSharesForJusd(sharesIn - expectedFee);
      const deadline = (await time.latest()) + DEADLINE_OFFSET;

      await mintSvJusdToUser(jusd, svJusd, user, sharesIn);
      await svJusd.connect(user).approve(await gateway.getAddress(), sharesIn);

      await expect(
        gateway
          .connect(user)
          .swapExactTokensForTokens(
            await svJusd.getAddress(),
            await juice.getAddress(),
            3000,
            sharesIn,
            expectedJuiceOut,
            recipient.address,
            deadline
          )
      )
        .to.emit(gateway, "ProtocolFeeToEquity")
        .withArgs(user.address, expectedFee)
        .and.to.emit(gateway, "SwapExecuted")
        .withArgs(user.address, await svJusd.getAddress(), await juice.getAddress(), sharesIn, expectedJuiceOut);

      expect(await jusd.balanceOf(await juice.getAddress())).to.equal(sharesIn);
      expect(await juice.balanceOf(recipient.address)).to.equal(expectedJuiceOut);
      expect(await jusd.balanceOf(await svJusd.getAddress())).to.equal(0);
      expect(await swapRouter.swapCallCount()).to.equal(0);
      await expectNoGatewayStage2aResiduals(gateway, jusd, svJusd, juice);
    });

    it("redeems JUICE and deposits only the post-fee JUSD into svJUSD", async function () {
      const { gateway, user, recipient, jusd, svJusd, juice, swapRouter } = await loadFixture(deployGatewayV2Fixture);
      const sharesIn = ethers.parseEther("2");
      const grossJusd = jusdForJuiceShares(sharesIn);
      const expectedFee = protocolFee(grossJusd);
      const expectedSvJusdOut = grossJusd - expectedFee;
      const deadline = (await time.latest()) + DEADLINE_OFFSET;

      await investJuiceForUser(jusd, juice, user, grossJusd);
      await juice.connect(user).approve(await gateway.getAddress(), sharesIn);

      await expect(
        gateway
          .connect(user)
          .swapExactTokensForTokens(
            await juice.getAddress(),
            await svJusd.getAddress(),
            3000,
            sharesIn,
            expectedSvJusdOut,
            recipient.address,
            deadline
          )
      )
        .to.emit(gateway, "ProtocolFeeToEquity")
        .withArgs(user.address, expectedFee)
        .and.to.emit(gateway, "SwapExecuted")
        .withArgs(user.address, await juice.getAddress(), await svJusd.getAddress(), sharesIn, expectedSvJusdOut);

      expect(await jusd.balanceOf(await juice.getAddress())).to.equal(expectedFee);
      expect(await jusd.balanceOf(await svJusd.getAddress())).to.equal(expectedSvJusdOut);
      expect(await svJusd.balanceOf(recipient.address)).to.equal(expectedSvJusdOut);
      expect(await juice.balanceOf(user.address)).to.equal(0);
      expect(await swapRouter.swapCallCount()).to.equal(0);
      await expectNoGatewayStage2aResiduals(gateway, jusd, svJusd, juice);
    });

    it("rejects Stage 2a dust and same-token fee bypasses", async function () {
      const { gateway, user, recipient, jusd, svJusd, juice } = await loadFixture(deployGatewayV2Fixture);
      const deadline = (await time.latest()) + DEADLINE_OFFSET;

      await jusd.connect(user).approve(await gateway.getAddress(), 1n);
      await expect(
        gateway
          .connect(user)
          .swapExactTokensForTokens(
            await jusd.getAddress(),
            await svJusd.getAddress(),
            3000,
            1n,
            0,
            recipient.address,
            deadline
          )
      )
        .to.be.revertedWithCustomError(gateway, "InsufficientTradeAmount")
        .withArgs(1n, 1n);

      for (const token of [await jusd.getAddress(), await svJusd.getAddress(), await juice.getAddress()]) {
        await expect(
          gateway.connect(user).swapExactTokensForTokens(token, token, 3000, 1n, 0, recipient.address, deadline)
        ).to.be.revertedWithCustomError(gateway, "NotImplemented");
      }
    });
  });

  describe("Stage 2 placeholders", function () {
    it("reverts conversion, liquidity, bridge, and pool entrypoints with NotImplemented", async function () {
      const { gateway, user, recipient, jusd, outputToken } = await loadFixture(deployGatewayV2Fixture);
      const deadline = (await time.latest()) + DEADLINE_OFFSET;
      const tokenA = await jusd.getAddress();
      const tokenB = await outputToken.getAddress();

      await expect(
        gateway.addLiquidity(tokenA, tokenB, 3000, 0, 0, 1, 1, 0, 0, recipient.address, deadline)
      ).to.be.revertedWithCustomError(gateway, "NotImplemented");
      await expect(gateway.increaseLiquidity(1, tokenA, tokenB, 1, 1, 0, 0, deadline)).to.be.revertedWithCustomError(
        gateway,
        "NotImplemented"
      );
      await expect(
        gateway.removeLiquidity(1, 1, tokenA, tokenB, 0, 0, recipient.address, deadline)
      ).to.be.revertedWithCustomError(gateway, "NotImplemented");
      await expect(gateway.bridgedToSvJusd(tokenB, 1)).to.be.revertedWithCustomError(gateway, "NotImplemented");
      await expect(gateway.svJusdToBridged(tokenB, 1)).to.be.revertedWithCustomError(gateway, "NotImplemented");
      await expect(gateway.isBridgedToken(tokenB)).to.be.revertedWithCustomError(gateway, "NotImplemented");
      await expect(gateway.getBridgedTokens()).to.be.revertedWithCustomError(gateway, "NotImplemented");
      await expect(gateway.registerBridgedToken(tokenB)).to.be.revertedWithCustomError(gateway, "NotImplemented");
      await expect(gateway.getBridgeStatus(tokenB)).to.be.revertedWithCustomError(gateway, "NotImplemented");
      await expect(gateway.createPool(tokenA, tokenB, 3000, 1)).to.be.revertedWithCustomError(
        gateway,
        "NotImplemented"
      );
      await expect(
        gateway.createPoolAndAddLiquidity(tokenA, tokenB, 3000, 1, 0, 0, 1, 1, 0, 0, recipient.address, deadline)
      ).to.be.revertedWithCustomError(gateway, "NotImplemented");
      await expect(gateway.getPool(tokenA, tokenB, 3000)).to.be.revertedWithCustomError(gateway, "NotImplemented");

      await expect(
        user.sendTransaction({
          to: await gateway.getAddress(),
          value: 1,
        })
      ).to.be.revertedWithCustomError(gateway, "DirectTransferNotAccepted");
    });
  });
});
