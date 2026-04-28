import { ethers, network } from "hardhat";
import hre from "hardhat";
import axios from "axios";
import FormData from "form-data";
import fs from "fs";
import path from "path";
import "dotenv/config";

/**
 * One-Command NFT Deployment
 *
 * Creates First Squeezer NFT from image to deployed contract in one step:
 * 1. Upload image to Pinata IPFS
 * 2. Generate metadata JSON
 * 3. Upload metadata to Pinata IPFS
 * 4. Deploy contract to specified network
 * 5. Verify contract on block explorer (production only)
 *
 * Usage:
 *   hardhat create-nft --image "/path/to/image.jpeg"
 *   hardhat create-nft --network citreaTestnet --image "/path/to/image.jpeg"
 *
 * Requirements:
 *   - PINATA_JWT in .env (V3 JWT token from Pinata dashboard)
 *   - DEPLOYER_PRIVATE_KEY in .env (wallet with cBTC for production)
 *   - CAMPAIGN_SIGNER_ADDRESS in .env
 *   - CAMPAIGN_START in .env (unix timestamp in seconds)
 *   - CAMPAIGN_END in .env (unix timestamp in seconds, must be > CAMPAIGN_START and in the future)
 */

const PINATA_API_URL = "https://api.pinata.cloud";

interface PinataResponse {
  IpfsHash: string;
  PinSize: number;
  Timestamp: string;
}

/**
 * Validate environment variables
 */
function validateEnvironment(options: { requirePinata: boolean } = { requirePinata: true }): void {
  const required = [
    "DEPLOYER_PRIVATE_KEY",
    "CAMPAIGN_SIGNER_ADDRESS",
    "CAMPAIGN_START",
    "CAMPAIGN_END",
  ];
  if (options.requirePinata) {
    required.unshift("PINATA_JWT");
  }

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}\n` +
        "Please configure .env file (see .env.example)"
    );
  }

  const start = Number(process.env.CAMPAIGN_START);
  const end = Number(process.env.CAMPAIGN_END);

  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= 0) {
    throw new Error("CAMPAIGN_START and CAMPAIGN_END must be positive unix timestamps (seconds)");
  }

  if (start >= end) {
    throw new Error("CAMPAIGN_START must be strictly less than CAMPAIGN_END");
  }

  if (end <= Math.floor(Date.now() / 1000)) {
    throw new Error("CAMPAIGN_END must be in the future");
  }
}

/**
 * Upload image to Pinata IPFS
 */
async function uploadImage(imagePath: string): Promise<string> {
  console.log("Uploading image to IPFS...");

  // Validate file exists
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image not found: ${imagePath}`);
  }

  // Validate file type
  const ext = path.extname(imagePath).toLowerCase();
  if (![".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) {
    throw new Error(`Unsupported image type: ${ext}`);
  }

  // Create form data
  const formData = new FormData();
  formData.append("file", fs.createReadStream(imagePath));

  const metadata = JSON.stringify({
    name: path.basename(imagePath),
  });
  formData.append("pinataMetadata", metadata);

  // Upload to Pinata
  const response = await axios.post<PinataResponse>(
    `${PINATA_API_URL}/pinning/pinFileToIPFS`,
    formData,
    {
      headers: {
        ...formData.getHeaders(),
        Authorization: `Bearer ${process.env.PINATA_JWT}`,
      },
    }
  );

  const ipfsHash = response.data.IpfsHash;
  console.log(`Image uploaded: ipfs://${ipfsHash}\n`);
  return ipfsHash;
}

/**
 * Upload metadata to Pinata IPFS
 */
async function uploadMetadata(imageHash: string): Promise<string> {
  console.log("Uploading metadata to IPFS...");

  // Generate metadata JSON
  const metadata = {
    name: "First Squeezer",
    description: "Early supporter of JuiceSwap - First Squeezer Campaign NFT",
    image: `ipfs://${imageHash}`,
  };

  // Upload to Pinata
  const response = await axios.post<PinataResponse>(
    `${PINATA_API_URL}/pinning/pinJSONToIPFS`,
    metadata,
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.PINATA_JWT}`,
      },
    }
  );

  const ipfsHash = response.data.IpfsHash;
  console.log(`Metadata uploaded: ipfs://${ipfsHash}\n`);
  return ipfsHash;
}

/**
 * Deploy FirstSqueezerNFT contract
 */
async function deployContract(metadataURI: string): Promise<string> {
  console.log("Deploying contract...");

  const signerAddress = process.env.CAMPAIGN_SIGNER_ADDRESS!;
  const campaignStart = Number(process.env.CAMPAIGN_START);
  const campaignEnd = Number(process.env.CAMPAIGN_END);

  // Get deployer account
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);

  // Network detection
  console.log(`   Network: ${network.name} (Chain ID: ${network.config.chainId})`);
  console.log("   Deployer:", deployer.address);
  console.log("   Balance:", ethers.formatEther(balance), "cBTC");
  console.log("   Signer:", signerAddress);
  console.log("   Metadata:", metadataURI);
  console.log(`   Campaign start: ${campaignStart} (${new Date(campaignStart * 1000).toISOString()})`);
  console.log(`   Campaign end:   ${campaignEnd} (${new Date(campaignEnd * 1000).toISOString()})`);

  // Deploy contract
  const FirstSqueezerNFT = await ethers.getContractFactory("FirstSqueezerNFT");
  const nft = await FirstSqueezerNFT.deploy(signerAddress, metadataURI, campaignStart, campaignEnd);

  await nft.waitForDeployment();

  const contractAddress = await nft.getAddress();
  console.log(`Contract deployed: ${contractAddress}\n`);

  return contractAddress;
}

