// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IJuiceSwapGatewayReentrancy {
    function swapExactTokensForTokens(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 minAmountOut,
        address to,
        uint256 deadline
    ) external payable returns (uint256);

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint24 fee,
        int24 tickLower,
        int24 tickUpper,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountA, uint256 amountB, uint256 liquidity);
}

/**
 * @title MaliciousERC20
 * @notice ERC20 that attempts reentrancy during transfer/transferFrom callbacks
 * @dev Used for testing ReentrancyGuard protection in JuiceSwapGateway
 */
contract MaliciousERC20 is ERC20 {
    IJuiceSwapGatewayReentrancy public target;
    address public tokenOut;
    bool public attackOnTransfer;
    bool public attackOnTransferFrom;
    uint256 public attackCount;
    bool private _attacking;

    constructor() ERC20("Malicious Token", "EVIL") {}

    function setTarget(address _target, address _tokenOut) external {
        target = IJuiceSwapGatewayReentrancy(_target);
        tokenOut = _tokenOut;
    }

    function enableAttackOnTransfer(bool _enabled) external {
        attackOnTransfer = _enabled;
    }

    function enableAttackOnTransferFrom(bool _enabled) external {
        attackOnTransferFrom = _enabled;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (attackOnTransfer && !_attacking && address(target) != address(0)) {
            _attacking = true;
            attackCount++;
            // Attempt reentrant call to swap
            try
                target.swapExactTokensForTokens(
                    address(this),
                    tokenOut,
                    3000,
                    1 ether,
                    0,
                    msg.sender,
                    block.timestamp + 3600
                )
            {} catch {}
            _attacking = false;
        }
        return super.transfer(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (attackOnTransferFrom && !_attacking && address(target) != address(0)) {
            _attacking = true;
            attackCount++;
            // Attempt reentrant call to swap
            try
                target.swapExactTokensForTokens(address(this), tokenOut, 3000, 1 ether, 0, from, block.timestamp + 3600)
            {} catch {}
            _attacking = false;
        }
        return super.transferFrom(from, to, amount);
    }

    function resetAttackCount() external {
        attackCount = 0;
    }
}
