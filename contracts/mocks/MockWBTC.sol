// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockWBTC
 * @notice Mock Wrapped Bitcoin for testing
 */
contract MockWBTC is ERC20 {
    constructor() ERC20("Mock Wrapped Bitcoin", "WBTC") {
        // 8 decimals like real WBTC
        _mint(msg.sender, 1_000_000 * 10**8);
    }

    function decimals() public pure override returns (uint8) {
        return 8;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
