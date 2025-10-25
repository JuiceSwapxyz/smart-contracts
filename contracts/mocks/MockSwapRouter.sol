// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title MockSwapRouter
 * @notice Mock Uniswap V3 SwapRouter for testing
 */
contract MockSwapRouter {
    // Exchange rate for swaps (in basis points, 10000 = 1:1)
    mapping(address => mapping(address => uint256)) public exchangeRates;

    // Slippage simulation (in basis points, 100 = 1%)
    uint256 public slippageBps = 0;

    event Swap(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address recipient
    );

    /**
     * @notice Set exchange rate between two tokens
     * @param tokenIn Input token
     * @param tokenOut Output token
     * @param rateBps Rate in basis points (10000 = 1:1, 20000 = 2:1)
     */
    function setExchangeRate(address tokenIn, address tokenOut, uint256 rateBps) external {
        exchangeRates[tokenIn][tokenOut] = rateBps;
    }

    /**
     * @notice Set slippage for testing
     * @param _slippageBps Slippage in basis points (100 = 1%)
     */
    function setSlippage(uint256 _slippageBps) external {
        slippageBps = _slippageBps;
    }

    /**
     * @notice exactInput swap (simplified mock)
     */
    function exactInput(ExactInputParams calldata params) external returns (uint256 amountOut) {
        // Decode path to get tokenIn and tokenOut
        (address tokenIn, address tokenOut) = _decodePath(params.path);

        // Get exchange rate
        uint256 rate = exchangeRates[tokenIn][tokenOut];
        require(rate > 0, "Exchange rate not set");

        // Calculate output with rate
        amountOut = (params.amountIn * rate) / 10000;

        // Apply slippage
        if (slippageBps > 0) {
            amountOut = (amountOut * (10000 - slippageBps)) / 10000;
        }

        // Check minimum output
        require(amountOut >= params.amountOutMinimum, "Slippage too high");

        // Transfer tokens
        IERC20(tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        IERC20(tokenOut).transfer(params.recipient, amountOut);

        emit Swap(tokenIn, tokenOut, params.amountIn, amountOut, params.recipient);
    }

    /**
     * @notice Decode path to get first and last tokens
     * @dev Path format: [address(20), uint24(3), address(20), ...]
     */
    function _decodePath(bytes memory path) internal pure returns (address tokenIn, address tokenOut) {
        require(path.length >= 43, "Path too short"); // min: address + uint24 + address

        // First token (bytes 0-19)
        assembly {
            // Memory layout: [length(32 bytes)][data...]
            // First address starts at offset 32
            tokenIn := shr(96, mload(add(path, 32)))
        }

        // Last token (last 20 bytes)
        assembly {
            // Last address is at: 32 (length slot) + path.length - 20 (address size)
            let lastTokenOffset := add(add(path, 32), sub(mload(path), 20))
            tokenOut := shr(96, mload(lastTokenOffset))
        }
    }

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    /**
     * @notice Helper to fund router with tokens for testing
     */
    function fundRouter(address token, uint256 amount) external {
        IERC20(token).transferFrom(msg.sender, address(this), amount);
    }
}
