// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IFeeRouter {
    function swapExactInputSingleJuiceSwap(
        address tokenIn,
        address tokenOut,
        uint24 poolFee,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint160 sqrtPriceLimitX96,
        uint256 deadline,
        bool unwrapNative
    ) external payable returns (uint256);

    function convertAccumulated(address token) external returns (uint256);
    function flush() external returns (uint256);
}

/// @notice Hostile end-user wallet used to verify the FeeRouter is
///         re-entry-safe on the native-cBTC delivery path. When the
///         router calls `.call{value: amount}("")` to send native cBTC
///         after `WCBTC.withdraw`, this contract's receive() tries to
///         re-enter the router. Must revert.
contract ReentrantReceiver {
    IFeeRouter public immutable ROUTER;
    address public immutable TOKEN;
    enum Mode { Swap, Convert, Flush }
    Mode public mode;

    constructor(address router, address token) {
        ROUTER = IFeeRouter(router);
        TOKEN = token;
    }

    function setMode(Mode m) external {
        mode = m;
    }

    function attack(
        address tokenOut,
        uint256 amountIn,
        bool nativeIn,
        bool unwrap
    ) external payable {
        ROUTER.swapExactInputSingleJuiceSwap{value: nativeIn ? amountIn : 0}(
            TOKEN, tokenOut, 3000, amountIn, 0, 0, block.timestamp + 600, unwrap
        );
    }

    receive() external payable {
        if (mode == Mode.Swap) {
            ROUTER.swapExactInputSingleJuiceSwap(
                TOKEN, TOKEN, 3000, 1, 0, 0, block.timestamp + 600, false
            );
        } else if (mode == Mode.Convert) {
            ROUTER.convertAccumulated(TOKEN);
        } else if (mode == Mode.Flush) {
            ROUTER.flush();
        }
    }
}
