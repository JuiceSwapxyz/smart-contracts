// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice Subset of the JuiceDollar StablecoinBridge used to mint JUSD 1:1
///         from a bridged source stablecoin (USDC.e, ctUSD).
interface IFeeRouterStablecoinBridge {
    function mintTo(address target, uint256 amount) external;
    function stopped() external view returns (bool);
    function usd() external view returns (address);
}

/// @notice Wrapped cBTC interface (WETH9-style).
interface IWrappedCBTC {
    function deposit() external payable;
    function withdraw(uint256 wad) external;
}

/// @notice Algebra Integral v1.9 SwapRouter (used by Satsuma on Citrea Mainnet).
interface IAlgebraSwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        address deployer;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 limitSqrtPrice;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

/// @notice Uniswap V3 SwapRouter (used by JuiceSwap V3).
interface IUniswapV3SwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);

    function exactInput(ExactInputParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}
