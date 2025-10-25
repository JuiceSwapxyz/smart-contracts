// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title IEquity
 * @notice Interface for the JUICE Equity contract voting mechanism
 */
interface IEquity {
    /**
     * @notice The votes of the holder, excluding votes from delegates.
     */
    function votes(address holder) external view returns (uint256);

    /**
     * @notice Total number of votes in the system.
     */
    function totalVotes() external view returns (uint256);

    /**
     * @notice The number of votes the sender commands when taking the support of the helpers into account.
     * @param sender    The address whose total voting power is of interest
     * @param helpers   An incrementally sorted list of helpers without duplicates and without the sender.
     *                  The call fails if the list contains an address that does not delegate to sender.
     *                  For indirect delegates, i.e. a -> b -> c, both a and b must be included for both to count.
     * @return          The total number of votes of sender at the current point in time.
     */
    function votesDelegated(address sender, address[] calldata helpers) external view returns (uint256);

    /**
     * @notice Delegation mapping
     */
    function delegates(address owner) external view returns (address);
}
