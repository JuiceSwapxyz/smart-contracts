// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockJUSD
 * @notice Mock JuiceDollar token for testing
 */
contract MockJUSD is ERC20 {
    constructor() ERC20("Mock JuiceDollar", "MJUSD") {
        // Mint initial supply to deployer
        _mint(msg.sender, 1_000_000 * 10**18);
    }

    /**
     * @notice Mint tokens for testing
     */
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /**
     * @notice Burn tokens for testing
     */
    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}
