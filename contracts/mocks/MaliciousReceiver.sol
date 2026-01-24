// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IJuiceSwapGatewayReentrancy {
    function removeLiquidity(
        uint256 tokenId,
        uint128 liquidityToRemove,
        address tokenA,
        address tokenB,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256, uint256);

    function swapExactTokensForTokens(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 minAmountOut,
        address to,
        uint256 deadline
    ) external payable returns (uint256);
}

/**
 * @title MaliciousReceiver
 * @notice Contract that attempts reentrancy when receiving native tokens
 * @dev Used for testing ReentrancyGuard protection on removeLiquidity with native cBTC output
 */
contract MaliciousReceiver {
    IJuiceSwapGatewayReentrancy public target;
    uint256 public tokenId;
    address public tokenA;
    address public tokenB;
    bool public attackEnabled;
    uint256 public attackCount;
    bool private _attacking;

    enum AttackType {
        REMOVE_LIQUIDITY,
        SWAP
    }
    AttackType public attackType;

    function setAttackRemoveLiquidity(address _target, uint256 _tokenId, address _tokenA, address _tokenB) external {
        target = IJuiceSwapGatewayReentrancy(_target);
        tokenId = _tokenId;
        tokenA = _tokenA;
        tokenB = _tokenB;
        attackType = AttackType.REMOVE_LIQUIDITY;
    }

    function setAttackSwap(address _target, address _tokenA, address _tokenB) external {
        target = IJuiceSwapGatewayReentrancy(_target);
        tokenA = _tokenA;
        tokenB = _tokenB;
        attackType = AttackType.SWAP;
    }

    function enableAttack(bool _enabled) external {
        attackEnabled = _enabled;
    }

    function resetAttackCount() external {
        attackCount = 0;
    }

    receive() external payable {
        if (attackEnabled && !_attacking && address(target) != address(0)) {
            _attacking = true;
            attackCount++;

            if (attackType == AttackType.REMOVE_LIQUIDITY) {
                try
                    target.removeLiquidity(tokenId, 0, tokenA, tokenB, 0, 0, address(this), block.timestamp + 3600)
                {} catch {}
            } else {
                try
                    target.swapExactTokensForTokens{value: msg.value}(
                        address(0), // Native token
                        tokenB,
                        3000,
                        msg.value,
                        0,
                        address(this),
                        block.timestamp + 3600
                    )
                {} catch {}
            }

            _attacking = false;
        }
    }

    // Allow contract to hold tokens for testing
    function withdraw() external {
        payable(msg.sender).transfer(address(this).balance);
    }
}
