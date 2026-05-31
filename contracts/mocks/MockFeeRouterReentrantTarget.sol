// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IMockFeeRouterMintableERC20 {
    function mint(address to, uint256 amount) external;
}

/**
 * @title MockFeeRouterReentrantTarget
 * @notice Swap target that attempts to reenter the FeeRouter during a swap.
 */
contract MockFeeRouterReentrantTarget {
    address public router;
    bytes public reentrantCallData;
    bool public attackEnabled;
    bool public reentrancyAttempted;
    bool public reentrancySucceeded;

    struct SwapParams {
        address tokenIn;
        address tokenOut;
        address recipient;
        uint256 amountIn;
        uint256 amountOut;
    }

    function setAttack(address router_, bytes calldata reentrantCallData_) external {
        router = router_;
        reentrantCallData = reentrantCallData_;
    }

    function setAttackEnabled(bool enabled) external {
        attackEnabled = enabled;
    }

    function swap(SwapParams calldata params) external returns (uint256 amountOut) {
        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);

        if (attackEnabled) {
            reentrancyAttempted = true;
            (reentrancySucceeded, ) = router.call(reentrantCallData);
        }

        amountOut = params.amountOut;
        IMockFeeRouterMintableERC20(params.tokenOut).mint(params.recipient, amountOut);
    }
}