/**
 * Verify contract on block explorer
 */
async function verifyContract(
  contractAddress: string,
  signerAddress: string,
  metadataURI: string,
  campaignStart: number,
  campaignEnd: number
): Promise<void> {
  // Skip verification on local networks
  if (network.name === "hardhat" || network.name === "localhost") {
    return;
  }

  console.log("Verifying contract on block explorer...");

  try {
    await hre.run("verify:verify", {
      address: contractAddress,
      constructorArguments: [signerAddress, metadataURI, campaignStart, campaignEnd],
    });
    console.log("Contract verified!\n");
  } catch (error: any) {
    if (error.message.includes("Already Verified")) {
      console.log("Contract already verified!\n");
    } else {
      console.log("Verification failed:", error.message);
      console.log("   You can verify manually later.\n");
    }
  }
}

/**
 * Main execution
 */
export async function main(imagePath: string) {
  console.log("Creating First Squeezer NFT Contract\n");

  if (!imagePath) {
    throw new Error("No image path provided");
  }

  try {
    // Validate environment
    validateEnvironment();

    // Upload image to IPFS
    const imageHash = await uploadImage(imagePath);

    // Upload metadata to IPFS
    const metadataHash = await uploadMetadata(imageHash);
    const metadataURI = `ipfs://${metadataHash}`;

    // Deploy contract
    const contractAddress = await deployContract(metadataURI);

    // Verify contract
    await verifyContract(
      contractAddress,
      process.env.CAMPAIGN_SIGNER_ADDRESS!,
      metadataURI,
      Number(process.env.CAMPAIGN_START),
      Number(process.env.CAMPAIGN_END)
    );

    // Output summary
    console.log("=".repeat(70));
    console.log("NFT Contract Created Successfully!\n");
    console.log("Image URI:     ", `ipfs://${imageHash}`);
    console.log("Metadata URI:  ", metadataURI);
    console.log("Contract:      ", contractAddress);
    console.log("Network:       ", network.name);
    console.log("=".repeat(70));
    console.log("\nNext steps:");
    console.log("  1. Add to API .env:");
    console.log(`     FIRST_SQUEEZER_NFT_CONTRACT=${contractAddress}`);
    console.log("  2. Implement signature endpoint in API");
    console.log("  3. Update frontend with contract address");
    console.log("\nDeployment complete!");
  } catch (error: any) {
    if (axios.isAxiosError(error)) {
      console.error("\nUpload failed:", error.response?.data || error.message);
    } else {
      console.error("\nDeployment failed:", error.message);
    }
    throw error;
  }
}

/**
 * Deploy with an existing IPFS metadata URI (skips Pinata upload).
 *
 * Use this to reuse an already-pinned metadata JSON (e.g. to point the mainnet
 * contract at the exact same art/metadata as a prior testnet deploy).
 *
 * Requirements:
 *   - DEPLOYER_PRIVATE_KEY, CAMPAIGN_SIGNER_ADDRESS, CAMPAIGN_START, CAMPAIGN_END in .env
 *   - metadataURI starting with ipfs:// (e.g. ipfs://Qm...)
 *   - PINATA_JWT is NOT required on this path
 */
export async function deployFromExistingURI(metadataURI: string) {
  console.log("Deploying First Squeezer NFT from existing metadata URI\n");

  if (!metadataURI) {
    throw new Error("No metadata URI provided");
  }
  if (!/^ipfs:\/\/\S+$/.test(metadataURI)) {
    throw new Error(`Invalid metadata URI (expected 'ipfs://<cid>'): ${metadataURI}`);
  }

  try {
    // Validate environment (without Pinata — no upload on this path)
    validateEnvironment({ requirePinata: false });

    console.log("Reusing metadata URI:", metadataURI, "\n");

    // Deploy contract
    const contractAddress = await deployContract(metadataURI);

    // Verify contract
    await verifyContract(
      contractAddress,
      process.env.CAMPAIGN_SIGNER_ADDRESS!,
      metadataURI,
      Number(process.env.CAMPAIGN_START),
      Number(process.env.CAMPAIGN_END)
    );

    // Output summary
    console.log("=".repeat(70));
    console.log("NFT Contract Deployed Successfully!\n");
    console.log("Metadata URI: ", metadataURI, "(reused)");
    console.log("Contract:     ", contractAddress);
    console.log("Network:      ", network.name);
    console.log("=".repeat(70));
    console.log("\nNext steps:");
    console.log("  1. Update api/src/lib/constants/campaigns.ts:");
    console.log(`     FIRST_SQUEEZER_NFT_CONTRACT = "${contractAddress}"`);
    console.log("  2. Add citrea entry to ponder.config.ts FirstSqueezerNFT with this address and the deployment block");
    console.log("  3. Create deployments/mainnet/firstSqueezerNFT.json");
    console.log("\nDeployment complete!");
  } catch (error: any) {
    console.error("\nDeployment failed:", error.message);
    throw error;
  }
}
