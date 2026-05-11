// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../governance/interfaces/IExternalRouters.sol";

/// @notice Mock StablecoinBridge for FeeRouter tests.
///         Pulls `amount` of source token, mints `amount * scale` of JUSD
///         to `target`. Scale handles decimals difference (e.g. 1e12 for
///         6-decimal source token → 18-decimal JUSD).
contract MockFeeRouterBridge {
    using SafeERC20 for IERC20;
    address public immutable source;
    address public immutable JUSDtoken;
    uint256 public immutable scale;
    bool public stopped;

    constructor(address _source, address _jusd, uint256 _scale) {
        source = _source;
        JUSDtoken = _jusd;
        scale = _scale;
    }

    function usd() external view returns (address) { return source; }
    function JUSD() external view returns (address) { return JUSDtoken; }

    function setStopped(bool v) external { stopped = v; }

    function mintTo(address target, uint256 amount) external {
        require(!stopped, "MockBridge: stopped");
        IERC20(source).safeTransferFrom(msg.sender, address(this), amount);
        // Mock: bridge holds source, and we ask the JUSD ERC20 mock to mint.
        IMintable(JUSDtoken).mint(target, amount * scale);
    }
}

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// @notice 1:1 mock router used by FeeRouter unit tests. Quotes 1 in = 1 out.
contract MockAlgebraSwapRouter is IAlgebraSwapRouter {
    using SafeERC20 for IERC20;

    bool public revertNext;

    function setRevertNext(bool v) external {
        revertNext = v;
    }

    function exactInputSingle(ExactInputSingleParams calldata p)
        external
        payable
        override
        returns (uint256 amountOut)
    {
        require(!revertNext, "MockAlgebra: revert flag");
        IERC20(p.tokenIn).safeTransferFrom(msg.sender, address(this), p.amountIn);
        amountOut = p.amountIn; // 1:1
        require(amountOut >= p.amountOutMinimum, "MockAlgebra: slippage");
        IERC20(p.tokenOut).safeTransfer(p.recipient, amountOut);
    }
}

/// @notice Uniswap V3-style 1:1 mock router for FeeRouter tests.
contract MockV3SwapRouter is IUniswapV3SwapRouter {
    using SafeERC20 for IERC20;

    function exactInputSingle(ExactInputSingleParams calldata p)
        external
        payable
        override
        returns (uint256 amountOut)
    {
        IERC20(p.tokenIn).safeTransferFrom(msg.sender, address(this), p.amountIn);
        amountOut = p.amountIn;
        require(amountOut >= p.amountOutMinimum, "MockV3: slippage");
        IERC20(p.tokenOut).safeTransfer(p.recipient, amountOut);
    }

    function exactInput(ExactInputParams calldata p)
        external
        payable
        override
        returns (uint256 amountOut)
    {
        bytes memory path = p.path;
        // path layout: tokenIn(20) | fee(3) | tokenOut(20) [| fee | token ...]
        address tokenIn;
        address tokenOut;
        uint256 len = path.length;
        assembly {
            tokenIn := shr(96, mload(add(path, 32)))
            // last 20 bytes
            tokenOut := shr(96, mload(add(add(path, 32), sub(len, 20))))
        }
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), p.amountIn);
        amountOut = p.amountIn;
        require(amountOut >= p.amountOutMinimum, "MockV3: slippage");
        IERC20(tokenOut).safeTransfer(p.recipient, amountOut);
    }
}
