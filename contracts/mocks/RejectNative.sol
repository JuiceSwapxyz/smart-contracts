// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title RejectNative
 * @notice Contract that rejects all native token transfers
 * @dev Used for testing TransferFailed error handling in JuiceSwapGateway
 */
contract RejectNative {
    error NativeTokenRejected();

    receive() external payable {
        revert NativeTokenRejected();
    }

    fallback() external payable {
        revert NativeTokenRejected();
    }
}
