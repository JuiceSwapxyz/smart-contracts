// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IJuiceSwapGovernor {
    function execute(uint256 proposalId) external;
}

/**
 * @title ReentrancyAttacker
 * @notice Malicious contract that attempts reentrancy on JuiceSwapGovernor
 */
contract ReentrancyAttacker {
    IJuiceSwapGovernor public governor;
    uint256 public proposalId;
    uint256 public callCount;
    bool public shouldAttack = true;

    event AttackAttempted(uint256 attemptNumber);
    event AttackReceived();

    constructor(address _governor) {
        governor = IJuiceSwapGovernor(_governor);
    }

    /**
     * @notice Set the proposal ID to attack
     */
    function setProposal(uint256 _proposalId) external {
        proposalId = _proposalId;
    }

    /**
     * @notice Enable/disable attack
     */
    function setShouldAttack(bool _shouldAttack) external {
        shouldAttack = _shouldAttack;
    }

    /**
     * @notice This function will be called by the Governor during execution
     * It attempts to re-enter the Governor's execute function
     */
    function attack() external {
        emit AttackReceived();
        callCount++;

        if (shouldAttack && callCount < 3) {
            emit AttackAttempted(callCount);
            // Try to re-enter execute() - will fail due to ReentrancyGuard
            try governor.execute(proposalId) {
                // This should never succeed
            } catch {
                // Expected to fail with ReentrancyGuard
            }
        }
    }

    /**
     * @notice Reset call count
     */
    function reset() external {
        callCount = 0;
    }

    /**
     * @notice Get call count
     */
    function getCallCount() external view returns (uint256) {
        return callCount;
    }
}
