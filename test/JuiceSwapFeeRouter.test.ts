import { expect } from "chai";
import { ethers } from "hardhat";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import {
  JuiceSwapFeeRouter,
  MockERC20,
  MockEquity,
  MockFeeRouterReentrantTarget,
  MockStablecoinBridge,
  MockSwapRouter,
} from "../typechain-types";

const INITIAL_BALANCE = ethers.parseEther("10000");
const DEADLINE_OFFSET = 3600;

type FeeRouterParams = JuiceSwapFeeRouter.ExactInputParamsStruct;

describe("JuiceSwapFeeRouter", function () {
  async function deployFixture() {
    const [owner, user, recipient, outsider] = await ethers.getSigners();

    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    const jusd = (await MockERC20Factory.deploy("JuiceDollar", "JUSD", 18)) as unknown as MockERC20;
    const tokenIn = (await MockERC20Factory.deploy("USD Token", "USDT", 18)) as unknown as MockERC20;
    const tokenOut = (await MockERC20Factory.deploy("Output Token", "OUT", 18)) as unknown as MockERC20;
    const wcbtc = (await MockERC20Factory.deploy("Wrapped cBTC", "WCBTC", 18)) as unknown as MockERC20;
    await Promise.all([
      jusd.waitForDeployment(),
      tokenIn.waitForDeployment(),
      tokenOut.waitForDeployment(),
      wcbtc.waitForDeployment(),
    ]);

    const MockEquityFactory = await ethers.getContractFactory("MockEquity");
    const equity = (await MockEquityFactory.deploy(
      "Juice Protocol",
      "JUICE",
      await jusd.getAddress()
    )) as unknown as MockEquity;
    await equity.waitForDeployment();

    const MockSwapRouterFactory = await ethers.getContractFactory("MockSwapRouter");
    const swapRouter = (await MockSwapRouterFactory.deploy()) as unknown as MockSwapRouter;
    await swapRouter.waitForDeployment();

    const MockStablecoinBridgeFactory = await ethers.getContractFactory("MockStablecoinBridge");
    const bridge = (await MockStablecoinBridgeFactory.deploy(
      await tokenIn.getAddress(),
      await jusd.getAddress(),
      ethers.parseEther("1000000"),
      52
    )) as unknown as MockStablecoinBridge;
    await bridge.waitForDeployment();

    const FeeRouterFactory = await ethers.getContractFactory("JuiceSwapFeeRouter");
    const feeRouter = (await FeeRouterFactory.deploy(
      await jusd.getAddress(),
      await equity.getAddress(),
      await equity.getAddress(),
      await wcbtc.getAddress(),
      owner.address,
      [
        [await swapRouter.getAddress(), true, false],
        [await bridge.getAddress(), false, true],
      ]
    )) as unknown as JuiceSwapFeeRouter;
    await feeRouter.waitForDeployment();

    await jusd.mint(user.address, INITIAL_BALANCE);
    await tokenIn.mint(user.address, INITIAL_BALANCE);

    return { owner, user, recipient, outsider, jusd, tokenIn, tokenOut, wcbtc, equity, swapRouter, bridge, feeRouter };
  }

  async function deadline() {
    return (await time.latest()) + DEADLINE_OFFSET;
  }

  function protocolFee(amountIn: bigint) {
    return (amountIn * 25n + 9999n) / 10000n;
  }

  async function swapCalldata(
    swapRouter: MockSwapRouter,
    tokenIn: string,
    tokenOut: string,
    recipient: string,
    amountIn: bigint,
    amountOutMinimum = 0n
  ) {
    return swapRouter.interface.encodeFunctionData("exactInputSingle", [
      {
        tokenIn,
        tokenOut,
        fee: 3000,
        recipient,
        amountIn,
        amountOutMinimum,
        sqrtPriceLimitX96: 0,
      },
    ]);
  }

  async function jusdExactInputParams(
    fixture: Awaited<ReturnType<typeof deployFixture>>,
    amountIn: bigint,
    amountOut: bigint,
    recipientAddress = fixture.recipient.address,
    tradeOverride?: bigint
  ): Promise<FeeRouterParams> {
    const fee = protocolFee(amountIn);
    const tradeAmount = tradeOverride ?? amountIn - fee;
    await fixture.swapRouter.setSwapOutput(amountOut);

    return {
      tokenIn: await fixture.jusd.getAddress(),
      tokenOut: await fixture.tokenOut.getAddress(),
      recipient: recipientAddress,
      amountIn,
      amountOutMinimum: amountOut,
      deadline: await deadline(),
      target: await fixture.swapRouter.getAddress(),
      swapCalldata: await swapCalldata(
        fixture.swapRouter,
        await fixture.jusd.getAddress(),
        await fixture.tokenOut.getAddress(),
        await fixture.feeRouter.getAddress(),
        tradeAmount,
        amountOut
      ),
      feeConversionTarget: ethers.ZeroAddress,
      feeConversionCalldata: "0x",
      minJusdFeeOut: 0,
    };
  }

  it("charges a 25 bps ceiling fee on JUSD input and credits Equity", async function () {
    const fixture = await loadFixture(deployFixture);
    const { user, recipient, jusd, tokenOut, equity, swapRouter, feeRouter } = fixture;
    const amountIn = ethers.parseEther("1000");
    const amountOut = ethers.parseEther("900");
    const fee = protocolFee(amountIn);
    const tradeAmount = amountIn - fee;
    const params = await jusdExactInputParams(fixture, amountIn, amountOut);

    await jusd.connect(user).approve(await feeRouter.getAddress(), amountIn);

    await expect(feeRouter.connect(user).swapExactInput(params))
      .to.emit(feeRouter, "ProtocolFeeCharged")
      .withArgs(user.address, await jusd.getAddress(), amountIn, fee, tradeAmount)
      .and.to.emit(feeRouter, "FeeSwapExecuted")
      .withArgs(
        user.address,
        await swapRouter.getAddress(),
        await tokenOut.getAddress(),
        tradeAmount,
        amountOut,
        recipient.address
      );

    expect(await jusd.balanceOf(await equity.getAddress())).to.equal(fee);
    expect(await tokenOut.balanceOf(recipient.address)).to.equal(amountOut);
    expect(await jusd.balanceOf(await feeRouter.getAddress())).to.equal(0);
    expect(await jusd.allowance(await feeRouter.getAddress(), await swapRouter.getAddress())).to.equal(0);
    expect(await jusd.balanceOf(await swapRouter.getAddress())).to.equal(tradeAmount);
  });

  it("fails closed when ceiling fee consumes a tiny input", async function () {
    const fixture = await loadFixture(deployFixture);
    const { user, jusd, feeRouter } = fixture;
    const params = await jusdExactInputParams(fixture, 1n, 1n, fixture.recipient.address, 0n);

    await jusd.connect(user).approve(await feeRouter.getAddress(), 1n);

    await expect(feeRouter.connect(user).swapExactInput(params))
      .to.be.revertedWithCustomError(feeRouter, "InsufficientTradeAmount")
      .withArgs(1n, 1n);
  });

  it("converts non-JUSD fees through an allowlisted converter and clears approvals", async function () {
    const fixture = await loadFixture(deployFixture);
    const { user, recipient, tokenIn, tokenOut, jusd, equity, bridge, swapRouter, feeRouter } = fixture;
    const amountIn = ethers.parseEther("1000");
    const amountOut = ethers.parseEther("800");
    const fee = protocolFee(amountIn);
    const tradeAmount = amountIn - fee;

    await swapRouter.setSwapOutput(amountOut);
    await tokenIn.connect(user).approve(await feeRouter.getAddress(), amountIn);

    const params: FeeRouterParams = {
      tokenIn: await tokenIn.getAddress(),
      tokenOut: await tokenOut.getAddress(),
      recipient: recipient.address,
      amountIn,
      amountOutMinimum: amountOut,
      deadline: await deadline(),
      target: await swapRouter.getAddress(),
      swapCalldata: await swapCalldata(
        swapRouter,
        await tokenIn.getAddress(),
        await tokenOut.getAddress(),
        await feeRouter.getAddress(),
        tradeAmount,
        amountOut
      ),
      feeConversionTarget: await bridge.getAddress(),
      feeConversionCalldata: bridge.interface.encodeFunctionData("mintTo", [await feeRouter.getAddress(), fee]),
      minJusdFeeOut: fee,
    };

    await expect(feeRouter.connect(user).swapExactInput(params))
      .to.emit(feeRouter, "ProtocolFeeConverted")
      .withArgs(await tokenIn.getAddress(), await bridge.getAddress(), fee, fee);

    expect(await jusd.balanceOf(await equity.getAddress())).to.equal(fee);
    expect(await tokenIn.balanceOf(await bridge.getAddress())).to.equal(fee);
    expect(await tokenIn.balanceOf(await swapRouter.getAddress())).to.equal(tradeAmount);
    expect(await tokenOut.balanceOf(recipient.address)).to.equal(amountOut);
    expect(await tokenIn.allowance(await feeRouter.getAddress(), await bridge.getAddress())).to.equal(0);
    expect(await tokenIn.allowance(await feeRouter.getAddress(), await swapRouter.getAddress())).to.equal(0);
  });

  it("rejects unallowlisted swap targets and fee converters", async function () {
    const fixture = await loadFixture(deployFixture);
    const { user, jusd, tokenIn, tokenOut, swapRouter, bridge, feeRouter } = fixture;
    const amountIn = ethers.parseEther("100");
    const amountOut = ethers.parseEther("50");
    const jusdParams = await jusdExactInputParams(fixture, amountIn, amountOut);
    await jusd.connect(user).approve(await feeRouter.getAddress(), amountIn);

    await expect(
      feeRouter.connect(user).swapExactInput({
        ...jusdParams,
        target: await bridge.getAddress(),
      })
    )
      .to.be.revertedWithCustomError(feeRouter, "TargetNotAllowed")
      .withArgs(await bridge.getAddress());

    await tokenIn.connect(user).approve(await feeRouter.getAddress(), amountIn);
    const fee = protocolFee(amountIn);
    const tradeAmount = amountIn - fee;
    const params: FeeRouterParams = {
      tokenIn: await tokenIn.getAddress(),
      tokenOut: await tokenOut.getAddress(),
      recipient: fixture.recipient.address,
      amountIn,
      amountOutMinimum: amountOut,
      deadline: await deadline(),
      target: await swapRouter.getAddress(),
      swapCalldata: await swapCalldata(
        swapRouter,
        await tokenIn.getAddress(),
        await tokenOut.getAddress(),
        await feeRouter.getAddress(),
        tradeAmount,
        amountOut
      ),
      feeConversionTarget: await swapRouter.getAddress(),
      feeConversionCalldata: bridge.interface.encodeFunctionData("mintTo", [await feeRouter.getAddress(), fee]),
      minJusdFeeOut: fee,
    };

    await expect(feeRouter.connect(user).swapExactInput(params))
      .to.be.revertedWithCustomError(feeRouter, "FeeConverterNotAllowed")
      .withArgs(await swapRouter.getAddress());
  });

  it("refunds unspent trade input after a partial target pull", async function () {
    const fixture = await loadFixture(deployFixture);
    const { user, recipient, jusd, tokenOut, feeRouter } = fixture;
    const amountIn = ethers.parseEther("1000");
    const amountOut = ethers.parseEther("400");
    const fee = protocolFee(amountIn);
    const tradeAmount = amountIn - fee;
    const partialTrade = ethers.parseEther("600");
    const params = await jusdExactInputParams(fixture, amountIn, amountOut, recipient.address, partialTrade);

    await jusd.connect(user).approve(await feeRouter.getAddress(), amountIn);
    await feeRouter.connect(user).swapExactInput(params);

    expect(await tokenOut.balanceOf(recipient.address)).to.equal(amountOut);
    expect(await jusd.balanceOf(user.address)).to.equal(INITIAL_BALANCE - fee - partialTrade);
    expect(await jusd.balanceOf(await feeRouter.getAddress())).to.equal(0);
    expect(tradeAmount - partialTrade).to.be.greaterThan(0n);
  });

  it("requires swap output to be received by the FeeRouter and meet minimum output", async function () {
    const fixture = await loadFixture(deployFixture);
    const { user, jusd, feeRouter } = fixture;
    const amountIn = ethers.parseEther("1000");
    const amountOut = ethers.parseEther("500");
    const fee = protocolFee(amountIn);
    const tradeAmount = amountIn - fee;
    await fixture.swapRouter.setSwapOutput(amountOut);
    await jusd.connect(user).approve(await feeRouter.getAddress(), amountIn);

    const params: FeeRouterParams = {
      ...(await jusdExactInputParams(fixture, amountIn, amountOut)),
      swapCalldata: await swapCalldata(
        fixture.swapRouter,
        await jusd.getAddress(),
        await fixture.tokenOut.getAddress(),
        user.address,
        tradeAmount,
        amountOut
      ),
    };

    await expect(feeRouter.connect(user).swapExactInput(params))
      .to.be.revertedWithCustomError(feeRouter, "InsufficientOutput")
      .withArgs(0n, amountOut);
  });

  it("prevents a target from pulling more than the post-fee trade amount", async function () {
    const fixture = await loadFixture(deployFixture);
    const { user, jusd, tokenOut, swapRouter, feeRouter } = fixture;
    const amountIn = ethers.parseEther("100");
    const fee = protocolFee(amountIn);
    const tradeAmount = amountIn - fee;
    const params = await jusdExactInputParams(fixture, amountIn, ethers.parseEther("10"));
    await jusd.connect(user).approve(await feeRouter.getAddress(), amountIn);

    await expect(
      feeRouter.connect(user).swapExactInput({
        ...params,
        swapCalldata: await swapCalldata(
          swapRouter,
          await jusd.getAddress(),
          await tokenOut.getAddress(),
          await feeRouter.getAddress(),
          tradeAmount + 1n,
          0n
        ),
      })
    ).to.be.revertedWithCustomError(feeRouter, "TargetCallFailed");
  });

  it("fails closed for unsupported native, JUICE-input, same-token, expired, and zero-output routes", async function () {
    const fixture = await loadFixture(deployFixture);
    const { user, jusd, tokenOut, equity, feeRouter } = fixture;
    const amountIn = ethers.parseEther("100");
    await jusd.connect(user).approve(await feeRouter.getAddress(), amountIn);
    const baseParams = await jusdExactInputParams(fixture, amountIn, ethers.parseEther("10"));

    // The swap entrypoint is non-payable (no ETH custody path); native value is
    // rejected outright, and direct native sends revert with NativeUnsupported.
    await expect(user.sendTransaction({ to: await feeRouter.getAddress(), value: 1 })).to.be.revertedWithCustomError(
      feeRouter,
      "NativeUnsupported"
    );

    await expect(
      feeRouter.connect(user).swapExactInput({
        ...baseParams,
        tokenIn: await equity.getAddress(),
      })
    ).to.be.revertedWithCustomError(feeRouter, "JuiceInputUnsupported");

    await expect(
      feeRouter.connect(user).swapExactInput({
        ...baseParams,
        tokenOut: await jusd.getAddress(),
      })
    ).to.be.revertedWithCustomError(feeRouter, "SameTokenUnsupported");

    await expect(
      feeRouter.connect(user).swapExactInput({
        ...baseParams,
        deadline: (await time.latest()) - 1,
      })
    ).to.be.revertedWithCustomError(feeRouter, "DeadlineExpired");

    await expect(
      feeRouter.connect(user).swapExactInput({
        ...baseParams,
        swapCalldata: await swapCalldata(
          fixture.swapRouter,
          await jusd.getAddress(),
          await tokenOut.getAddress(),
          user.address,
          amountIn - protocolFee(amountIn),
          0n
        ),
        amountOutMinimum: 1n,
      })
    ).to.be.revertedWithCustomError(feeRouter, "InsufficientOutput");
  });

  it("rejects exact-output, multicall, and malformed swap calldata before target execution", async function () {
    const fixture = await loadFixture(deployFixture);
    const { user, jusd, feeRouter } = fixture;
    const amountIn = ethers.parseEther("100");
    const baseParams = await jusdExactInputParams(fixture, amountIn, ethers.parseEther("10"));
    const unsupportedSelectors = [
      "0x5023b4df",
      "0x09b81346",
      "0xdb3e2198",
      "0xf28c0498",
      "0x5d7ef810",
      "0x42712a67",
      "0x8803dbee",
      "0xac9650d8",
      "0x5ae401dc",
      "0x1f0464d1",
    ];

    await jusd.connect(user).approve(await feeRouter.getAddress(), amountIn);

    for (const selector of unsupportedSelectors) {
      await expect(
        feeRouter.connect(user).swapExactInput({
          ...baseParams,
          swapCalldata: selector,
        })
      ).to.be.revertedWithCustomError(feeRouter, "ExactOutputUnsupported");
    }

    await expect(
      feeRouter.connect(user).swapExactInput({
        ...baseParams,
        swapCalldata: "0x123456",
      })
    ).to.be.revertedWithCustomError(feeRouter, "InvalidCalldata");

    expect(await fixture.swapRouter.swapCallCount()).to.equal(0);
  });

  it("rejects reentrancy attempted by an allowlisted target", async function () {
    const fixture = await loadFixture(deployFixture);
    const { owner, user, recipient, jusd, tokenOut, feeRouter } = fixture;
    const ReentrantTargetFactory = await ethers.getContractFactory("MockFeeRouterReentrantTarget");
    const reentrantTarget = (await ReentrantTargetFactory.deploy()) as unknown as MockFeeRouterReentrantTarget;
    await reentrantTarget.waitForDeployment();
    await feeRouter.connect(owner).setFeeTarget(await reentrantTarget.getAddress(), true, false);

    const amountIn = ethers.parseEther("1000");
    const amountOut = ethers.parseEther("100");
    const fee = protocolFee(amountIn);
    const tradeAmount = amountIn - fee;
    const baseParams = await jusdExactInputParams(fixture, amountIn, amountOut);

    const reentrantParams: FeeRouterParams = {
      ...baseParams,
      target: await reentrantTarget.getAddress(),
      swapCalldata: reentrantTarget.interface.encodeFunctionData("swap", [
        {
          tokenIn: await jusd.getAddress(),
          tokenOut: await tokenOut.getAddress(),
          recipient: await feeRouter.getAddress(),
          amountIn: tradeAmount,
          amountOut,
        },
      ]),
    };
    await reentrantTarget.setAttack(
      await feeRouter.getAddress(),
      feeRouter.interface.encodeFunctionData("swapExactInput", [baseParams])
    );
    await reentrantTarget.setAttackEnabled(true);

    await jusd.connect(user).approve(await feeRouter.getAddress(), amountIn * 2n);
    await feeRouter.connect(user).swapExactInput(reentrantParams);

    expect(await reentrantTarget.reentrancyAttempted()).to.equal(true);
    expect(await reentrantTarget.reentrancySucceeded()).to.equal(false);
    expect(await tokenOut.balanceOf(recipient.address)).to.equal(amountOut);
  });

  describe("governance fee adjustment", function () {
    it("defaults to 25 bps, exposes the 5% cap, and is owned by the governance address", async function () {
      const { feeRouter, owner } = await loadFixture(deployFixture);
      expect(await feeRouter.protocolFeeBps()).to.equal(25);
      expect(await feeRouter.MAX_PROTOCOL_FEE_BPS()).to.equal(500);
      expect(await feeRouter.owner()).to.equal(owner.address);
    });

    it("lets the owner (governance) adjust the fee up to the 5% cap and emits the event", async function () {
      const { feeRouter, owner } = await loadFixture(deployFixture);
      await expect(feeRouter.connect(owner).setProtocolFeeBps(500))
        .to.emit(feeRouter, "ProtocolFeeBpsUpdated")
        .withArgs(25, 500);
      expect(await feeRouter.protocolFeeBps()).to.equal(500);
    });

    it("rejects a fee above the 5% cap", async function () {
      const { feeRouter, owner } = await loadFixture(deployFixture);
      await expect(feeRouter.connect(owner).setProtocolFeeBps(501))
        .to.be.revertedWithCustomError(feeRouter, "ProtocolFeeTooHigh")
        .withArgs(501, 500);
    });

    it("rejects fee and allowlist changes from a non-owner", async function () {
      const { feeRouter, outsider } = await loadFixture(deployFixture);
      await expect(feeRouter.connect(outsider).setProtocolFeeBps(50)).to.be.revertedWithCustomError(
        feeRouter,
        "OwnableUnauthorizedAccount"
      );
      await expect(
        feeRouter.connect(outsider).setFeeTarget(outsider.address, true, false)
      ).to.be.revertedWithCustomError(feeRouter, "OwnableUnauthorizedAccount");
    });
  });
});
