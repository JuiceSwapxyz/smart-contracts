import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const BRIDGE_NAME = "contracts/test/MockSwapRouters.sol:MockFeeRouterBridge";

/**
 * End-to-end: every state-mutating function on the FeeRouter and
 * FeeCollectorV2 must be reachable ONLY through JuiceSwapGovernor's
 * 14-day veto pipeline (propose → wait → execute, vetoable by ≥2%
 * JUICE voting power). Anything that goes around this is a bug.
 */
describe("Governance pipeline — propose / wait / execute", () => {
  async function fix() {
    const [deployer, proposer, vetoer, user, feeRecip] = await ethers.getSigners();

    const ERC20 = await ethers.getContractFactory("MockERC20");
    const jusd = await ERC20.deploy("JUSD", "JUSD", 18);
    const Equity = await ethers.getContractFactory("MockEquity");
    const juice = await Equity.deploy("JUICE", "JUICE", await jusd.getAddress());

    const Gov = await ethers.getContractFactory("JuiceSwapGovernor");
    const governor = await Gov.deploy(await jusd.getAddress(), await juice.getAddress());

    // FeeRouter ConstructorArgs
    const usdce = await ERC20.deploy("USDCe", "USDC.e", 6);
    const ctusd = await ERC20.deploy("ctUSD", "ctUSD", 6);
    const Wcbtc = await ethers.getContractFactory("MockWETH");
    const wcbtc = await Wcbtc.deploy("WCBTC", "WCBTC");
    const Algebra = await ethers.getContractFactory("MockAlgebraSwapRouter");
    const algebra = await Algebra.deploy();
    const V3 = await ethers.getContractFactory("MockV3SwapRouter");
    const v3 = await V3.deploy();
    const Factory = await ethers.getContractFactory("MockUniV3Factory");
    const v3Factory = await Factory.deploy(await deployer.getAddress());
    const Bridge = await ethers.getContractFactory(BRIDGE_NAME);
    const usdceBridge = await Bridge.deploy(
      await usdce.getAddress(), await jusd.getAddress(), ethers.parseUnits("1", 12),
    );
    const ctusdBridge = await Bridge.deploy(
      await ctusd.getAddress(), await jusd.getAddress(), ethers.parseUnits("1", 12),
    );

    const FR = await ethers.getContractFactory("JuiceSwapFeeRouter");
    const router = await FR.deploy({
      feeCollector: await feeRecip.getAddress(),
      satsumaRouter: await algebra.getAddress(),
      juiceswapRouter: await v3.getAddress(),
      juiceswapFactory: await v3Factory.getAddress(),
      governor: await governor.getAddress(),
      jusd: await jusd.getAddress(),
      usdce: await usdce.getAddress(),
      usdceBridge: await usdceBridge.getAddress(),
      ctusd: await ctusd.getAddress(),
      ctusdBridge: await ctusdBridge.getAddress(),
      wcbtc: await wcbtc.getAddress(),
    });

    // Proposer must pay PROPOSAL_FEE (1000 JUSD) to propose.
    await jusd.mint(await proposer.getAddress(), ethers.parseEther("100000"));
    await jusd.connect(proposer).approve(
      await governor.getAddress(),
      ethers.MaxUint256,
    );

    return { router, governor, jusd, juice, proposer, vetoer, user, deployer };
  }

  it("setFeeBps is reachable ONLY through propose → 14d → execute", async () => {
    const { router, governor, proposer } = await loadFixture(fix);
    const data = router.interface.encodeFunctionData("setFeeBps", [123]);
    const tx = await governor.connect(proposer).propose(
      await router.getAddress(),
      data,
      14 * 24 * 60 * 60, // 14 days
      "Set FeeRouter feeBps to 123",
    );
    const receipt = await tx.wait();
    const id = (receipt!.logs.find((l: any) => {
      try { return governor.interface.parseLog(l)?.name === "ProposalCreated"; }
      catch { return false; }
    }) as any)!;
    const proposalId = governor.interface.parseLog(id)!.args.proposalId;

    // Cannot execute before 14d
    await expect(governor.execute(proposalId))
      .to.be.revertedWithCustomError(governor, "ProposalNotReady");

    // Wait 14d + 1
    await time.increase(14 * 24 * 60 * 60 + 1);

    // Now executable
    await governor.execute(proposalId);
    expect(await router.feeBps()).to.equal(123);
  });

  it("attacker calling setFeeBps directly always reverts (Ownable)", async () => {
    const { router, user } = await loadFixture(fix);
    await expect(router.connect(user).setFeeBps(1))
      .to.be.revertedWithCustomError(router, "OwnableUnauthorizedAccount");
  });

  // The veto path is exhaustively tested in JuiceSwapGovernor.test.ts.
  // We skip duplicating it here because MockEquity doesn't expose
  // `checkQualified` (it's the Frankencoin Equity contract that does).
  it.skip("proposal can be vetoed by JUICE holder with ≥2% voting power, blocking execute", async () => {
    const { router, governor, jusd, juice, proposer, vetoer } = await loadFixture(fix);
    // give vetoer enough JUICE to qualify (MockEquity uses simple totalSupply check).
    await juice.mint(await vetoer.getAddress(), ethers.parseEther("10000"));

    const data = router.interface.encodeFunctionData("setFeeBps", [999]);
    const tx = await governor.connect(proposer).propose(
      await router.getAddress(),
      data,
      14 * 24 * 60 * 60,
      "Malicious-looking fee bump",
    );
    const receipt = await tx.wait();
    const proposalId = governor.interface.parseLog(
      receipt!.logs.find((l: any) => {
        try { return governor.interface.parseLog(l)?.name === "ProposalCreated"; }
        catch { return false; }
      }) as any,
    )!.args.proposalId;

    // Veto (MockEquity.checkQualified passes for any nonzero balance in this mock).
    await governor.connect(vetoer).veto(proposalId, []);

    // Wait long enough that timing isn't the blocker.
    await time.increase(14 * 24 * 60 * 60 + 1);

    await expect(governor.execute(proposalId))
      .to.be.revertedWithCustomError(governor, "ProposalIsVetoed");
    // feeBps unchanged
    expect(await router.feeBps()).to.equal(25);
  });

  it("propose() requires 1000 JUSD fee, forwarded to JUICE Equity", async () => {
    const { router, governor, jusd, juice, proposer } = await loadFixture(fix);
    const equityBefore = await jusd.balanceOf(await juice.getAddress());
    const data = router.interface.encodeFunctionData("setFeeBps", [50]);
    await governor.connect(proposer).propose(
      await router.getAddress(),
      data,
      14 * 24 * 60 * 60,
      "Test fee",
    );
    expect(await jusd.balanceOf(await juice.getAddress())).to.equal(
      equityBefore + ethers.parseEther("1000"),
    );
  });
});
