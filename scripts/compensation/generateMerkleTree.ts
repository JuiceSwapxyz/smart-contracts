/**
 * Merkle Tree Generator for CompensationClaim Contract
 *
 * This script generates a Merkle tree from a list of addresses and outputs:
 * 1. The Merkle root (for contract deployment)
 * 2. Individual proofs for each address (for claiming)
 *
 * Usage:
 *   npx ts-node scripts/compensation/generateMerkleTree.ts [path-to-addresses.json]
 *
 * Input file format (JSON array of addresses):
 *   ["0x123...", "0x456...", ...]
 *
 * Output files:
 *   - data/compensation/merkle-root.json: Contains the root hash
 *   - data/compensation/merkle-proofs.json: Contains proofs for each address
 */

import { keccak256, encodePacked } from "viem";
import * as fs from "fs";
import * as path from "path";

interface MerkleProofData {
  address: string;
  proof: string[];
  leaf: string;
}

interface MerkleOutput {
  root: string;
  totalAddresses: number;
  generatedAt: string;
  proofs: MerkleProofData[];
}

/**
 * Simple Merkle Tree implementation
 */
class MerkleTree {
  private leaves: `0x${string}`[];
  private layers: `0x${string}`[][];

  constructor(addresses: string[]) {
    // Create leaves from addresses
    this.leaves = addresses.map((addr) => keccak256(encodePacked(["address"], [addr as `0x${string}`])));

    // Sort leaves for consistent ordering
    this.leaves.sort((a, b) => a.localeCompare(b));

    // Build tree layers
    this.layers = [this.leaves];
    this.buildTree();
  }

  private buildTree(): void {
    let currentLayer = this.leaves;

    while (currentLayer.length > 1) {
      const nextLayer: `0x${string}`[] = [];

      for (let i = 0; i < currentLayer.length; i += 2) {
        if (i + 1 < currentLayer.length) {
          // Hash pair of nodes (sorted to ensure consistency)
          const left = currentLayer[i];
          const right = currentLayer[i + 1];
          const [first, second] = left < right ? [left, right] : [right, left];
          nextLayer.push(keccak256(encodePacked(["bytes32", "bytes32"], [first, second])));
        } else {
          // Odd number of nodes - promote single node
          nextLayer.push(currentLayer[i]);
        }
      }

      this.layers.push(nextLayer);
      currentLayer = nextLayer;
    }
  }

  getRoot(): `0x${string}` {
    return this.layers[this.layers.length - 1][0];
  }

  getProof(address: string): `0x${string}`[] {
    const leaf = keccak256(encodePacked(["address"], [address as `0x${string}`]));
    let index = this.leaves.indexOf(leaf);

    if (index === -1) {
      throw new Error(`Address ${address} not found in tree`);
    }

    const proof: `0x${string}`[] = [];

    for (let i = 0; i < this.layers.length - 1; i++) {
      const layer = this.layers[i];
      const isRightNode = index % 2 === 1;
      const siblingIndex = isRightNode ? index - 1 : index + 1;

      if (siblingIndex < layer.length) {
        proof.push(layer[siblingIndex]);
      }

      index = Math.floor(index / 2);
    }

    return proof;
  }

  getLeaf(address: string): `0x${string}` {
    return keccak256(encodePacked(["address"], [address as `0x${string}`]));
  }
}

async function main() {
  // Get input file path from command line or use default
  const inputFile = process.argv[2] || path.join(__dirname, "../../data/compensation/addresses.json");

  console.log("=".repeat(60));
  console.log("Merkle Tree Generator for CompensationClaim");
  console.log("=".repeat(60));

  // Check if input file exists
  if (!fs.existsSync(inputFile)) {
    console.error(`\nError: Input file not found: ${inputFile}`);
    console.log("\nUsage: npx ts-node scripts/compensation/generateMerkleTree.ts <path-to-addresses.json>");
    console.log("\nInput file format (JSON array of addresses):");
    console.log('  ["0x123...", "0x456...", ...]');
    process.exit(1);
  }

  // Read addresses
  console.log(`\nReading addresses from: ${inputFile}`);
  const rawData = fs.readFileSync(inputFile, "utf-8");
  const addresses: string[] = JSON.parse(rawData);

  console.log(`Found ${addresses.length} addresses`);

  // Validate addresses
  const invalidAddresses = addresses.filter((addr) => !/^0x[a-fA-F0-9]{40}$/.test(addr));
  if (invalidAddresses.length > 0) {
    console.error("\nError: Invalid addresses found:");
    invalidAddresses.forEach((addr) => console.error(`  - ${addr}`));
    process.exit(1);
  }

  // Check for duplicates
  const uniqueAddresses = [...new Set(addresses.map((a) => a.toLowerCase()))];
  if (uniqueAddresses.length !== addresses.length) {
    console.warn(`\nWarning: Found ${addresses.length - uniqueAddresses.length} duplicate addresses`);
    console.log(`Using ${uniqueAddresses.length} unique addresses`);
  }

  // Normalize addresses (checksum format)
  const normalizedAddresses = uniqueAddresses.map((addr) => addr.toLowerCase());

  // Build Merkle tree
  console.log("\nBuilding Merkle tree...");
  const tree = new MerkleTree(normalizedAddresses);

  // Generate proofs for each address
  const proofs: MerkleProofData[] = normalizedAddresses.map((addr) => ({
    address: addr,
    proof: tree.getProof(addr),
    leaf: tree.getLeaf(addr),
  }));

  // Create output
  const output: MerkleOutput = {
    root: tree.getRoot(),
    totalAddresses: normalizedAddresses.length,
    generatedAt: new Date().toISOString(),
    proofs,
  };

  // Ensure output directory exists
  const outputDir = path.join(__dirname, "../../data/compensation");
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write merkle root (for deployment)
  const rootOutputPath = path.join(outputDir, "merkle-root.json");
  fs.writeFileSync(
    rootOutputPath,
    JSON.stringify(
      {
        root: output.root,
        totalAddresses: output.totalAddresses,
        generatedAt: output.generatedAt,
      },
      null,
      2
    )
  );
  console.log(`\nMerkle root saved to: ${rootOutputPath}`);

  // Write full proofs (for claiming)
  const proofsOutputPath = path.join(outputDir, "merkle-proofs.json");
  fs.writeFileSync(proofsOutputPath, JSON.stringify(output, null, 2));
  console.log(`Merkle proofs saved to: ${proofsOutputPath}`);

  // Print summary
  console.log("\n" + "=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));
  console.log(`Merkle Root: ${output.root}`);
  console.log(`Total Addresses: ${output.totalAddresses}`);
  console.log("=".repeat(60));

  // Print deployment command hint
  console.log("\nNext steps:");
  console.log("1. Fund the deployer wallet with cBTC for gas");
  console.log("2. Run deployment:");
  console.log("   npx hardhat run scripts/compensation/deploy.ts --network citrea");
  console.log("3. Transfer tokens to the deployed contract");
  console.log("4. Share data/compensation/merkle-proofs.json with frontend for user claiming");

  return output;
}

// Run if called directly
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

export { MerkleTree, main };
