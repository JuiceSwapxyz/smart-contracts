// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface ICompensationClaim {
    function claim(bytes32[] calldata proof) external;
}

/**
 * @title MaliciousERC20Reentrancy
 * @notice Malicious ERC20 that attempts reentrancy during transfer
 * @dev Used for testing ReentrancyGuard protection in CompensationClaim
 */
contract MaliciousERC20Reentrancy is ERC20 {
    ICompensationClaim public target;
    bytes32[] public attackProof;
    bool public attackEnabled;
    uint256 public attackCount;

    constructor() ERC20("Malicious", "MAL") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setAttack(address _target, bytes32[] calldata _proof) external {
        target = ICompensationClaim(_target);
        attackProof = _proof;
        attackEnabled = true;
    }

    function disableAttack() external {
        attackEnabled = false;
    }

    /**
     * @notice Override transfer to attempt reentrancy
     */
    function transfer(address to, uint256 amount) public override returns (bool) {
        if (attackEnabled && address(target) != address(0) && attackCount == 0) {
            attackCount++;
            // Attempt reentrancy - should fail with ReentrancyGuardReentrantCall
            try target.claim(attackProof) {
                // If this succeeds, reentrancy protection failed!
            } catch {
                // Expected - ReentrancyGuard blocks the call
            }
        }
        return super.transfer(to, amount);
    }
}
