// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IMintableERC20 {
    function mint(address to, uint256 amount) external;
}

/**
 * @title MockSwapRouter
 * @notice Mock implementation of Uniswap V3 SwapRouter02 for testing
 * @dev Simulates swap behavior without actual pool logic.
 *      Accurately simulates real SwapRouter02 behavior where tokens are
 *      pulled via transferFrom from the caller (Gateway) during the pool callback.
 *
 *      SwapRouter02's exactInputSingle does NOT have a deadline parameter -
 *      that was only in the original SwapRouter.
 */
contract MockSwapRouter {
    uint256 private _outputAmount;
    uint256 public swapCallCount;

    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    /**
     * @notice Set the output amount for the next swap (for testing)
     */
    function setSwapOutput(uint256 amount) external {
        _outputAmount = amount;
    }

    /**
     * @notice Mock exactInputSingle swap
     * @dev Simulates real SwapRouter02 behavior:
     *      The router pulls tokens from msg.sender via transferFrom during the
     *      pool callback. The caller must have approved the router for the input amount.
     */
    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut)
    {
        // Track call count for testing
        swapCallCount++;

        // Pull input tokens from caller (simulates pool callback behavior)
        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);

        // Calculate output amount
        amountOut = _outputAmount > 0 ? _outputAmount : params.amountIn;

        require(amountOut >= params.amountOutMinimum, "Insufficient output");

        // Try to mint tokens to recipient (for mintable tokens)
        // If minting fails, try to transfer from our balance
        try IMintableERC20(params.tokenOut).mint(params.recipient, amountOut) {
            // Mint succeeded
        } catch {
            // Fallback: transfer from our balance (requires pre-funding)
            IERC20(params.tokenOut).transfer(params.recipient, amountOut);
        }

        return amountOut;
    }

    /**
     * @notice Receive native tokens
     */
    receive() external payable {}
}
