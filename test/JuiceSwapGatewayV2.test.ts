import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
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

    it("keeps unsupported Stage 1 swap paths closed", async function () {
      const { gateway, user, recipient, jusd, outputToken, svJusd, juice } = await loadFixture(deployGatewayV2Fixture);
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

      for (const unsupportedOut of [
        await jusd.getAddress(),
        await svJusd.getAddress(),
        await juice.getAddress(),
        ethers.ZeroAddress,
      ]) {
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
      await expect(gateway.jusdToSvJusd(1)).to.be.revertedWithCustomError(gateway, "NotImplemented");
      await expect(gateway.svJusdToJusd(1)).to.be.revertedWithCustomError(gateway, "NotImplemented");
      await expect(gateway.juiceToJusd(1)).to.be.revertedWithCustomError(gateway, "NotImplemented");
      await expect(gateway.jusdToJuice(1)).to.be.revertedWithCustomError(gateway, "NotImplemented");
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
