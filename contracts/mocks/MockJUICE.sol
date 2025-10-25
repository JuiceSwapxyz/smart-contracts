// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockJUICE
 * @notice Mock Equity token with voting functionality for testing
 */
contract MockJUICE is ERC20 {
    // Mapping of address to their voting power
    mapping(address => uint256) private _votingPower;

    // Total voting power in the system
    uint256 private _totalVotingPower;

    // Delegation mapping
    mapping(address => address) public delegates;

    constructor() ERC20("Mock JUICE", "MJUICE") {
        _mint(msg.sender, 10_000_000 * 10**18);
    }

    /**
     * @notice Mint tokens for testing
     */
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /**
     * @notice Set voting power for an address (for testing)
     * @dev Does not automatically update total voting power - use setTotalVotingPower separately
     */
    function setVotingPower(address account, uint256 power) external {
        _votingPower[account] = power;
    }

    /**
     * @notice Set total voting power (for testing)
     */
    function setTotalVotingPower(uint256 power) external {
        _totalVotingPower = power;
    }

    /**
     * @notice The votes of the holder, excluding votes from delegates
     */
    function votes(address holder) external view returns (uint256) {
        return _votingPower[holder];
    }

    /**
     * @notice Total number of votes in the system
     */
    function totalVotes() external view returns (uint256) {
        return _totalVotingPower;
    }

    /**
     * @notice The number of votes the sender commands when taking the support of the helpers into account
     * @param sender    The address whose total voting power is of interest
     * @param helpers   An incrementally sorted list of helpers without duplicates and without the sender
     * @return          The total number of votes of sender at the current point in time
     */
    function votesDelegated(address sender, address[] calldata helpers) external view returns (uint256) {
        uint256 totalVotes = _votingPower[sender];

        // Add votes from helpers (simulating delegation)
        for (uint256 i = 0; i < helpers.length; i++) {
            address helper = helpers[i];
            require(helper != sender, "Helper cannot be sender");
            require(delegates[helper] == sender, "Helper must delegate to sender");

            // Check sorted and no duplicates
            if (i > 0) {
                require(helper > helpers[i-1], "Helpers must be sorted");
            }

            totalVotes += _votingPower[helper];
        }

        return totalVotes;
    }

    /**
     * @notice Delegate voting power to another address
     */
    function delegateVoteTo(address delegate) external {
        delegates[msg.sender] = delegate;
    }
}
