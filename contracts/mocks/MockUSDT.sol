// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockUSDT
 * @notice Mock Tether USD for testing
 */
contract MockUSDT is ERC20 {
    constructor() ERC20("Mock Tether USD", "USDT") {
        // 6 decimals like real USDT
        _mint(msg.sender, 1_000_000_000 * 10**6);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
