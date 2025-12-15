// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./MockFactory.sol";

/**
 * @title MockPositionManager
 * @notice Mock implementation of Uniswap V3 NonfungiblePositionManager for testing
 * @dev Simulates NFT-based liquidity positions
 */
contract MockPositionManager is ERC721 {
    MockFactory private immutable _factory;
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline; // Added to match interface
    }

    struct Position {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
    }

    uint256 private _nextTokenId = 1;
    mapping(uint256 => Position) private _positions;

    // Test helpers
    uint256 private _mockTokenId;
    uint128 private _mockLiquidity;
    uint256 private _mockAmount0;
    uint256 private _mockAmount1;

    uint256 private _mockDecreaseAmount0;
    uint256 private _mockDecreaseAmount1;

    constructor() ERC721("Mock Position", "MPOS") {
        _factory = new MockFactory();
    }

    function factory() external view returns (address) {
        return address(_factory);
    }

    /**
     * @notice Mock mint function
     */
    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        // Use preset values if available, otherwise calculate
        tokenId = _mockTokenId > 0 ? _mockTokenId : _nextTokenId++;
        liquidity = _mockLiquidity > 0 ? _mockLiquidity : 100;
        amount0 = _mockAmount0 > 0 ? _mockAmount0 : params.amount0Desired;
        amount1 = _mockAmount1 > 0 ? _mockAmount1 : params.amount1Desired;

        // Transfer tokens from sender
        if (amount0 > 0) {
            IERC20(params.token0).transferFrom(msg.sender, address(this), amount0);
        }
        if (amount1 > 0) {
            IERC20(params.token1).transferFrom(msg.sender, address(this), amount1);
        }

        // Store position
        _positions[tokenId] = Position({
            token0: params.token0,
            token1: params.token1,
            fee: params.fee,
            tickLower: params.tickLower,
            tickUpper: params.tickUpper,
            liquidity: liquidity
        });

        // Mint NFT
        _mint(params.recipient, tokenId);

        return (tokenId, liquidity, amount0, amount1);
    }

    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    /**
     * @notice Mock decreaseLiquidity function
     */
    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1)
    {
        require(
            ownerOf(params.tokenId) == msg.sender || getApproved(params.tokenId) == msg.sender,
            "Not authorized"
        );

        Position storage pos = _positions[params.tokenId];
        require(pos.liquidity >= params.liquidity, "Insufficient liquidity");

        pos.liquidity -= params.liquidity;

        amount0 = _mockDecreaseAmount0 > 0 ? _mockDecreaseAmount0 : 0;
        amount1 = _mockDecreaseAmount1 > 0 ? _mockDecreaseAmount1 : 0;

        return (amount0, amount1);
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    /**
     * @notice Mock collect function
     */
    function collect(CollectParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1)
    {
        require(
            ownerOf(params.tokenId) == msg.sender || getApproved(params.tokenId) == msg.sender,
            "Not authorized"
        );

        Position storage pos = _positions[params.tokenId];

        // Return the amounts we calculated in decreaseLiquidity
        amount0 = _mockDecreaseAmount0;
        amount1 = _mockDecreaseAmount1;

        // Cap at max
        if (amount0 > params.amount0Max) amount0 = params.amount0Max;
        if (amount1 > params.amount1Max) amount1 = params.amount1Max;

        // Transfer tokens
        if (amount0 > 0 && pos.token0 != address(0)) {
            IERC20(pos.token0).transfer(params.recipient, amount0);
        }
        if (amount1 > 0 && pos.token1 != address(0)) {
            IERC20(pos.token1).transfer(params.recipient, amount1);
        }

        return (amount0, amount1);
    }

    /**
     * @notice Get position data (mimics Uniswap V3)
     */
    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        )
    {
        Position storage pos = _positions[tokenId];
        return (
            0, // nonce
            address(0), // operator
            pos.token0,
            pos.token1,
            pos.fee,
            pos.tickLower,
            pos.tickUpper,
            pos.liquidity,
            0, // feeGrowthInside0LastX128
            0, // feeGrowthInside1LastX128
            0, // tokensOwed0
            0  // tokensOwed1
        );
    }

    // ========== Test Helpers ==========

    function setMintResult(
        uint256 tokenId,
        uint128 liquidity,
        uint256 amount0,
        uint256 amount1
    ) external {
        _mockTokenId = tokenId;
        _mockLiquidity = liquidity;
        _mockAmount0 = amount0;
        _mockAmount1 = amount1;
    }

    function setDecreaseResult(uint256 amount0, uint256 amount1) external {
        _mockDecreaseAmount0 = amount0;
        _mockDecreaseAmount1 = amount1;
    }

    function setPositionData(
        uint256 tokenId,
        address token0,
        address token1,
        uint128 liquidity
    ) external {
        _positions[tokenId] = Position({
            token0: token0,
            token1: token1,
            fee: 3000,
            tickLower: -887220,
            tickUpper: 887220,
            liquidity: liquidity
        });
    }

    function mintNFT(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }

    receive() external payable {}
}
