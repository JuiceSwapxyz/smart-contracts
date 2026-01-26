import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Signer, Contract } from "ethers";

// Import addresses from npm packages for verification
import { ADDRESS as JUSD_ADDRESS } from "@juicedollar/jusd";
import {
  V3_CORE_FACTORY_ADDRESSES,
  V2_FACTORY_ADDRESSES,
  JUICESWAP_GOVERNOR_ADDRESSES,
  JUICESWAP_FEE_COLLECTOR_ADDRESSES
} from "@juiceswapxyz/sdk-core";
import { ADDRESS as LAUNCHPAD_ADDRESS } from "@juiceswapxyz/launchpad";

/**
 * Governance Integration Tests - Citrea Testnet
 *
 * Run with Anvil fork (recommended):
 *   1. anvil --fork-url https://rpc.testnet.citrea.xyz --chain-id 5115
 *   2. DEPLOYER_PRIVATE_KEY=0x... npx hardhat test test/Governance.integration.ts --network anvilTestnet
 *
 * Or with Hardhat fork:
 *   FORK_TESTNET=true npx hardhat test test/Governance.integration.ts --network hardhat
 *
 * Prerequisites:
 *   - DEPLOYER_PRIVATE_KEY with funded account (JUSD for proposals, cBTC for gas)
 */

// Load deployment file for Governor/FeeCollector addresses
const GOVERNANCE = require("../deployments/testnet/governance.json");

// Chain ID for Citrea Testnet
const CHAIN_ID = 5115;

// Time constants
const SECONDS_PER_DAY = 86400;
const MIN_APPLICATION_PERIOD = 14 * SECONDS_PER_DAY; // 14 days
const PROPOSAL_FEE = ethers.parseEther("1000"); // 1000 JUSD

// ABIs
const GOVERNOR_ABI = [
  "function propose(address target, bytes data, uint256 applicationPeriod, string description) returns (uint256)",
  "function execute(uint256 proposalId)",
  "function veto(uint256 proposalId, address[] helpers)",
  "function state(uint256 proposalId) view returns (uint8)",
  "function getVotingPower(address account, address[] helpers) view returns (uint256)",
  "function getVotingPowerPercentage(address account, address[] helpers) view returns (uint256)",
  "function proposals(uint256) view returns (uint256 id, address proposer, address target, bytes data, uint256 applicationPeriod, uint256 executeAfter, bool executed, bool vetoed, uint256 fee, string description)",
  "function proposalCount() view returns (uint256)",
  "function PROPOSAL_FEE() view returns (uint256)",
  "function MIN_APPLICATION_PERIOD() view returns (uint256)",
  "function JUSD() view returns (address)",
  "function JUICE() view returns (address)",
  "event ProposalCreated(uint256 indexed proposalId, address indexed proposer, address target, bytes data, uint256 executeAfter, string description)",
  "event ProposalExecuted(uint256 indexed proposalId, address indexed executor)",
  "event ProposalVetoed(uint256 indexed proposalId, address indexed vetoer)",
];

const FEE_COLLECTOR_ABI = [
  "function owner() view returns (address)",
  "function twapPeriod() view returns (uint32)",
  "function maxSlippageBps() view returns (uint256)",
  "function authorizedCollector() view returns (address)",
  "function swapRouter() view returns (address)",
  "function JUSD() view returns (address)",
  "function JUICE() view returns (address)",
  "function FACTORY() view returns (address)",
  "function setProtectionParams(uint32 _twapPeriod, uint256 _maxSlippageBps)",
  "function setCollector(address collector)",
  "function setSwapRouter(address newRouter)",
  "function setFactoryOwner(address _owner)",
  "function enableFeeAmount(uint24 fee, int24 tickSpacing)",
  "function collectAndReinvestFees(address pool, bytes path0, bytes path1) returns (uint256)",
];

const FACTORY_ABI = [
  "function owner() view returns (address)",
  "function setOwner(address _owner)",
  "function feeAmountTickSpacing(uint24) view returns (int24)",
  "function enableFeeAmount(uint24 fee, int24 tickSpacing)",
];

const V2_FACTORY_ABI = [
  "function feeToSetter() view returns (address)",
  "function feeTo() view returns (address)",
];

