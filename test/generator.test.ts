import { expect } from 'chai';
import { parseAddress, TransactionSkeletonType, sealTransaction } from '@ckb-lumos/helpers';
import { common } from '@ckb-lumos/common-scripts';
import { key } from "@ckb-lumos/hd";
import { RPC } from "@ckb-lumos/rpc";
import { Indexer } from '@ckb-lumos/ckb-indexer';
import { Script, CellProvider } from '@ckb-lumos/base';
import * as fs from 'fs';
import { compareScriptBinaryWithOnChainData, generateDeployWithTypeIdTx, generateDeployWithDataTx, generateUpgradeTypeIdDataTx, payFee, getScriptConfig, UpgradeOptions, DeployOptions } from '../src/generator';
import { calculateTxFee } from "../src/utils";
import { getConfig, initializeConfig } from '@ckb-lumos/config-manager';
import { Provider } from '../src/provider';
import { dirname } from 'path'; 
import { predefined } from "@ckb-lumos/config-manager";
const { AGGRON4 } = predefined;

// const BINARY_PATH = './bin/rc_lock';
// const sudtBin = fs.readFileSync(BINARY_PATH);
const sudtBin = Uint8Array.of(1);
const rpc = new RPC("https://testnet.ckb.dev/rpc");

const CKB_RPC_URL = "https://testnet.ckb.dev/rpc";
const CKB_INDEXER_URL = "https://testnet.ckb.dev/indexer";
const indexer = new Indexer(CKB_INDEXER_URL, CKB_RPC_URL);

const ALICE = {
  PRIVATE_KEY:
    "0xf571db32dace55dc75f6df7f2e1a0fb0ec730cfdde2ed6e5a4998673503d513b",
  ADDRESS: "ckt1qyqptxys5l9vk39ft0hswscxgseawc77y2wqlr558h",
  ARGS: "0x159890a7cacb44a95bef0743064433d763de229c",
  //LOCKHASH: "0x173924b290925c48a9cd55d00360fd6ad81e2081c8e0ada42dce1aafd2cfc1cf"
};

const LOCKARG1 = "0x3d35d87fac0008ba5b12ee1c599b102fc8f5fdf8";
const LOCKARG2 = "0x99dbe610c43186696e1f88cb7b59252d4c92afda";
const LOCKARG3 = "0xc055df68fdd47c6a5965b9ab21cd6825d8696a76";

const FROMINFO = {
  R: 2,
  M: 2,
  publicKeyHashes: [LOCKARG1, LOCKARG2, LOCKARG3],
};

const PRIVKEY1 =
  "0x2c56a92a03d767542222432e4f2a0584f01e516311f705041d86b1af7573751f";
const PRIVKEY2 =
  "0x3bc65932a75f76c5b6a04660e4d0b85c2d9b5114efa78e6e5cf7ad0588ca09c8";

function nonNullable<X>(x: X): NonNullable<X> {
  if (x == null) throw new Error('Null check failed');
  return x as NonNullable<X>;
}

async function generateConfig() {
  let config = {
    "PREFIX": "ckt",
    "SCRIPTS": {
      "SECP256K1_BLAKE160": {
        "CODE_HASH": "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
        "HASH_TYPE": "type",
        "TX_HASH": "",
        "INDEX": "0x0",
        "DEP_TYPE": "dep_group",
        "SHORT_ID": 0
      },
      "SECP256K1_BLAKE160_MULTISIG": {
        "CODE_HASH": "0x5c5069eb0857efc65e1bca0c07df34c31663b3622fd3876c876320fc9634e2a8",
        "HASH_TYPE": "type",
        "TX_HASH": "",
        "INDEX": "0x1",
        "DEP_TYPE": "dep_group",
        "SHORT_ID": 1
      }
    }
  }

  const genesisBlock = await rpc.get_block_by_number('0x0');
  if (!genesisBlock) throw new Error('cannot load genesis block');
  const txHash = nonNullable(genesisBlock.transactions[1]).hash;

  config.SCRIPTS.SECP256K1_BLAKE160.TX_HASH = txHash!;
  config.SCRIPTS.SECP256K1_BLAKE160_MULTISIG.TX_HASH = txHash!;

  fs.promises.mkdir(dirname("config.json"), {recursive: true}).then(x => fs.promises.writeFile("config.json", JSON.stringify(config)))
  
}

