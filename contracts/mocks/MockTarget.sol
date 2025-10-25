// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title MockTarget
 * @notice Mock contract to test proposal execution
 */
contract MockTarget {
    uint8 public feeProtocol0;
    uint8 public feeProtocol1;
    uint24 public feeAmount;
    int24 public tickSpacing;
    address public owner;
    bool public wasUpgraded;
    uint256 public counter;

    event FeeProtocolSet(uint8 feeProtocol0, uint8 feeProtocol1);
    event FeeAmountEnabled(uint24 fee, int24 tickSpacing);
    event OwnerSet(address newOwner);
    event Upgraded(address implementation);
    event FunctionCalled(string name);

    /**
     * @notice Simulate setFeeProtocol from UniswapV3Pool
     */
    function setFeeProtocol(uint8 _feeProtocol0, uint8 _feeProtocol1) external {
        feeProtocol0 = _feeProtocol0;
        feeProtocol1 = _feeProtocol1;
        emit FeeProtocolSet(_feeProtocol0, _feeProtocol1);
    }

    /**
     * @notice Simulate enableFeeAmount from UniswapV3Factory
     */
    function enableFeeAmount(uint24 fee, int24 _tickSpacing) external {
        feeAmount = fee;
        tickSpacing = _tickSpacing;
        emit FeeAmountEnabled(fee, _tickSpacing);
    }

    /**
     * @notice Simulate setOwner from UniswapV3Factory
     */
    function setOwner(address _owner) external {
        owner = _owner;
        emit OwnerSet(_owner);
    }

    /**
     * @notice Simulate transferOwnership from Ownable
     */
    function transferOwnership(address newOwner) external {
        owner = newOwner;
        emit OwnerSet(newOwner);
    }

    /**
     * @notice Simulate upgrade from ProxyAdmin
     */
    function upgrade(address /* proxy */, address implementation) external {
        wasUpgraded = true;
        emit Upgraded(implementation);
    }

    /**
     * @notice Function that increments counter
     */
    function incrementCounter() external {
        counter++;
        emit FunctionCalled("incrementCounter");
    }

    /**
     * @notice Function that always reverts
     */
    function failingFunction() external pure {
        revert("Intentional failure");
    }

    /**
     * @notice Function with complex parameters
     */
    function complexFunction(
        address addr,
        uint256 amount,
        bytes calldata data
    ) external returns (bool) {
        emit FunctionCalled("complexFunction");
        return data.length > 0 && amount > 0 && addr != address(0);
    }
}