const OWNABLE_ABI = [
  "function owner() view returns (address)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function transfer(address, uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

// Helper functions
async function skipTime(seconds: number) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine", []);
}

async function skipVetoPeriod() {
  await skipTime(MIN_APPLICATION_PERIOD + 1);
}

function findEventArgs(receipt: any, contract: Contract, eventName: string): any {
  const contractAddress = String(contract.target || "").toLowerCase();
  const eventFragment = contract.interface.getEvent(eventName);
  if (!eventFragment) return null;

  // In ethers v6, use topicHash property
  const eventTopic = eventFragment.topicHash;

  for (const log of receipt.logs) {
    const logAddress = (log.address || "").toLowerCase();
    if (logAddress !== contractAddress) continue;

    const topics = Array.from(log.topics).map((t: any) => t.toString());

    // Check if this log matches our event by topic signature
    if (topics[0] !== eventTopic) continue;

    try {
      // Ensure data is a proper hex string
      const data = log.data || "0x";
      const parsed = contract.interface.parseLog({ topics, data });
      if (parsed?.name === eventName) {
        return parsed.args;
      }
    } catch (e: any) {
      // If full parsing fails, try to extract indexed args from topics
      // For ProposalCreated: topics[1] = proposalId (indexed)
      if (eventName === "ProposalCreated" && topics.length >= 2) {
        return {
          proposalId: BigInt(topics[1]),
          proposer: topics.length >= 3 ? ethers.getAddress("0x" + topics[2].slice(26)) : null,
          target: topics.length >= 4 ? ethers.getAddress("0x" + topics[3].slice(26)) : null,
        };
      }
    }
  }
  return null;
}

// Proposal state enum
enum ProposalState {
  NotFound = 0,
  Pending = 1,
  Ready = 2,
  Vetoed = 3,
  Executed = 4,
}

// Network detection
const isForkNetwork = process.env.FORK_TESTNET === "true" || process.env.FORK_MAINNET === "true";
const isAnvilNetwork = network.name === "anvilTestnet" || network.name === "anvilMainnet";
const isLiveNetwork = network.name === "citreaTestnet" || network.name === "citrea";
const isIntegrationTest = isForkNetwork || isAnvilNetwork || isLiveNetwork;
const canManipulateTime = network.name === "hardhat" || isAnvilNetwork; // Hardhat (with or without fork) and Anvil support time manipulation

