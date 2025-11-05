// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IUniswapV3Pool {
    function mint(
        address recipient,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount,
        bytes calldata data
    ) external returns (uint256 amount0, uint256 amount1);

    function token0() external view returns (address);
    function token1() external view returns (address);
}

contract LiquidityHelper {
    function addLiquidity(
        address pool,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity
    ) external returns (uint256 amount0, uint256 amount1) {
        (amount0, amount1) = IUniswapV3Pool(pool).mint(
            address(this),
            tickLower,
            tickUpper,
            liquidity,
            ""
        );
    }

    function uniswapV3MintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata
    ) external {
        if (amount0Owed > 0) {
            address token0 = IUniswapV3Pool(msg.sender).token0();
            IERC20(token0).transfer(msg.sender, amount0Owed);
        }
        if (amount1Owed > 0) {
            address token1 = IUniswapV3Pool(msg.sender).token1();
            IERC20(token1).transfer(msg.sender, amount1Owed);
        }
    }
}