let opt;

before(async () => {
  const lockScript = parseAddress(ALICE.ADDRESS, { config: AGGRON4 });

  opt = {
    cellProvider: indexer,
    fromInfo: ALICE.ADDRESS,
    scriptBinary: sudtBin,
    config: AGGRON4
  }
})

async function signAndSendTransaction(
  txSkeleton: TransactionSkeletonType,
  privatekey: string,
  rpc: RPC
): Promise<string> {
  txSkeleton = common.prepareSigningEntries(txSkeleton);
  console.log("signingEntries: ", txSkeleton.get("signingEntries").get(0))
  const message = txSkeleton.get("signingEntries").get(0)?.message;
  const Sig = key.signRecoverable(message!, privatekey);
  const tx = sealTransaction(txSkeleton, [Sig]);
  const hash = await rpc.send_transaction(tx, "passthrough");
  console.log("The transaction hash is", hash);
  return hash;
}

async function signAndSendMultisigTransaction(
  txSkeleton: TransactionSkeletonType,
  privatekeys: string[],
  rpc: RPC
): Promise<string> {
  txSkeleton = common.prepareSigningEntries(txSkeleton);
  console.log("signingEntries: ", txSkeleton.get("signingEntries").get(0))
  const message = txSkeleton.get("signingEntries").get(0)?.message;

  let Sigs: string = "";
  privatekeys.forEach((privKey) => {
    if (privKey !== "") {
      let sig = key.signRecoverable(message!, privKey);
      sig = sig.slice(2);
      Sigs += sig;
    }
  });
  Sigs =
    "0x00020203" +
    LOCKARG1.slice(2) +
    LOCKARG2.slice(2) +
    LOCKARG3.slice(2) +
    Sigs;

  const tx = sealTransaction(txSkeleton, [Sigs]);
  const hash = await rpc.send_transaction(tx, "passthrough");
  console.log("The transaction hash is", hash);
  return hash;
}

// async function payFeeConst(txSkeleton: TransactionSkeletonType): Promise<TransactionSkeletonType> {
//   const feeRate = BigInt(1000);
//   let size: number = 0;
//   let newTxSkeleton: TransactionSkeletonType = txSkeleton;

//   /**
//    * Only one case `currentTransactionSize < size` :
//    * change output capacity equals current fee (feeA), so one output reduced,
//    * and if reduce the fee, change output will add again, fee will increase to feeA.
//    */
//   let currentTransactionSize: number = getTransactionSize(newTxSkeleton);
//   while (currentTransactionSize > size) {
//     size = currentTransactionSize;
//     const fee: bigint = calculateFee(size, feeRate);

//     newTxSkeleton = await payFee(txSkeleton, ALICE.ADDRESS, fee, {
//       config: AGGRON4,
//     });
//     currentTransactionSize = getTransactionSize(newTxSkeleton);
//   }

//   return newTxSkeleton;
// }

function asyncSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTransactionCommitted(
  txHash: string,
  provider: Provider,
  options: { pollIntervalMs?: number; timeoutMs?: number } = {},
) {
  const { pollIntervalMs = 1000, timeoutMs = 120000 } = options;
  const start = Date.now();

  while (Date.now() - start <= timeoutMs) {
    const tx = await rpc.get_transaction(txHash);
    if (tx?.tx_status?.status === 'committed') {
      console.log("committed")
      break;
    }
    console.log("polling: ", tx?.tx_status?.status)
    await asyncSleep(pollIntervalMs);
  }

  const rpcTip = Number(await rpc.get_tip_block_number());

  while (Date.now() - start <= timeoutMs) {
    const providerTip = await provider.get_tip();
    if (Number(providerTip.block_number) >= rpcTip) return;

    await asyncSleep(pollIntervalMs);
  }

  return;
}

