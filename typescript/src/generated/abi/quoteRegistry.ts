// GENERATED from abi/QuoteRegistry.json at the repository root - do not edit.
// Pinned to arcnow-io/contracts; see pins.json.

/**
 * ABI of the arcnow.io `QuoteRegistry` contract.
 *
 * `as const` because viem reads the literal types out of it: without it every
 * read, write and log decode against this contract degrades to `unknown`.
 */
export const quoteRegistryAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "admin_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "nativeLaunchFeeWad",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "VERSION",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "string",
        "internalType": "string"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "acceptAdmin",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "admin",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "deregisterQuoteToken",
    "inputs": [
      {
        "name": "quote",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "isQuoteToken",
    "inputs": [
      {
        "name": "quote",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pendingAdmin",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "quoteInfo",
    "inputs": [
      {
        "name": "quote",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "decimals",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "launchFeeWad",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "active",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "quoteTokenAt",
    "inputs": [
      {
        "name": "i",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "quoteTokenCount",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "registerQuoteToken",
    "inputs": [
      {
        "name": "quote",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "launchFeeWad",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "label",
        "type": "string",
        "internalType": "string"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setLaunchFee",
    "inputs": [
      {
        "name": "quote",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "launchFeeWad",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "transferAdmin",
    "inputs": [
      {
        "name": "newAdmin",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "AdminTransferStarted",
    "inputs": [
      {
        "name": "currentAdmin",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "pendingAdmin",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "AdminTransferred",
    "inputs": [
      {
        "name": "oldAdmin",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "newAdmin",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "QuoteLaunchFeeChanged",
    "inputs": [
      {
        "name": "quote",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "oldFeeWad",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "newFeeWad",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "QuoteTokenDeregistered",
    "inputs": [
      {
        "name": "quote",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "QuoteTokenRegistered",
    "inputs": [
      {
        "name": "quote",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "decimals",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      },
      {
        "name": "launchFeeWad",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "label",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "QuoteTokenRegistryDeployed",
    "inputs": [
      {
        "name": "admin",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "LaunchFeeNotRepresentable",
    "inputs": [
      {
        "name": "quote",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "launchFeeWad",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "NativeQuoteIsPermanent",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotAQuoteToken",
    "inputs": [
      {
        "name": "quote",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotAdmin",
    "inputs": [
      {
        "name": "caller",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotPendingAdmin",
    "inputs": [
      {
        "name": "caller",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "QuoteTokenAlreadyRegistered",
    "inputs": [
      {
        "name": "quote",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "QuoteTokenNotRegistered",
    "inputs": [
      {
        "name": "quote",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  }
] as const;
