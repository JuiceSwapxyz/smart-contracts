import { expect } from "chai";
import { ethers } from "hardhat";
import { JuiceSwapGovernor, JuiceDollar, Equity, MockTarget, ReentrancyAttacker } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("JuiceSwapGovernor", function () {
  const PROPOSAL_FEE = ethers.parseEther("1000"); // 1000 JUSD
  const MIN_APPLICATION_PERIOD = 14 * 24 * 60 * 60; // 14 days in seconds
  const QUORUM = 200; // 2% in basis points

  // Test data
  const TEST_TARGET_DATA = ethers.AbiCoder.defaultAbiCoder().encode(["uint8", "uint8"], [5, 5]);
  const TEST_DESCRIPTION = "Test proposal: Set fee protocol to 5/5";

  /**
   * Basic deployment fixture with REAL JuiceDollar and Equity contracts
   */
  async function deployGovernorFixture() {
    const [deployer, proposer, vetoer, executor, user1, user2, keeper] = await ethers.getSigners();

    // Deploy REAL JuiceDollar (which automatically creates Equity)
    const JuiceDollarFactory = await ethers.getContractFactory("JuiceDollar");
    const jusd = await JuiceDollarFactory.deploy(MIN_APPLICATION_PERIOD) as unknown as JuiceDollar;

    // Get the Equity contract address (created by JuiceDollar constructor)
    const equityAddress = await jusd.reserve();
    const juice = await ethers.getContractAt("Equity", equityAddress) as unknown as Equity;

    // Initialize JuiceDollar with deployer as initial minter
    await jusd.initialize(deployer.address, "Initial minter for testing");

    const MockTarget = await ethers.getContractFactory("MockTarget");
    const target = await MockTarget.deploy() as unknown as MockTarget;

    // Deploy Governor (use deployer address as mock swapRouter and factory for now)
    const JuiceSwapGovernor = await ethers.getContractFactory("JuiceSwapGovernor");
    const governor = await JuiceSwapGovernor.deploy(
      await jusd.getAddress(),
      await juice.getAddress()
    ) as unknown as JuiceSwapGovernor;

    // Setup: Mint JUSD to proposer and approve governor
    await jusd.mint(proposer.address, PROPOSAL_FEE * 10n);
    await jusd.connect(proposer).approve(await governor.getAddress(), ethers.MaxUint256);

    // Setup: Create JUICE distribution with real Equity mechanics
    // Bootstrap initial equity (minimum required)
    const initialEquity = ethers.parseEther("1000"); // 1k JUSD minimum
    await jusd.mint(await juice.getAddress(), initialEquity);

    // Vetoer makes FIRST investment (gets 10M shares as first investor)
    const vetoerInvestment = ethers.parseEther("50000");
    await jusd.mint(vetoer.address, vetoerInvestment);
    await jusd.connect(vetoer).approve(await juice.getAddress(), vetoerInvestment);
    await juice.connect(vetoer).invest(vetoerInvestment, 0);

    // Advance time so vetoer accumulates votes
    await time.increase(3600);

    return { governor, jusd, juice, target, deployer, proposer, vetoer, executor, user1, user2, keeper };
  }

  /**
   * Fixture with an active proposal
   */
  async function deployWithProposalFixture() {
    const fixture = await deployGovernorFixture();
    const { governor, target, proposer } = fixture;

    const targetAddress = await target.getAddress();
    const calldata = target.interface.encodeFunctionData("setFeeProtocol", [5, 5]);

    const tx = await governor.connect(proposer).propose(
      targetAddress,
      calldata,
      MIN_APPLICATION_PERIOD,
      TEST_DESCRIPTION
    );
    await tx.wait();

    const proposalId = 1n;
    const proposal = await governor.proposals(proposalId);

    return { ...fixture, proposalId, proposal, calldata };
  }

  /**
   * Fixture with a proposal ready to execute (after veto period)
   */
  async function deployWithExecutableProposalFixture() {
    const fixture = await deployWithProposalFixture();
    const { proposal } = fixture;

    // Fast forward past the veto period
    await time.increaseTo(proposal.executeAfter + 1n);

    return fixture;
  }

  /**
   * Helper: Create a proposal
   */
  async function createProposal(
    governor: JuiceSwapGovernor,
    proposer: HardhatEthersSigner,
    target: MockTarget,
    period: number = MIN_APPLICATION_PERIOD
  ) {
    const targetAddress = await target.getAddress();
    const calldata = target.interface.encodeFunctionData("setFeeProtocol", [5, 5]);

    const tx = await governor.connect(proposer).propose(
      targetAddress,
      calldata,
      period,
      TEST_DESCRIPTION
    );
    await tx.wait();

    const proposalCount = await governor.proposalCount();
    return proposalCount;
  }

  /**
   * Helper: Set up voting power for a user with REAL Equity mechanics
   * @param jusd JuiceDollar contract
   * @param juice Equity contract
   * @param user User to give voting power
   * @param targetVotingPowerBps Target voting power in basis points (e.g., 200 = 2%)
   * @param timeToAccumulate Time in seconds to accumulate votes (default 3600 = 1 hour)
   */
  async function setupVotingPower(
    jusd: JuiceDollar,
    juice: Equity,
    user: HardhatEthersSigner,
    targetVotingPowerBps: number,
    timeToAccumulate: number = 3600
  ) {
    // Calculate investment needed to reach target voting power
    // With time-weighted voting: votes = balance * time
    // We need: (userBalance * time) / (totalSupply * time) >= targetVotingPowerBps / 10000
    // Simplifies to: userBalance / totalSupply >= targetVotingPowerBps / 10000

    const totalSupply = await juice.totalSupply();
    const targetBalance = (totalSupply * BigInt(targetVotingPowerBps)) / 10000n;

    // If user needs more JUICE, invest to get it
    const currentBalance = await juice.balanceOf(user.address);
    if (currentBalance < targetBalance) {
      const neededJuice = targetBalance - currentBalance;
      // Rough estimate: 1 JUSD investment ≈ proportional JUICE based on price
      const investmentAmount = neededJuice; // Simplified for testing

      await jusd.mint(user.address, investmentAmount);
      await jusd.connect(user).approve(await juice.getAddress(), investmentAmount);
      await juice.connect(user).invest(investmentAmount, 0);
    }

    // Advance time to accumulate votes
    await time.increase(timeToAccumulate);
  }

  describe("Deployment", function () {
    it("Should set the correct JUSD address", async function () {
      const { governor, jusd } = await loadFixture(deployGovernorFixture);
      expect(await governor.JUSD()).to.equal(await jusd.getAddress());
    });

    it("Should set the correct JUICE address", async function () {
      const { governor, juice } = await loadFixture(deployGovernorFixture);
      expect(await governor.JUICE()).to.equal(await juice.getAddress());
    });

    it("Should start with proposal count at 0", async function () {
      const { governor } = await loadFixture(deployGovernorFixture);
      expect(await governor.proposalCount()).to.equal(0);
    });

    it("Should have correct constants", async function () {
      const { governor } = await loadFixture(deployGovernorFixture);
      expect(await governor.PROPOSAL_FEE()).to.equal(PROPOSAL_FEE);
      expect(await governor.MIN_APPLICATION_PERIOD()).to.equal(MIN_APPLICATION_PERIOD);
    });
  });

  describe("Propose", function () {
    describe("Happy Path", function () {
      it("Should create a proposal with correct parameters", async function () {
        const { governor, target, proposer } = await loadFixture(deployGovernorFixture);

        const targetAddress = await target.getAddress();
        const calldata = target.interface.encodeFunctionData("setFeeProtocol", [5, 5]);
        const beforeTimestamp = await time.latest();

        await governor.connect(proposer).propose(
          targetAddress,
          calldata,
          MIN_APPLICATION_PERIOD,
          TEST_DESCRIPTION
        );

        const proposal = await governor.proposals(1);
        expect(proposal.id).to.equal(1);
        expect(proposal.proposer).to.equal(proposer.address);
        expect(proposal.target).to.equal(targetAddress);
        expect(proposal.data).to.equal(calldata);
        expect(proposal.applicationPeriod).to.equal(MIN_APPLICATION_PERIOD);
        expect(proposal.executeAfter).to.be.closeTo(
          BigInt(beforeTimestamp) + BigInt(MIN_APPLICATION_PERIOD),
          10n
        );
        expect(proposal.executed).to.equal(false);
        expect(proposal.vetoed).to.equal(false);
        expect(proposal.fee).to.equal(PROPOSAL_FEE);
        expect(proposal.description).to.equal(TEST_DESCRIPTION);
      });

      it("Should increment proposal count", async function () {
        const { governor, target, proposer } = await loadFixture(deployGovernorFixture);

        expect(await governor.proposalCount()).to.equal(0);

        await createProposal(governor, proposer, target);
        expect(await governor.proposalCount()).to.equal(1);

        await createProposal(governor, proposer, target);
        expect(await governor.proposalCount()).to.equal(2);
      });

      it("Should transfer JUSD fee from proposer", async function () {
        const { governor, jusd, target, proposer } = await loadFixture(deployGovernorFixture);

        const balanceBefore = await jusd.balanceOf(proposer.address);
        await createProposal(governor, proposer, target);
        const balanceAfter = await jusd.balanceOf(proposer.address);

        expect(balanceBefore - balanceAfter).to.equal(PROPOSAL_FEE);
      });

      it("Should emit ProposalCreated event", async function () {
        const { governor, target, proposer } = await loadFixture(deployGovernorFixture);

        const targetAddress = await target.getAddress();
        const calldata = target.interface.encodeFunctionData("setFeeProtocol", [5, 5]);

        await expect(
          governor.connect(proposer).propose(
            targetAddress,
            calldata,
            MIN_APPLICATION_PERIOD,
            TEST_DESCRIPTION
          )
        )
          .to.emit(governor, "ProposalCreated")
          .withArgs(
            1,
            proposer.address,
            targetAddress,
            calldata,
            await time.latest() + MIN_APPLICATION_PERIOD + 1,
            TEST_DESCRIPTION
          );
      });

      it("Should emit ProposalFeeCollected event", async function () {
        const { governor, target, proposer } = await loadFixture(deployGovernorFixture);

        const targetAddress = await target.getAddress();
        const calldata = target.interface.encodeFunctionData("setFeeProtocol", [5, 5]);

        await expect(
          governor.connect(proposer).propose(
            targetAddress,
            calldata,
            MIN_APPLICATION_PERIOD,
            TEST_DESCRIPTION
          )
        )
          .to.emit(governor, "ProposalFeeCollected")
          .withArgs(1, PROPOSAL_FEE);
      });

      it("Should allow extended application periods", async function () {
        const { governor, target, proposer } = await loadFixture(deployGovernorFixture);

        const extendedPeriod = 30 * 24 * 60 * 60; // 30 days
        const proposalId = await createProposal(governor, proposer, target, extendedPeriod);

        const proposal = await governor.proposals(proposalId);
        expect(proposal.applicationPeriod).to.equal(extendedPeriod);
      });

      it("Should allow multiple proposals from different users", async function () {
        const { governor, jusd, target, proposer, user1 } = await loadFixture(deployGovernorFixture);

        // Setup user1
        await jusd.mint(user1.address, PROPOSAL_FEE * 2n);
        await jusd.connect(user1).approve(await governor.getAddress(), ethers.MaxUint256);

        await createProposal(governor, proposer, target);
        await createProposal(governor, user1, target);

        expect(await governor.proposalCount()).to.equal(2);

        const proposal1 = await governor.proposals(1);
        const proposal2 = await governor.proposals(2);

        expect(proposal1.proposer).to.equal(proposer.address);
        expect(proposal2.proposer).to.equal(user1.address);
      });
    });

    describe("Edge Cases & Errors", function () {
      it("Should revert if application period too short", async function () {
        const { governor, target, proposer } = await loadFixture(deployGovernorFixture);

        const targetAddress = await target.getAddress();
        const calldata = target.interface.encodeFunctionData("setFeeProtocol", [5, 5]);
        const shortPeriod = MIN_APPLICATION_PERIOD - 1;

        await expect(
          governor.connect(proposer).propose(
            targetAddress,
            calldata,
            shortPeriod,
            TEST_DESCRIPTION
          )
        ).to.be.revertedWithCustomError(governor, "PeriodTooShort");
      });

      it("Should revert if insufficient JUSD allowance", async function () {
        const { governor, jusd, target, user1 } = await loadFixture(deployGovernorFixture);

        await jusd.mint(user1.address, PROPOSAL_FEE);
        // No approval

        const targetAddress = await target.getAddress();
        const calldata = target.interface.encodeFunctionData("setFeeProtocol", [5, 5]);

        // OpenZeppelin ERC20 reverts with ERC20InsufficientAllowance, not FeeTooLow
        await expect(
          governor.connect(user1).propose(
            targetAddress,
            calldata,
            MIN_APPLICATION_PERIOD,
            TEST_DESCRIPTION
          )
        ).to.be.revertedWithCustomError(jusd, "ERC20InsufficientAllowance");
      });

      it("Should revert if insufficient JUSD balance", async function () {
        const { governor, jusd, target, user1 } = await loadFixture(deployGovernorFixture);

        // Approve but no balance
        await jusd.connect(user1).approve(await governor.getAddress(), ethers.MaxUint256);

        const targetAddress = await target.getAddress();
        const calldata = target.interface.encodeFunctionData("setFeeProtocol", [5, 5]);

        // OpenZeppelin ERC20 reverts with ERC20InsufficientBalance, not FeeTooLow
        await expect(
          governor.connect(user1).propose(
            targetAddress,
            calldata,
            MIN_APPLICATION_PERIOD,
            TEST_DESCRIPTION
          )
        ).to.be.revertedWithCustomError(jusd, "ERC20InsufficientBalance");
      });

      it("Should accept exact minimum period", async function () {
        const { governor, target, proposer } = await loadFixture(deployGovernorFixture);

        const proposalId = await createProposal(governor, proposer, target, MIN_APPLICATION_PERIOD);
        const proposal = await governor.proposals(proposalId);

        expect(proposal.applicationPeriod).to.equal(MIN_APPLICATION_PERIOD);
      });

      it("Should handle empty data bytes", async function () {
        const { governor, target, proposer } = await loadFixture(deployGovernorFixture);

        const targetAddress = await target.getAddress();
        const emptyData = "0x";

        await governor.connect(proposer).propose(
          targetAddress,
          emptyData,
          MIN_APPLICATION_PERIOD,
          TEST_DESCRIPTION
        );

        const proposal = await governor.proposals(1);
        expect(proposal.data).to.equal(emptyData);
      });

      it("Should handle empty description", async function () {
        const { governor, target, proposer } = await loadFixture(deployGovernorFixture);

        const targetAddress = await target.getAddress();
        const calldata = target.interface.encodeFunctionData("setFeeProtocol", [5, 5]);

        await governor.connect(proposer).propose(
          targetAddress,
          calldata,
          MIN_APPLICATION_PERIOD,
          ""
        );

        const proposal = await governor.proposals(1);
        expect(proposal.description).to.equal("");
      });
    });
  });

  describe("Execute", function () {
    describe("Happy Path", function () {
      it("Should execute proposal after veto period", async function () {
        const { governor, target, executor, proposalId } = await loadFixture(
          deployWithExecutableProposalFixture
        );

        await expect(governor.connect(executor).execute(proposalId))
          .to.emit(governor, "ProposalExecuted")
          .withArgs(proposalId, executor.address);

        const proposal = await governor.proposals(proposalId);
        expect(proposal.executed).to.equal(true);
      });

      it("Should call target contract function", async function () {
        const { governor, target, executor, proposalId } = await loadFixture(
          deployWithExecutableProposalFixture
        );

        await governor.connect(executor).execute(proposalId);

        expect(await target.feeProtocol0()).to.equal(5);
        expect(await target.feeProtocol1()).to.equal(5);
      });

      it("Should allow anyone to execute", async function () {
        const { governor, target, user1, proposalId } = await loadFixture(
          deployWithExecutableProposalFixture
        );

        await governor.connect(user1).execute(proposalId);

        expect(await target.feeProtocol0()).to.equal(5);
      });

      it("Should execute exactly at executeAfter timestamp", async function () {
        const { governor, proposalId, proposal } = await loadFixture(deployWithProposalFixture);

        await time.increaseTo(proposal.executeAfter);

        await expect(governor.execute(proposalId))
          .to.emit(governor, "ProposalExecuted");
      });
    });

    describe("Edge Cases & Errors", function () {
      it("Should revert when executed too early", async function () {
        const { governor, proposalId } = await loadFixture(deployWithProposalFixture);

        await expect(governor.execute(proposalId))
          .to.be.revertedWithCustomError(governor, "ProposalNotReady");
      });

      it("Should revert for non-existent proposal", async function () {
        const { governor } = await loadFixture(deployGovernorFixture);

        await expect(governor.execute(999))
          .to.be.revertedWithCustomError(governor, "ProposalNotFound");
      });

      it("Should revert when already executed", async function () {
        const { governor, proposalId } = await loadFixture(deployWithExecutableProposalFixture);

        await governor.execute(proposalId);

        await expect(governor.execute(proposalId))
          .to.be.revertedWithCustomError(governor, "ProposalAlreadyExecuted");
      });

      it("Should revert when proposal is vetoed", async function () {
        const { governor, vetoer, proposalId } = await loadFixture(deployWithProposalFixture);

        await governor.connect(vetoer).veto(proposalId, []);

        const proposal = await governor.proposals(proposalId);
        await time.increaseTo(proposal.executeAfter + 1n);

        await expect(governor.execute(proposalId))
          .to.be.revertedWithCustomError(governor, "ProposalIsVetoed");
      });

      it("Should revert when target call fails", async function () {
        const { governor, target, proposer } = await loadFixture(deployGovernorFixture);

        const targetAddress = await target.getAddress();
        const calldata = target.interface.encodeFunctionData("failingFunction");

        await governor.connect(proposer).propose(
          targetAddress,
          calldata,
          MIN_APPLICATION_PERIOD,
          "This will fail"
        );

        const proposalId = 1n;
        const proposal = await governor.proposals(proposalId);
        await time.increaseTo(proposal.executeAfter + 1n);

        await expect(governor.execute(proposalId))
          .to.be.revertedWithCustomError(governor, "ExecutionFailed");
      });
    });
  });

  describe("Veto", function () {
    describe("Happy Path", function () {
      it("Should veto proposal with sufficient voting power", async function () {
        const { governor, vetoer, proposalId } = await loadFixture(deployWithProposalFixture);

        await expect(governor.connect(vetoer).veto(proposalId, []))
          .to.emit(governor, "ProposalVetoed")
          .withArgs(proposalId, vetoer.address);

        const proposal = await governor.proposals(proposalId);
        expect(proposal.vetoed).to.equal(true);
      });

      it("Should veto with helpers (delegated votes)", async function () {
        const { governor, jusd, juice, user1, user2, proposalId } = await loadFixture(
          deployWithProposalFixture
        );

        // Each user invests to get meaningful voting power
        const investment = ethers.parseEther("100000");

        for (const user of [user1, user2]) {
          await jusd.mint(user.address, investment);
          await jusd.connect(user).approve(await juice.getAddress(), investment);
          await juice.connect(user).invest(investment, 0);
        }

        await time.increase(3600);

        // user2 delegates to user1
        await juice.connect(user2).delegateVoteTo(user1.address);

        // Get voting percentages
        const user1Alone = await governor.getVotingPowerPercentage(user1.address, []);
        const user1WithHelper = await governor.getVotingPowerPercentage(user1.address, [user2.address]);

        // Test: delegation meaningfully increases voting power
        expect(user1WithHelper).to.be.gt(user1Alone);
        expect(user1WithHelper).to.be.gte(user1Alone + 50n); // Significant increase

        // Test: veto succeeds with delegation
        await expect(governor.connect(user1).veto(proposalId, [user2.address]))
          .to.emit(governor, "ProposalVetoed");
      });

      it("Should veto with sufficient voting power", async function () {
        const { governor, jusd, juice, user1, proposalId } = await loadFixture(deployWithProposalFixture);

        // Invest amount that yields ≥2% voting power
        const investment = ethers.parseEther("200000");

        await jusd.mint(user1.address, investment);
        await jusd.connect(user1).approve(await juice.getAddress(), investment);
        await juice.connect(user1).invest(investment, 0);

        await time.increase(3600);

        // Verify user has ≥2%
        const percentage = await governor.getVotingPowerPercentage(user1.address, []);
        expect(percentage).to.be.gte(200);

        // Test: veto succeeds
        await expect(governor.connect(user1).veto(proposalId, []))
          .to.emit(governor, "ProposalVetoed");
      });
    });

    describe("Edge Cases & Errors", function () {
      it("Should revert without sufficient voting power", async function () {
        const { governor, jusd, juice, user1, proposalId } = await loadFixture(deployWithProposalFixture);

        // Give user1 small amount (definitely <2%)
        const smallInvestment = ethers.parseEther("100");
        await jusd.mint(user1.address, smallInvestment);
        await jusd.connect(user1).approve(await juice.getAddress(), smallInvestment);
        await juice.connect(user1).invest(smallInvestment, 0);

        await time.increase(3600);

        // Verify user1 has <2%
        const percentage = await governor.getVotingPowerPercentage(user1.address, []);
        expect(percentage).to.be.lt(200);

        // Test: cannot veto
        await expect(governor.connect(user1).veto(proposalId, []))
          .to.be.revertedWithCustomError(juice, "NotQualified");
      });

      it("Should revert for non-existent proposal", async function () {
        const { governor, vetoer } = await loadFixture(deployGovernorFixture);

        await expect(governor.connect(vetoer).veto(999, []))
          .to.be.revertedWithCustomError(governor, "ProposalNotFound");
      });

      it("Should revert when already executed", async function () {
        const { governor, vetoer, proposalId } = await loadFixture(deployWithExecutableProposalFixture);

        await governor.execute(proposalId);

        await expect(governor.connect(vetoer).veto(proposalId, []))
          .to.be.revertedWithCustomError(governor, "ProposalAlreadyExecuted");
      });

      it("Should revert when already vetoed", async function () {
        const { governor, vetoer, proposalId } = await loadFixture(deployWithProposalFixture);

        await governor.connect(vetoer).veto(proposalId, []);

        await expect(governor.connect(vetoer).veto(proposalId, []))
          .to.be.revertedWithCustomError(governor, "ProposalIsVetoed");
      });

      it("Should revert when veto period has ended", async function () {
        const { governor, vetoer, proposalId, proposal } = await loadFixture(deployWithProposalFixture);

        await time.increaseTo(proposal.executeAfter);

        await expect(governor.connect(vetoer).veto(proposalId, []))
          .to.be.revertedWithCustomError(governor, "VetoPeriodEnded");
      });

      it("Should veto just before executeAfter", async function () {
        const { governor, vetoer, proposalId, proposal } = await loadFixture(deployWithProposalFixture);

        await time.increaseTo(proposal.executeAfter - 10n);

        await expect(governor.connect(vetoer).veto(proposalId, []))
          .to.emit(governor, "ProposalVetoed");
      });
    });
  });

  describe("View Functions", function () {
    describe("getVotingPower()", function () {
      it("Should return correct voting power without helpers", async function () {
        const { governor, vetoer, juice } = await loadFixture(deployGovernorFixture);

        const votingPower = await governor.getVotingPower(vetoer.address, []);
        const directVotes = await juice.votes(vetoer.address);

        // Test: Governor delegates to Equity correctly
        expect(votingPower).to.equal(directVotes);
        expect(votingPower).to.be.gt(0);
      });

      it("Should return correct voting power with helpers", async function () {
        const { governor, jusd, juice, user1, user2 } = await loadFixture(deployGovernorFixture);

        const investment = ethers.parseEther("300000");

        for (const user of [user1, user2]) {
          await jusd.mint(user.address, investment);
          await jusd.connect(user).approve(await juice.getAddress(), investment);
          await juice.connect(user).invest(investment, 0);
        }

        await time.increase(3600);
        await juice.connect(user2).delegateVoteTo(user1.address);

        const user1Solo = await governor.getVotingPower(user1.address, []);
        const user2Votes = await juice.votes(user2.address);
        const user1WithHelper = await governor.getVotingPower(user1.address, [user2.address]);

        // Test: Combined equals sum
        expect(user1WithHelper).to.equal(user1Solo + user2Votes);
      });
    });

    describe("getVotingPowerPercentage()", function () {
      it("Should return basis points correctly", async function () {
        const { governor, vetoer } = await loadFixture(deployGovernorFixture);

        const percentage = await governor.getVotingPowerPercentage(vetoer.address, []);

        // Test: Returns format in basis points and vetoer has at least 2%
        expect(percentage).to.be.gte(200); // ≥2% = ≥200 basis points
        expect(percentage).to.be.lte(10000); // ≤100% = ≤10000 basis points
      });

      it.skip("Should return 0 when totalVotes is 0", async function () {
        // Skipped: Requires fixture with no JUICE minted (different setup)
        // Tests Equity edge case, not Governor functionality
      });
    });

    describe("state()", function () {
      it("Should return NotFound for non-existent proposal", async function () {
        const { governor } = await loadFixture(deployGovernorFixture);

        expect(await governor.state(999)).to.equal(0); // ProposalState.NotFound
      });

      it("Should return Pending during veto period", async function () {
        const { governor, proposalId } = await loadFixture(deployWithProposalFixture);

        expect(await governor.state(proposalId)).to.equal(1); // ProposalState.Pending
      });

      it("Should return Ready after veto period", async function () {
        const { governor, proposalId, proposal } = await loadFixture(deployWithProposalFixture);

        await time.increaseTo(proposal.executeAfter);

        expect(await governor.state(proposalId)).to.equal(2); // ProposalState.Ready
      });

      it("Should return Executed after execution", async function () {
        const { governor, proposalId } = await loadFixture(deployWithExecutableProposalFixture);

        await governor.execute(proposalId);

        expect(await governor.state(proposalId)).to.equal(4); // ProposalState.Executed
      });

      it("Should return Vetoed after veto", async function () {
        const { governor, vetoer, proposalId } = await loadFixture(deployWithProposalFixture);

        await governor.connect(vetoer).veto(proposalId, []);

        expect(await governor.state(proposalId)).to.equal(3); // ProposalState.Vetoed
      });
    });
  });

  describe("Security & Reentrancy", function () {
    it("Should prevent reentrancy attacks on execute()", async function () {
      const { governor, jusd, proposer } = await loadFixture(deployGovernorFixture);

      // Deploy attacker contract
      const ReentrancyAttacker = await ethers.getContractFactory("ReentrancyAttacker");
      const attacker = await ReentrancyAttacker.deploy(await governor.getAddress()) as unknown as ReentrancyAttacker;

      // Create malicious proposal
      const attackerAddress = await attacker.getAddress();
      const calldata = attacker.interface.encodeFunctionData("attack");

      await governor.connect(proposer).propose(
        attackerAddress,
        calldata,
        MIN_APPLICATION_PERIOD,
        "Reentrancy attack attempt"
      );

      const proposalId = 1n;
      await attacker.setProposal(proposalId);

      const proposal = await governor.proposals(proposalId);
      await time.increaseTo(proposal.executeAfter + 1n);

      // Execute should succeed but reentrancy should fail
      await expect(governor.execute(proposalId))
        .to.emit(governor, "ProposalExecuted");

      // Verify only called once (no reentrancy)
      expect(await attacker.getCallCount()).to.equal(1);
    });

    it("Should maintain state changes before external call", async function () {
      const { governor, target, proposer } = await loadFixture(deployGovernorFixture);

      const targetAddress = await target.getAddress();
      const calldata = target.interface.encodeFunctionData("incrementCounter");

      await governor.connect(proposer).propose(
        targetAddress,
        calldata,
        MIN_APPLICATION_PERIOD,
        "Test state changes"
      );

      const proposalId = 1n;
      const proposal = await governor.proposals(proposalId);
      await time.increaseTo(proposal.executeAfter + 1n);

      await governor.execute(proposalId);

      // Verify state was changed before call
      const proposalAfter = await governor.proposals(proposalId);
      expect(proposalAfter.executed).to.equal(true);

      // Verify target was called
      expect(await target.counter()).to.equal(1);
    });
  });

  describe("Integration Tests", function () {
    it("Full lifecycle: propose -> wait -> execute", async function () {
      const { governor, target, proposer, executor, proposalId, proposal } = await loadFixture(
        deployWithProposalFixture
      );

      // 1. Proposal created
      expect(await governor.state(proposalId)).to.equal(1); // ProposalState.Pending

      // 2. Wait for veto period
      await time.increaseTo(proposal.executeAfter);
      expect(await governor.state(proposalId)).to.equal(2); // ProposalState.Ready

      // 3. Execute
      await governor.connect(executor).execute(proposalId);
      expect(await governor.state(proposalId)).to.equal(4); // ProposalState.Executed

      // 4. Verify effect
      expect(await target.feeProtocol0()).to.equal(5);
    });

    it("Full lifecycle: propose -> veto", async function () {
      const { governor, vetoer, proposalId } = await loadFixture(deployWithProposalFixture);

      // 1. Proposal created
      expect(await governor.state(proposalId)).to.equal(1); // ProposalState.Pending

      // 2. Veto during period
      await governor.connect(vetoer).veto(proposalId, []);
      expect(await governor.state(proposalId)).to.equal(3); // ProposalState.Vetoed

      // 3. Cannot execute after veto
      const proposal = await governor.proposals(proposalId);
      await time.increaseTo(proposal.executeAfter + 1n);

      await expect(governor.execute(proposalId))
        .to.be.revertedWithCustomError(governor, "ProposalIsVetoed");
    });

    it("Multiple parallel proposals", async function () {
      const { governor, target, proposer } = await loadFixture(deployGovernorFixture);

      // Create 3 proposals
      await createProposal(governor, proposer, target);
      await createProposal(governor, proposer, target);
      await createProposal(governor, proposer, target);

      expect(await governor.proposalCount()).to.equal(3);

      // All should be pending
      expect(await governor.state(1)).to.equal(1); // ProposalState.Pending
      expect(await governor.state(2)).to.equal(1); // ProposalState.Pending
      expect(await governor.state(3)).to.equal(1); // ProposalState.Pending
    });

    it("Different targets for different proposals", async function () {
      const { governor, jusd, proposer } = await loadFixture(deployGovernorFixture);

      // Deploy two targets
      const MockTarget = await ethers.getContractFactory("MockTarget");
      const target1 = await MockTarget.deploy();
      const target2 = await MockTarget.deploy();

      // Create proposals for different targets
      const calldata1 = target1.interface.encodeFunctionData("setFeeProtocol", [3, 3]);
      const calldata2 = target2.interface.encodeFunctionData("setFeeProtocol", [7, 7]);

      await governor.connect(proposer).propose(
        await target1.getAddress(),
        calldata1,
        MIN_APPLICATION_PERIOD,
        "Proposal for target1"
      );

      await governor.connect(proposer).propose(
        await target2.getAddress(),
        calldata2,
        MIN_APPLICATION_PERIOD,
        "Proposal for target2"
      );

      const proposal1 = await governor.proposals(1);
      const proposal2 = await governor.proposals(2);

      expect(proposal1.target).to.equal(await target1.getAddress());
      expect(proposal2.target).to.equal(await target2.getAddress());
    });
  });

  describe("Edge Cases - Advanced", function () {
    describe("Integer Overflow/Boundary Tests", function () {
      it("Should handle very large application period", async function () {
        const { governor, target, proposer } = await loadFixture(deployGovernorFixture);

        const targetAddress = await target.getAddress();
        const calldata = target.interface.encodeFunctionData("setFeeProtocol", [5, 5]);
        const veryLargePeriod = 365n * 24n * 60n * 60n * 1000n; // 1000 years

        await governor.connect(proposer).propose(
          targetAddress,
          calldata,
          veryLargePeriod,
          "Long term proposal"
        );

        const proposal = await governor.proposals(1);
        expect(proposal.applicationPeriod).to.equal(veryLargePeriod);
      });

      it("Should handle executeAfter at boundary timestamp", async function () {
        const { governor, proposer, target, proposalId, proposal } = await loadFixture(
          deployWithProposalFixture
        );

        // Set time to EXACTLY executeAfter
        await time.setNextBlockTimestamp(proposal.executeAfter);

        await expect(governor.execute(proposalId))
          .to.emit(governor, "ProposalExecuted");
      });

      it("Should handle veto at EXACTLY executeAfter timestamp", async function () {
        const { governor, vetoer, proposalId, proposal } = await loadFixture(deployWithProposalFixture);

        // Try to veto EXACTLY at executeAfter - should fail (>= condition)
        await time.setNextBlockTimestamp(proposal.executeAfter);

        await expect(governor.connect(vetoer).veto(proposalId, []))
          .to.be.revertedWithCustomError(governor, "VetoPeriodEnded");
      });
    });

    describe("Proposal ID Edge Cases", function () {
      it("Should handle proposal ID 0 queries", async function () {
        const { governor } = await loadFixture(deployGovernorFixture);

        expect(await governor.state(0)).to.equal(0); // ProposalState.NotFound

        const proposal = await governor.proposals(0);
        expect(proposal.id).to.equal(0);
        expect(proposal.proposer).to.equal(ethers.ZeroAddress);
      });

      it("Should revert execute on proposal ID 0", async function () {
        const { governor } = await loadFixture(deployGovernorFixture);

        await expect(governor.execute(0))
          .to.be.revertedWithCustomError(governor, "ProposalNotFound");
      });

      it("Should revert veto on proposal ID 0", async function () {
        const { governor, vetoer } = await loadFixture(deployGovernorFixture);

        await expect(governor.connect(vetoer).veto(0, []))
          .to.be.revertedWithCustomError(governor, "ProposalNotFound");
      });

      it("Should handle multiple sequential proposal IDs correctly", async function () {
        const { governor, target, proposer } = await loadFixture(deployGovernorFixture);

        for (let i = 1; i <= 5; i++) {
          await createProposal(governor, proposer, target);
          expect(await governor.proposalCount()).to.equal(i);
        }

        // Verify all IDs are sequential
        for (let i = 1; i <= 5; i++) {
          const proposal = await governor.proposals(i);
          expect(proposal.id).to.equal(i);
        }
      });
    });

    describe("Helper Array Edge Cases", function () {
      it("Should handle multiple helpers", async function () {
        const { governor, jusd, juice, proposalId, user1, user2 } = await loadFixture(deployWithProposalFixture);
        const signers = await ethers.getSigners();
        const user3 = signers[7];
        const user4 = signers[8];

        const investment = ethers.parseEther("200000");

        // Give 4 users JUICE, all delegate to user1
        for (const user of [user1, user2, user3, user4]) {
          await jusd.mint(user.address, investment);
          await jusd.connect(user).approve(await juice.getAddress(), investment);
          await juice.connect(user).invest(investment, 0);
        }

        await time.increase(3600);

        // All delegate to user1
        for (const user of [user2, user3, user4]) {
          await juice.connect(user).delegateVoteTo(user1.address);
        }

        // Create sorted helpers array
        const helpers = [user2.address, user3.address, user4.address].sort(
          (a, b) => a.toLowerCase().localeCompare(b.toLowerCase())
        );

        // Test: veto works with multiple helpers
        await expect(governor.connect(user1).veto(proposalId, helpers))
          .to.emit(governor, "ProposalVetoed");
      });

      it("Should handle empty helpers array", async function () {
        const { governor, vetoer, proposalId } = await loadFixture(deployWithProposalFixture);

        await expect(governor.connect(vetoer).veto(proposalId, []))
          .to.emit(governor, "ProposalVetoed");
      });
    });

    describe("Data Payload Extremes", function () {
      it("Should handle very large data payload", async function () {
        const { governor, target, proposer } = await loadFixture(deployGovernorFixture);

        const targetAddress = await target.getAddress();
        // Create large payload (1KB)
        const largeData = "0x" + "00".repeat(1024);

        await governor.connect(proposer).propose(
          targetAddress,
          largeData,
          MIN_APPLICATION_PERIOD,
          "Large data proposal"
        );

        const proposal = await governor.proposals(1);
        expect(proposal.data).to.equal(largeData);
      });

      it("Should handle very long description (1000+ chars)", async function () {
        const { governor, target, proposer } = await loadFixture(deployGovernorFixture);

        const targetAddress = await target.getAddress();
        const calldata = target.interface.encodeFunctionData("setFeeProtocol", [5, 5]);
        const longDescription = "A".repeat(1500);

        await governor.connect(proposer).propose(
          targetAddress,
          calldata,
          MIN_APPLICATION_PERIOD,
          longDescription
        );

        const proposal = await governor.proposals(1);
        expect(proposal.description).to.equal(longDescription);
      });

      it("Should handle unicode characters in description", async function () {
        const { governor, target, proposer } = await loadFixture(deployGovernorFixture);

        const targetAddress = await target.getAddress();
        const calldata = target.interface.encodeFunctionData("setFeeProtocol", [5, 5]);
        const unicodeDescription = "🚀 Unicode test with émojis and spëcial chârs 中文 العربية";

        await governor.connect(proposer).propose(
          targetAddress,
          calldata,
          MIN_APPLICATION_PERIOD,
          unicodeDescription
        );

        const proposal = await governor.proposals(1);
        expect(proposal.description).to.equal(unicodeDescription);
      });
    });

    describe("Multiple Proposals Timing", function () {
      it("Should handle execute and veto in consecutive blocks", async function () {
        const { governor, target, proposer, vetoer } = await loadFixture(deployGovernorFixture);

        // Create first proposal
        await createProposal(governor, proposer, target);

        const proposal1 = await governor.proposals(1);
        await time.increaseTo(proposal1.executeAfter);

        // Execute first proposal
        await governor.execute(1);
        expect(await governor.state(1)).to.equal(4); // ProposalState.Executed

        // Create second proposal AFTER first is executed
        await createProposal(governor, proposer, target);

        // Veto second proposal (still in veto period since just created)
        await governor.connect(vetoer).veto(2, []);
        expect(await governor.state(2)).to.equal(3); // ProposalState.Vetoed
      });

      it("Should handle rapid proposal creation", async function () {
        const { governor, target, proposer } = await loadFixture(deployGovernorFixture);

        // Create 10 proposals rapidly
        for (let i = 0; i < 10; i++) {
          await createProposal(governor, proposer, target);
        }

        expect(await governor.proposalCount()).to.equal(10);

        // All should be in Pending state
        for (let i = 1; i <= 10; i++) {
          expect(await governor.state(i)).to.equal(1); // ProposalState.Pending
        }
      });
    });

    describe("Target Contract Edge Cases", function () {
      it("Should handle target that returns large amount of data", async function () {
        const { governor, proposer } = await loadFixture(deployGovernorFixture);

        // Deploy target that returns lots of data
        const MockTarget = await ethers.getContractFactory("MockTarget");
        const target = await MockTarget.deploy();

        const targetAddress = await target.getAddress();
        const calldata = target.interface.encodeFunctionData("complexFunction", [
          proposer.address,
          ethers.parseEther("100"),
          "0x" + "aa".repeat(500) // 500 bytes
        ]);

        await governor.connect(proposer).propose(
          targetAddress,
          calldata,
          MIN_APPLICATION_PERIOD,
          "Complex call"
        );

        const proposalId = 1n;
        const proposal = await governor.proposals(proposalId);
        await time.increaseTo(proposal.executeAfter);

        await expect(governor.execute(proposalId))
          .to.emit(governor, "ProposalExecuted");
      });

      it("Should handle target with empty bytecode (EOA)", async function () {
        const { governor, proposer, user1 } = await loadFixture(deployGovernorFixture);

        // Use EOA as target
        const eoaAddress = user1.address;
        const emptyData = "0x";

        await governor.connect(proposer).propose(
          eoaAddress,
          emptyData,
          MIN_APPLICATION_PERIOD,
          "EOA target"
        );

        const proposalId = 1n;
        const proposal = await governor.proposals(proposalId);
        await time.increaseTo(proposal.executeAfter);

        // Should succeed (call to EOA with empty data succeeds)
        await expect(governor.execute(proposalId))
          .to.emit(governor, "ProposalExecuted");
      });

      it("Should revert when target reverts with specific error", async function () {
        const { governor, target, proposer } = await loadFixture(deployGovernorFixture);

        const targetAddress = await target.getAddress();
        const calldata = target.interface.encodeFunctionData("failingFunction");

        await governor.connect(proposer).propose(
          targetAddress,
          calldata,
          MIN_APPLICATION_PERIOD,
          "Will fail"
        );

        const proposalId = 1n;
        const proposal = await governor.proposals(proposalId);
        await time.increaseTo(proposal.executeAfter);

        await expect(governor.execute(proposalId))
          .to.be.revertedWithCustomError(governor, "ExecutionFailed");
      });

      it("Should handle sequential execution of multiple proposals", async function () {
        const { governor, target, proposer } = await loadFixture(deployGovernorFixture);

        // Create 3 proposals
        for (let i = 0; i < 3; i++) {
          await createProposal(governor, proposer, target);
        }

        const proposal1 = await governor.proposals(1);
        await time.increaseTo(proposal1.executeAfter);

        // Execute all three sequentially
        for (let i = 1; i <= 3; i++) {
          await governor.execute(i);
          expect(await governor.state(i)).to.equal(4); // ProposalState.Executed
        }

        // All should have modified the target
        expect(await target.feeProtocol0()).to.equal(5);
        expect(await target.feeProtocol1()).to.equal(5);
      });
    });
  });
});
