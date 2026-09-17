// GENERATED from abi/MigratorRegistry.json at the repository root - do not edit.
// Pinned to arcnow-io/contracts; see pins.json.

/**
 * ABI of the arcnow.io `MigratorRegistry` contract.
 *
 * `as const` because viem reads the literal types out of it: without it every
 * read, write and log decode against this contract degrades to `unknown`.
 */
export const migratorRegistryAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "admin_",
        "type": "address",
        "internalType": "address"
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
    "name": "deregisterMigrator",
    "inputs": [
      {
        "name": "migrator",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "isRegistered",
    "inputs": [
      {
        "name": "migrator",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "registered",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "migratorAt",
    "inputs": [
      {
        "name": "index",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "migrator",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "migratorCount",
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
    "name": "registerMigrator",
    "inputs": [
      {
        "name": "migrator",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "label",
        "type": "string",
        "internalType": "string"
      }
    ],
    "outputs": [
      {
        "name": "mode",
        "type": "uint8",
        "internalType": "enum IMigrator.TaxMode"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "registerMigrator",
    "inputs": [
      {
        "name": "migrator",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "router",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "label",
        "type": "string",
        "internalType": "string"
      }
    ],
    "outputs": [
      {
        "name": "mode",
        "type": "uint8",
        "internalType": "enum IMigrator.TaxMode"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "routerOf",
    "inputs": [
      {
        "name": "migrator",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "router",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "supportsQuote",
    "inputs": [
      {
        "name": "migrator",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "quote",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "supported",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "taxModeOf",
    "inputs": [
      {
        "name": "migrator",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "mode",
        "type": "uint8",
        "internalType": "enum IMigrator.TaxMode"
      }
    ],
    "stateMutability": "view"
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
    "name": "MigratorDeregistered",
    "inputs": [
      {
        "name": "migrator",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "MigratorRegistered",
    "inputs": [
      {
        "name": "migrator",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "mode",
        "type": "uint8",
        "indexed": true,
        "internalType": "enum IMigrator.TaxMode"
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
    "name": "MigratorRegistryDeployed",
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
    "type": "event",
    "name": "MigratorRouterRecorded",
    "inputs": [
      {
        "name": "migrator",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "router",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "MigratorAlreadyRegistered",
    "inputs": [
      {
        "name": "migrator",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "MigratorNotRegistered",
    "inputs": [
      {
        "name": "migrator",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotAMigrator",
    "inputs": [
      {
        "name": "migrator",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "NotARouter",
    "inputs": [
      {
        "name": "router",
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
    "name": "ZeroAddress",
    "inputs": []
  }
] as const;