(isIntegrationTest ? describe : describe.skip)("Governance Integration Tests (Citrea Testnet Fork)", function () {
  this.timeout(180_000); // 3 minutes for slow operations

  // Contracts
  let governor: Contract;
  let feeCollector: Contract;
  let jusd: Contract;
  let v3Factory: Contract;
  let v2Factory: Contract;
  let proxyAdmin: Contract;
  let tokenFactory: Contract;

  // Signers
  let signer: Signer;
  let signerAddress: string;

  // Addresses
  let governorAddress: string;
  let feeCollectorAddress: string;

  before(async function () {
    // Check if we're on the right network
    const chainId = (await ethers.provider.getNetwork()).chainId;
    if (Number(chainId) !== CHAIN_ID) {
      console.log(`Skipping: Expected chain ID ${CHAIN_ID}, got ${chainId}`);
      console.log("Run with: FORK_TESTNET=true npx hardhat test test/Governance.integration.ts --network hardhat");
      return this.skip();
    }

    // Get signer
    const signers = await ethers.getSigners();
    if (signers.length === 0) {
      console.log("Skipping: No signer. Set DEPLOYER_PRIVATE_KEY env var.");
      return this.skip();
    }

    signer = signers[0];
    signerAddress = await signer.getAddress();
    console.log(`\n  Test account: ${signerAddress}`);

    // Load addresses from deployment file
    governorAddress = GOVERNANCE.contracts.JuiceSwapGovernor.address;
    feeCollectorAddress = GOVERNANCE.contracts.JuiceSwapFeeCollector.address;

    console.log(`  Governor: ${governorAddress}`);
    console.log(`  FeeCollector: ${feeCollectorAddress}`);

    // Initialize contracts
    governor = new ethers.Contract(governorAddress, GOVERNOR_ABI, signer);
    feeCollector = new ethers.Contract(feeCollectorAddress, FEE_COLLECTOR_ABI, signer);
    jusd = new ethers.Contract(GOVERNANCE.references.jusdAddress, ERC20_ABI, signer);
    v3Factory = new ethers.Contract(GOVERNANCE.references.v3FactoryAddress, FACTORY_ABI, signer);
    v2Factory = new ethers.Contract(GOVERNANCE.references.v2FactoryAddress, V2_FACTORY_ABI, signer);
    proxyAdmin = new ethers.Contract(GOVERNANCE.references.proxyAdminAddress, OWNABLE_ABI, signer);
    tokenFactory = new ethers.Contract(GOVERNANCE.references.tokenFactoryAddress, OWNABLE_ABI, signer);

    // Check signer balances
    const [jusdBal, cbtcBal] = await Promise.all([
      jusd.balanceOf(signerAddress),
      ethers.provider.getBalance(signerAddress),
    ]);

    console.log(`  JUSD: ${ethers.formatUnits(jusdBal, 18)}`);
    console.log(`  cBTC: ${ethers.formatUnits(cbtcBal, 18)}\n`);

    // Check if signer has enough JUSD for proposal tests
    if (jusdBal < PROPOSAL_FEE) {
      console.log(`  Warning: Insufficient JUSD for proposal tests (need ${ethers.formatUnits(PROPOSAL_FEE, 18)} JUSD)`);
    }
  });

  describe("0. Address Verification", function () {
    it("Should verify deployment addresses match npm packages", async function () {
      // Verify JUSD address matches npm package
      expect(GOVERNANCE.references.jusdAddress.toLowerCase()).to.equal(
        JUSD_ADDRESS[CHAIN_ID].juiceDollar.toLowerCase()
      );

      // Verify JUICE (Equity) address matches npm package
      expect(GOVERNANCE.references.juiceAddress.toLowerCase()).to.equal(
        JUSD_ADDRESS[CHAIN_ID].equity.toLowerCase()
      );

      // Verify V3 Factory address matches npm package
      expect(GOVERNANCE.references.v3FactoryAddress.toLowerCase()).to.equal(
        V3_CORE_FACTORY_ADDRESSES[CHAIN_ID].toLowerCase()
      );

      // Verify V2 Factory address matches npm package
      expect(GOVERNANCE.references.v2FactoryAddress.toLowerCase()).to.equal(
        V2_FACTORY_ADDRESSES[CHAIN_ID].toLowerCase()
      );

      // Verify TokenFactory address matches launchpad package
      expect(GOVERNANCE.references.tokenFactoryAddress.toLowerCase()).to.equal(
        LAUNCHPAD_ADDRESS[CHAIN_ID].factory.toLowerCase()
      );

      console.log("    All deployment addresses verified against npm packages");
    });

    it("Should verify Governor/FeeCollector addresses match sdk-core", async function () {
      // Verify Governor address matches sdk-core
      if (JUICESWAP_GOVERNOR_ADDRESSES[CHAIN_ID]) {
        expect(governorAddress.toLowerCase()).to.equal(
          JUICESWAP_GOVERNOR_ADDRESSES[CHAIN_ID].toLowerCase()
        );
      }

      // Verify FeeCollector address matches sdk-core
      if (JUICESWAP_FEE_COLLECTOR_ADDRESSES[CHAIN_ID]) {
        expect(feeCollectorAddress.toLowerCase()).to.equal(
          JUICESWAP_FEE_COLLECTOR_ADDRESSES[CHAIN_ID].toLowerCase()
        );
      }

      console.log("    Governor/FeeCollector addresses verified against sdk-core");
    });
  });

  describe("1. Ownership Verification", function () {
    it("Should verify Governor owns FeeCollector", async function () {
      const owner = await feeCollector.owner();
      expect(owner.toLowerCase()).to.equal(governorAddress.toLowerCase());
      console.log(`    FeeCollector.owner() = ${owner}`);
    });

    it("Should verify Governor owns V3 Factory", async function () {
      const owner = await v3Factory.owner();
      expect(owner.toLowerCase()).to.equal(governorAddress.toLowerCase());
      console.log(`    V3Factory.owner() = ${owner}`);
    });

    it("Should verify Governor owns V2 Factory (feeToSetter)", async function () {
      const feeToSetter = await v2Factory.feeToSetter();
      expect(feeToSetter.toLowerCase()).to.equal(governorAddress.toLowerCase());
      console.log(`    V2Factory.feeToSetter() = ${feeToSetter}`);
    });

    it("Should verify Governor owns ProxyAdmin", async function () {
      const owner = await proxyAdmin.owner();
      expect(owner.toLowerCase()).to.equal(governorAddress.toLowerCase());
      console.log(`    ProxyAdmin.owner() = ${owner}`);
    });

    it("Should verify Governor owns TokenFactory", async function () {
      const owner = await tokenFactory.owner();
      expect(owner.toLowerCase()).to.equal(governorAddress.toLowerCase());
      console.log(`    TokenFactory.owner() = ${owner}`);
    });

    it("Should verify FeeCollector has correct immutable addresses", async function () {
      const [jusdAddr, juiceAddr, factoryAddr] = await Promise.all([
        feeCollector.JUSD(),
        feeCollector.JUICE(),
        feeCollector.FACTORY(),
      ]);

      expect(jusdAddr.toLowerCase()).to.equal(GOVERNANCE.references.jusdAddress.toLowerCase());
      expect(juiceAddr.toLowerCase()).to.equal(GOVERNANCE.references.juiceAddress.toLowerCase());
      expect(factoryAddr.toLowerCase()).to.equal(GOVERNANCE.references.v3FactoryAddress.toLowerCase());

      console.log("    JUSD:", jusdAddr);
      console.log("    JUICE:", juiceAddr);
      console.log("    FACTORY:", factoryAddr);
    });

    it("Should verify FeeCollector default parameters", async function () {
      const [twapPeriod, maxSlippageBps] = await Promise.all([
        feeCollector.twapPeriod(),
        feeCollector.maxSlippageBps(),
      ]);

      // Default values from deployment
      expect(twapPeriod).to.equal(1800); // 30 minutes
      expect(maxSlippageBps).to.equal(200); // 2%

      console.log(`    twapPeriod = ${twapPeriod}s (30 min)`);
      console.log(`    maxSlippageBps = ${maxSlippageBps} (2%)`);
    });

    it("Should verify Governor constants", async function () {
      const [proposalFee, minAppPeriod, jusdAddr, juiceAddr] = await Promise.all([
        governor.PROPOSAL_FEE(),
        governor.MIN_APPLICATION_PERIOD(),
        governor.JUSD(),
        governor.JUICE(),
      ]);

      expect(proposalFee).to.equal(PROPOSAL_FEE);
      expect(minAppPeriod).to.equal(MIN_APPLICATION_PERIOD);
      expect(jusdAddr.toLowerCase()).to.equal(GOVERNANCE.references.jusdAddress.toLowerCase());
      expect(juiceAddr.toLowerCase()).to.equal(GOVERNANCE.references.juiceAddress.toLowerCase());

      console.log(`    PROPOSAL_FEE = ${ethers.formatUnits(proposalFee, 18)} JUSD`);
      console.log(`    MIN_APPLICATION_PERIOD = ${Number(minAppPeriod) / SECONDS_PER_DAY} days`);
    });
  });

  describe("2. Proposal Lifecycle", function () {
    let proposalId: bigint;
    let initialProposalCount: bigint;

    before(async function () {
      // Time manipulation tests only work on forked networks
      if (!canManipulateTime) {
        console.log("    Skipping: Proposal lifecycle tests require forked network (time manipulation)");
        console.log("    Run with FORK_TESTNET=true for full test suite");
        return this.skip();
      }

      // Check if signer has enough JUSD
      const jusdBal = await jusd.balanceOf(signerAddress);
      if (jusdBal < PROPOSAL_FEE) {
        console.log("    Skipping: Insufficient JUSD for proposal tests");
        return this.skip();
      }

      initialProposalCount = await governor.proposalCount();
    });

    it("Should create proposal with 1000 JUSD fee", async function () {
      // Encode a simple calldata - use signer address as collector (valid, won't revert on execution)
      // Note: If currentCollector is address(0), setCollector would revert with InvalidAddress
      const calldata = feeCollector.interface.encodeFunctionData("setCollector", [signerAddress]);

      // Approve JUSD
      const approveTx = await jusd.approve(governorAddress, PROPOSAL_FEE);
      await approveTx.wait();

      // Get balances before
      const jusdBefore = await jusd.balanceOf(signerAddress);
      const juiceEquityBefore = await jusd.balanceOf(await governor.JUICE());

      // Create proposal
      const tx = await governor.propose(
        feeCollectorAddress,
        calldata,
        MIN_APPLICATION_PERIOD,
        "Integration test: verify setCollector works"
      );
      const receipt = await tx.wait();

      // Check event was emitted
      const eventArgs = findEventArgs(receipt, governor, "ProposalCreated");
      expect(eventArgs).to.not.be.null;
      proposalId = eventArgs.proposalId;

      console.log(`    Created proposal #${proposalId}`);

      // Verify JUSD was transferred to JUICE equity
      const jusdAfter = await jusd.balanceOf(signerAddress);
      const juiceEquityAfter = await jusd.balanceOf(await governor.JUICE());

      expect(jusdBefore - jusdAfter).to.equal(PROPOSAL_FEE);
      expect(juiceEquityAfter - juiceEquityBefore).to.equal(PROPOSAL_FEE);

      // Verify proposal count increased
      const newCount = await governor.proposalCount();
      expect(newCount).to.equal(initialProposalCount + 1n);
    });

    it("Should show proposal in Pending state", async function () {
      if (!proposalId) this.skip();

      const state = await governor.state(proposalId);
      expect(state).to.equal(ProposalState.Pending);
      console.log(`    Proposal #${proposalId} state: Pending`);
    });

    it("Should revert execution during veto period", async function () {
      if (!proposalId) this.skip();

      // Note: Using .to.be.reverted instead of .revertedWithCustomError because
      // the minimal ABI doesn't include custom error definitions
      await expect(governor.execute(proposalId)).to.be.reverted;

      console.log("    Execution correctly reverted (ProposalNotReady)");
    });

    it("Should transition to Ready state after 14 days", async function () {
      if (!proposalId) this.skip();

      // Skip the veto period
      await skipVetoPeriod();

      const state = await governor.state(proposalId);
      expect(state).to.equal(ProposalState.Ready);
      console.log(`    Proposal #${proposalId} state: Ready (after time skip)`);
    });

    it("Should execute proposal successfully", async function () {
      if (!proposalId) this.skip();

      const tx = await governor.execute(proposalId);
      const receipt = await tx.wait();

      // Check event was emitted
      const eventArgs = findEventArgs(receipt, governor, "ProposalExecuted");
      expect(eventArgs).to.not.be.null;
      expect(eventArgs.proposalId).to.equal(proposalId);

      // Verify state is now Executed
      const state = await governor.state(proposalId);
      expect(state).to.equal(ProposalState.Executed);

      console.log(`    Proposal #${proposalId} executed successfully`);
    });

    it("Should revert when trying to execute twice", async function () {
      if (!proposalId) this.skip();

      // Note: Using .to.be.reverted instead of .revertedWithCustomError because
      // the minimal ABI doesn't include custom error definitions
      await expect(governor.execute(proposalId)).to.be.reverted;

      console.log("    Double execution correctly reverted (ProposalAlreadyExecuted)");
    });
  });

  describe("3. Veto Mechanism", function () {
    let proposalId: bigint;

    before(async function () {
      // Time manipulation tests only work on forked networks
      if (!canManipulateTime) {
        console.log("    Skipping: Veto mechanism tests require forked network (time manipulation)");
        return this.skip();
      }

      // Check if signer has enough JUSD
      const jusdBal = await jusd.balanceOf(signerAddress);
      if (jusdBal < PROPOSAL_FEE * 2n) {
        console.log("    Skipping: Insufficient JUSD for veto tests");
        return this.skip();
      }
    });

    it("Should create a proposal for veto testing", async function () {
      // Encode a calldata
      const calldata = feeCollector.interface.encodeFunctionData("setProtectionParams", [1800, 200]);

      // Approve and create proposal
      await jusd.approve(governorAddress, PROPOSAL_FEE);
      const tx = await governor.propose(
        feeCollectorAddress,
        calldata,
        MIN_APPLICATION_PERIOD,
        "Integration test: veto test proposal"
      );
      const receipt = await tx.wait();

      const eventArgs = findEventArgs(receipt, governor, "ProposalCreated");
      proposalId = eventArgs.proposalId;
      console.log(`    Created proposal #${proposalId} for veto testing`);
    });

    it("Should show voting power calculation works", async function () {
      const votingPower = await governor.getVotingPower(signerAddress, []);
      const votingPowerBps = await governor.getVotingPowerPercentage(signerAddress, []);

      console.log(`    Signer voting power: ${ethers.formatUnits(votingPower, 18)}`);
      console.log(`    Signer voting power: ${Number(votingPowerBps) / 100}%`);

      // Voting power should be a reasonable value (may be 0 if signer has no JUICE)
      expect(votingPower).to.be.gte(0);
      expect(votingPowerBps).to.be.gte(0);
      expect(votingPowerBps).to.be.lte(10000); // Max 100%
    });

    it("Should demonstrate veto requires 2% voting power", async function () {
      if (!proposalId) this.skip();

      const votingPowerBps = await governor.getVotingPowerPercentage(signerAddress, []);

      if (votingPowerBps >= 200n) {
        // Signer has enough voting power - veto should work
        const tx = await governor.veto(proposalId, []);
        const receipt = await tx.wait();

        const eventArgs = findEventArgs(receipt, governor, "ProposalVetoed");
        expect(eventArgs).to.not.be.null;

        const state = await governor.state(proposalId);
        expect(state).to.equal(ProposalState.Vetoed);

        console.log(`    Proposal #${proposalId} vetoed successfully`);
      } else {
        // Signer doesn't have enough voting power - veto should revert
        await expect(governor.veto(proposalId, []))
          .to.be.reverted; // Will revert from Equity.checkQualified

        console.log("    Veto correctly reverted (insufficient voting power)");
        console.log(`    Signer has ${Number(votingPowerBps) / 100}% voting power, needs 2%`);
      }
    });

    it("Should not allow execution of vetoed proposal", async function () {
      if (!proposalId) this.skip();

      const state = await governor.state(proposalId);
      if (state !== BigInt(ProposalState.Vetoed)) {
        console.log("    Skipping: Proposal was not vetoed");
        return this.skip();
      }

      // Skip veto period
      await skipVetoPeriod();

      // Using .to.be.reverted since minimal ABI doesn't include custom error definitions
      await expect(governor.execute(proposalId)).to.be.reverted;

      console.log("    Execution of vetoed proposal correctly reverted (ProposalIsVetoed)");
    });

    it("Should not allow veto after veto period ends", async function () {
      // Create a new proposal for this test
      const calldata = feeCollector.interface.encodeFunctionData("setProtectionParams", [1800, 200]);
      await jusd.approve(governorAddress, PROPOSAL_FEE);
      const tx = await governor.propose(
        feeCollectorAddress,
        calldata,
        MIN_APPLICATION_PERIOD,
        "Integration test: veto period test"
      );
      const receipt = await tx.wait();

      const eventArgs = findEventArgs(receipt, governor, "ProposalCreated");
      const newProposalId = eventArgs.proposalId;

      // Skip past veto period
      await skipVetoPeriod();

      // Check voting power
      const votingPowerBps = await governor.getVotingPowerPercentage(signerAddress, []);
      if (votingPowerBps >= 200n) {
        // Using .to.be.reverted since minimal ABI doesn't include custom error definitions
        await expect(governor.veto(newProposalId, [])).to.be.reverted;

        console.log("    Veto after period correctly reverted (VetoPeriodEnded)");
      } else {
        console.log("    Skipping VetoPeriodEnded test (signer lacks voting power)");
      }

      // Clean up - execute the proposal
      await governor.execute(newProposalId);
    });
  });

  describe("4. FeeCollector Configuration via Governance", function () {
    let proposalId: bigint;

    before(async function () {
      // Time manipulation tests only work on forked networks
      if (!canManipulateTime) {
        console.log("    Skipping: Governance config tests require forked network (time manipulation)");
        return this.skip();
      }

      const jusdBal = await jusd.balanceOf(signerAddress);
      if (jusdBal < PROPOSAL_FEE * 2n) {
        console.log("    Skipping: Insufficient JUSD for governance config tests");
        return this.skip();
      }
    });

    it("Should create and execute proposal to update protection params", async function () {
      // Get current values
      const currentTwap = await feeCollector.twapPeriod();
      const currentSlippage = await feeCollector.maxSlippageBps();

      // Use slightly different values (but valid ones)
      const newTwapPeriod = currentTwap === 1800n ? 2100 : 1800; // Toggle between 30min and 35min
      const newMaxSlippage = currentSlippage === 200n ? 250 : 200; // Toggle between 2% and 2.5%

      // Encode calldata
      const calldata = feeCollector.interface.encodeFunctionData("setProtectionParams", [
        newTwapPeriod,
        newMaxSlippage,
      ]);

      // Create proposal
      await jusd.approve(governorAddress, PROPOSAL_FEE);
      const tx = await governor.propose(
        feeCollectorAddress,
        calldata,
        MIN_APPLICATION_PERIOD,
        `Update protection params: twap=${newTwapPeriod}, slippage=${newMaxSlippage}bps`
      );
      const receipt = await tx.wait();

      const eventArgs = findEventArgs(receipt, governor, "ProposalCreated");
      proposalId = eventArgs.proposalId;

      // Skip veto period and execute
      await skipVetoPeriod();
      await governor.execute(proposalId);

      // Verify the change was applied
      const updatedTwap = await feeCollector.twapPeriod();
      const updatedSlippage = await feeCollector.maxSlippageBps();

      expect(updatedTwap).to.equal(newTwapPeriod);
      expect(updatedSlippage).to.equal(newMaxSlippage);

      console.log(`    Protection params updated: twap=${updatedTwap}s, slippage=${updatedSlippage}bps`);

      // Restore original values via another proposal
      const restoreCalldata = feeCollector.interface.encodeFunctionData("setProtectionParams", [
        currentTwap,
        currentSlippage,
      ]);

      await jusd.approve(governorAddress, PROPOSAL_FEE);
      const restoreTx = await governor.propose(
        feeCollectorAddress,
        restoreCalldata,
        MIN_APPLICATION_PERIOD,
        "Restore original protection params"
      );
      const restoreReceipt = await restoreTx.wait();

      const restoreEventArgs = findEventArgs(restoreReceipt, governor, "ProposalCreated");
      await skipVetoPeriod();
      await governor.execute(restoreEventArgs.proposalId);

      console.log(`    Original params restored: twap=${currentTwap}s, slippage=${currentSlippage}bps`);
    });

    it("Should create and execute proposal to set authorized collector", async function () {
      const currentCollector = await feeCollector.authorizedCollector();
      const newCollector = signerAddress; // Use signer as the new collector

      // Only proceed if it would be a change
      if (currentCollector.toLowerCase() === newCollector.toLowerCase()) {
        console.log("    Skipping: signer is already the authorized collector");
        return this.skip();
      }

      // Encode calldata
      const calldata = feeCollector.interface.encodeFunctionData("setCollector", [newCollector]);

      // Create proposal
      await jusd.approve(governorAddress, PROPOSAL_FEE);
      const tx = await governor.propose(
        feeCollectorAddress,
        calldata,
        MIN_APPLICATION_PERIOD,
        `Set authorized collector to ${newCollector}`
      );
      const receipt = await tx.wait();

      const eventArgs = findEventArgs(receipt, governor, "ProposalCreated");
      proposalId = eventArgs.proposalId;

      // Skip veto period and execute
      await skipVetoPeriod();
      await governor.execute(proposalId);

      // Verify the change was applied
      const updatedCollector = await feeCollector.authorizedCollector();
      expect(updatedCollector.toLowerCase()).to.equal(newCollector.toLowerCase());

      console.log(`    Authorized collector set to: ${updatedCollector}`);

      // Note: We don't restore the original collector if it was address(0) because
      // setCollector(address(0)) would revert with InvalidAddress. Since this is a
      // fork, changes don't persist anyway.
      if (currentCollector !== ethers.ZeroAddress) {
        const restoreCalldata = feeCollector.interface.encodeFunctionData("setCollector", [currentCollector]);
        await jusd.approve(governorAddress, PROPOSAL_FEE);
        const restoreTx = await governor.propose(
          feeCollectorAddress,
          restoreCalldata,
          MIN_APPLICATION_PERIOD,
          "Restore original authorized collector"
        );
        const restoreReceipt = await restoreTx.wait();

        const restoreEventArgs = findEventArgs(restoreReceipt, governor, "ProposalCreated");
        await skipVetoPeriod();
        await governor.execute(restoreEventArgs.proposalId);

        console.log(`    Original collector restored: ${currentCollector}`);
      } else {
        console.log(`    (Original collector was zero address, no restoration needed on fork)`);
      }
    });

    it("Should create and execute proposal to enable new fee tier", async function () {
      // Check if 0.15% (1500) fee tier already exists
      const existingTickSpacing = await v3Factory.feeAmountTickSpacing(1500);

      if (existingTickSpacing > 0n) {
        console.log("    Skipping: 0.15% fee tier already enabled");
        return this.skip();
      }

      // Enable 0.15% fee tier with tick spacing of 30
      // Note: We target the V3 Factory directly (not FeeCollector) because
      // Governor owns the Factory. FeeCollector.enableFeeAmount() would fail
      // since msg.sender would be FeeCollector, not Governor.
      const calldata = v3Factory.interface.encodeFunctionData("enableFeeAmount", [1500, 30]);

      // Create proposal targeting the V3 Factory directly
      await jusd.approve(governorAddress, PROPOSAL_FEE);
      const tx = await governor.propose(
        GOVERNANCE.references.v3FactoryAddress, // Target Factory directly
        calldata,
        MIN_APPLICATION_PERIOD,
        "Enable 0.15% fee tier with tick spacing 30"
      );
      const receipt = await tx.wait();

      const eventArgs = findEventArgs(receipt, governor, "ProposalCreated");
      proposalId = eventArgs.proposalId;

      // Skip veto period and execute
      await skipVetoPeriod();
      await governor.execute(proposalId);

      // Verify the change was applied
      const newTickSpacing = await v3Factory.feeAmountTickSpacing(1500);
      expect(newTickSpacing).to.equal(30);

      console.log(`    Fee tier 0.15% enabled with tick spacing: ${newTickSpacing}`);
    });
  });

  describe("5. Fee Collection", function () {
    it("Should verify collector authorization works", async function () {
      const collector = await feeCollector.authorizedCollector();
      console.log(`    Current authorized collector: ${collector}`);

      // Verify non-authorized address cannot collect
      // We can't easily test the actual collection without a pool, but we can verify the authorization check
      if (collector.toLowerCase() !== signerAddress.toLowerCase() && collector !== ethers.ZeroAddress) {
        // Try to call collectAndReinvestFees - should revert (Unauthorized)
        await expect(
          feeCollector.collectAndReinvestFees(ethers.ZeroAddress, "0x", "0x")
        ).to.be.reverted;

        console.log("    Non-authorized collection correctly reverted");
      } else if (collector === ethers.ZeroAddress) {
        console.log("    No authorized collector set yet");
      } else {
        console.log("    Signer is the authorized collector");
      }
    });

    it("Should verify FeeCollector has correct swap router", async function () {
      const swapRouter = await feeCollector.swapRouter();
      expect(swapRouter.toLowerCase()).to.equal(
        GOVERNANCE.references.swapRouterAddress.toLowerCase()
      );
      console.log(`    SwapRouter: ${swapRouter}`);
    });
  });

  describe("6. Edge Cases", function () {
    it("Should handle proposal query for non-existent ID", async function () {
      const nonExistentId = 999999n;
      const state = await governor.state(nonExistentId);
      expect(state).to.equal(ProposalState.NotFound);
      console.log(`    Non-existent proposal state: NotFound`);
    });

    it("Should revert execute on non-existent proposal", async function () {
      // Using .to.be.reverted since we're using minimal ABI
      await expect(governor.execute(999999n)).to.be.reverted;
      console.log("    Execute on non-existent proposal correctly reverted");
    });

    it("Should revert veto on non-existent proposal", async function () {
      // Using .to.be.reverted since we're using minimal ABI
      await expect(governor.veto(999999n, [])).to.be.reverted;
      console.log("    Veto on non-existent proposal correctly reverted");
    });

    it("Should verify proposal count tracking", async function () {
      const count = await governor.proposalCount();
      expect(count).to.be.gte(0);
      console.log(`    Total proposals created: ${count}`);
    });
  });
});
