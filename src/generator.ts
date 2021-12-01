import { TransactionSkeletonType, TransactionSkeleton, generateAddress, Options, createTransactionFromSkeleton} from "@ckb-lumos/helpers";
import { RPC } from "@ckb-lumos/rpc";
import { Input, Script, OutPoint, CellProvider, Cell, utils, core } from "@ckb-lumos/base";
import { Config, getConfig } from "@ckb-lumos/config-manager";
import { generateTypeID } from "./typeID";
import { bytesToHex, findCellsByLock, completeTx, updateCellDeps, updateOutputs, calculateCodeHashByBin, getDataHash, injectCapacity } from "./utils";
import { normalizers, Reader } from "ckb-js-toolkit";
import { parseFromInfo, FromInfo } from "./from_info";

export function generateTypeIdScript(input: Input /* must be an UTxO */, outputIndex: number): Script {
  const args = generateTypeID(input, outputIndex);
  return {
    code_hash: '0x00000000000000000000000000000000000000000000000000545950455f4944', // Buffer.from('TYPE_ID')
    hash_type: 'type',
    args,
  };
};

export interface DeployOptions {
  cellProvider: CellProvider;
  fromInfo: FromInfo,
  scriptBinary: Uint8Array;
  config?: Config;
}

// the generator will only collect cells that have only lock
export async function generateDeployWithDataTx(options: DeployOptions): Promise<TransactionSkeletonType> {
  let txSkeleton = TransactionSkeleton({ cellProvider: options.cellProvider });

  const { fromScript } = parseFromInfo(options.fromInfo, { config: options.config });

  const output: Cell = {
    cell_output: {
      capacity: '0x0',
      lock: fromScript,
      // type: null,
    },
    data: bytesToHex(options.scriptBinary),
  };

  txSkeleton = updateOutputs(txSkeleton, output);
  txSkeleton = updateCellDeps(txSkeleton, options.config);
  txSkeleton = await completeTx(txSkeleton, options.fromInfo, options.config);

  return txSkeleton;
};

export async function generateDeployWithTypeIdTx(options: DeployOptions): Promise<[Script /* type_id script */, TransactionSkeletonType]> {
  let txSkeleton = TransactionSkeleton({ cellProvider: options.cellProvider });

  const { fromScript } = parseFromInfo(options.fromInfo, { config: options.config });

  const [resolved] = await findCellsByLock(fromScript, options.cellProvider);
  if (!resolved) throw new Error(`fromAddress has no live ckb`);

  const typeId = generateTypeIdScript({ previous_output: resolved.out_point!, since: '0x0' }, 0);
  console.log("typeid is: ", typeId);
  const output: Cell = {
    cell_output: {
      capacity: '0x0',
      lock: fromScript,
      type: typeId,
    },
    data: bytesToHex(options.scriptBinary),
  };

  txSkeleton = updateOutputs(txSkeleton, output);
  txSkeleton = updateCellDeps(txSkeleton, options.config);
  txSkeleton = await completeTx(txSkeleton, options.fromInfo, options.config);

  return [typeId, txSkeleton];
};

export interface UpgradeOptions extends DeployOptions {
  typeId: Script;
}

export async function generateUpgradeTypeIdDataTx(options: UpgradeOptions): Promise<TransactionSkeletonType> {
  let txSkeleton = TransactionSkeleton({ cellProvider: options.cellProvider });

  const { fromScript } = parseFromInfo(options.fromInfo, { config: options.config });

  const collector = options.cellProvider.collector({ type: options.typeId });
  const cells: Cell[] = [];
  for await (const cell of collector.collect()) {
    console.log(cell);
    cells.push(cell);
  }
  if (cells.length !== 1) throw new Error("the typeid maybe wrong");

  const deployedCell = cells[0];
  txSkeleton = txSkeleton.update('inputs', (inputs) => {
    return inputs.push(deployedCell);
  });

  const output: Cell = {
    cell_output: {
      capacity: '0x0',
      lock: fromScript,
      type: options.typeId,
    },
    data: bytesToHex(options.scriptBinary),
  };

  txSkeleton = updateOutputs(txSkeleton, output);
  txSkeleton = updateCellDeps(txSkeleton, options.config);
  txSkeleton = await completeTx(txSkeleton, options.fromInfo, options.config);

  return txSkeleton;
};

export async function compareScriptBinaryWithOnChainData(scriptBinary: Uint8Array, outPoint: OutPoint, rpc: RPC): Promise<boolean> {
  const localHash = calculateCodeHashByBin(scriptBinary);
  const onChainHash = await getDataHash(outPoint, rpc);
  return localHash === onChainHash;
}

export async function payFee(
  txSkeleton: TransactionSkeletonType,
  fromAddress: string,
  amount: bigint,
  { config = undefined }: Options = {}
): Promise<TransactionSkeletonType> {
  config = config || getConfig();
  return await injectCapacity(txSkeleton, fromAddress, amount, {
    config,
  });
}

function calculateTxHash(txSkeleton: TransactionSkeletonType): string {
  const tx = createTransactionFromSkeleton(txSkeleton);
  const txHash = utils
    .ckbHash(
      core.SerializeRawTransaction(normalizers.NormalizeRawTransaction(tx))
    )
    .serializeJson();
  return txHash;
}

function getScriptConfigByDataHash(
  txSkeleton: TransactionSkeletonType,
  outputIndex: number
): ScriptConfig {
  const data = txSkeleton.outputs.get(outputIndex)!.data;
  const codeHash = utils
    .ckbHash(new Reader(data).toArrayBuffer())
    .serializeJson();
  const txHash = calculateTxHash(txSkeleton);
  const scriptConfig: ScriptConfig = {
    CODE_HASH: codeHash,
    HASH_TYPE: "data",
    TX_HASH: txHash,
    INDEX: "0x0",
    DEP_TYPE: "code",
  };
  return scriptConfig;
}

function getScriptConfigByTypeHash(
  txSkeleton: TransactionSkeletonType,
  outputIndex: number
): ScriptConfig {
  const typeScript = txSkeleton.outputs.get(outputIndex)!.cell_output.type!;
  const codeHash = utils.computeScriptHash(typeScript);
  const txHash = calculateTxHash(txSkeleton);
  const scriptConfig: ScriptConfig = {
    CODE_HASH: codeHash,
    HASH_TYPE: "type",
    TX_HASH: txHash,
    INDEX: "0x0",
    DEP_TYPE: "code",
  };
  return scriptConfig;
}

export function getScriptConfig(
  txSkeleton: TransactionSkeletonType,
  outputIndex: number
): ScriptConfig {
  const outputCell = txSkeleton.outputs.get(outputIndex);
  if (outputCell == undefined)
    throw new Error("Invalid txSkeleton or outputIndex");
  const type = outputCell.cell_output.type;
  if (type !== undefined)
    return getScriptConfigByTypeHash(txSkeleton, outputIndex);
  return getScriptConfigByDataHash(txSkeleton, outputIndex);
}

interface ScriptConfig {
  // if hash_type is type, code_hash is ckbHash(type_script)
  // if hash_type is data, code_hash is ckbHash(data)
  CODE_HASH: string;

  HASH_TYPE: "type" | "data";

  TX_HASH: string;
  // the deploy cell can be found at index of tx's outputs
  INDEX: string;

  // now deployWithX only supportted `code `
  DEP_TYPE: "dep_group" | "code";

  // empty
  SHORT_ID?: number;
}