// it('DeployWithData', async function() {
//   let txSkeleton = await generateDeployWithDataTx(opt);
//   // txSkeleton = await payFeeConst(txSkeleton)
//   // const scriptConfig = getScriptConfig(txSkeleton, 0);
//   // console.log("scriptconfig: ", scriptConfig);
//   const txHash = await signAndSendTransaction(txSkeleton, ALICE.PRIVATE_KEY, rpc);
//   const outPoint = {
//     tx_hash: txHash,
//     index: "0x0"
//   }
//   const compareResult = await compareScriptBinaryWithOnChainData(sudtBin, outPoint, rpc);
//   expect(compareResult).equal(true);
// });

it('DeployWithData by multisig', async function() {
  const multiLockScript: Script = {
    code_hash: "0x5c5069eb0857efc65e1bca0c07df34c31663b3622fd3876c876320fc9634e2a8",
    hash_type: "type",
    args: "0xed20af7322823d0dc33bfb215486a05082669905",
  }
  const deployOptions: DeployOptions = {
    cellProvider: indexer as CellProvider,
    scriptBinary: sudtBin,
    fromInfo: FROMINFO,
    config: AGGRON4,
  };
  const privKeys = [PRIVKEY1, PRIVKEY2];

  let txSkeleton = await generateDeployWithDataTx(deployOptions);
  const txFee = calculateTxFee(txSkeleton);
  console.log(txFee);
  const txHash = await signAndSendMultisigTransaction(txSkeleton, privKeys, rpc);
  const outPoint = {
    tx_hash: txHash,
    index: "0x0"
  }
  const compareResult = await compareScriptBinaryWithOnChainData(sudtBin, outPoint, rpc);
  expect(compareResult).equal(true);
});



// it('DeployWithTypeId', async function() {
//   // let [typeid, txSkeleton] = await generateDeployWithTypeIdTx(opt);
//   // const txHash = await signAndSendTransaction(txSkeleton, ALICE.PRIVATE_KEY, rpc);
//   // const outPoint = {
//   //   tx_hash: txHash,
//   //   index: "0x0"
//   // }
//   // const compareResult = await compareScriptBinaryWithOnChainData(sudtBin, outPoint, rpc);
//   // expect(compareResult).equal(true);

//   // const tx = await rpc.get_transaction(txHash);
//   const optUpgrade = {
//     cellProvider: indexer,
//     fromLock: opt.fromLock,
//     scriptBinary: Uint8Array.of(1, 2, 3),
//     config: AGGRON4,
//     typeId: {
//       code_hash: '0x00000000000000000000000000000000000000000000000000545950455f4944',
//       hash_type: "type" as const,
//       args: '0x2c82a38950de3204a4ae166c50331d1b104e97a21402cb5bdb7ca23bb9c15f0f'
//     }
//   }

//   // // await waitForTransactionCommitted(txHash, optUpgrade.cellProvider);

//   let upgradeTxSkeleton = await generateUpgradeTypeIdDataTx(optUpgrade);
//   // upgradeTxSkeleton = common.prepareSigningEntries(upgradeTxSkeleton);
//   // console.log("signingEntries: ", upgradeTxSkeleton.get("signingEntries").get(0))
//   // expect(upgradeTxSkeleton.get("signingEntries")!.get(0)!.message!).equal("0xe7582f02e85d259a523aa75348c7c275d8a389412cf5c09c6d511b20304eac7e");
//   const upgradeTxHash = await signAndSendTransaction(upgradeTxSkeleton, ALICE.PRIVATE_KEY, rpc);
//   const upgradeOutPoint = {
//     tx_hash: upgradeTxHash,
//     index: "0x0"
//   }
//   const upgradeCompareResult = await compareScriptBinaryWithOnChainData(sudtBin, upgradeOutPoint, rpc);
//   expect(upgradeCompareResult).equal(true);
// }); 
