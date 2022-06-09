import { Chain } from "../types/chain";
import {
  getFirstTransactionInfos,
  getLastTransactionInfos,
} from "./contract-transaction-infos";
import { getBlockDate, getContract } from "../utils/ethers";
import { logger } from "../utils/logger";
import * as lodash from "lodash";
import ERC20Abi from "../../data/interfaces/standard/ERC20.json";
import BeefyVaultV6Abi from "../../data/interfaces/beefy/BeefyVaultV6/BeefyVaultV6.json";
import { BaseContract, ethers } from "ethers";

async function* streamContractEvents<TEventArgs>(
  chain: Chain,
  contractAddress: string,
  abi: ethers.ContractInterface,
  eventName: string,
  options?: {
    startBlock?: number;
    endBlock?: number;
    blockBatchSize?: number;
    mapArgs?: (args: ethers.utils.Result) => TEventArgs;
    getEventFilters?: (
      filters: ethers.BaseContract["filters"]
    ) => ethers.EventFilter;
    timeOrder?: "timeline" | "reverse";
  }
) {
  const { blockNumber: createBlock } = await getFirstTransactionInfos(
    chain,
    contractAddress
  );
  const { blockNumber: lastBlock } = await getLastTransactionInfos(
    chain,
    contractAddress
  );

  const startBlock = options?.startBlock || createBlock;
  const endBlock = options?.endBlock || lastBlock;

  // we will need to call the contract to get the ppfs at some point
  const contract = getContract(chain, abi, contractAddress);
  const mapArgs = options?.mapArgs || ((x) => x as any as TEventArgs);

  // iterate through block ranges
  const rangeSize = options?.blockBatchSize || 3000; // big to speed up, not to big to avoid rpc limitations
  const flat_range = lodash.range(startBlock, endBlock + 1, rangeSize);
  let ranges: { fromBlock: number; toBlock: number }[] = [];
  for (let i = 0; i < flat_range.length - 1; i++) {
    ranges.push({
      fromBlock: flat_range[i],
      toBlock: flat_range[i + 1] - 1,
    });
  }
  if (options?.timeOrder === "reverse") {
    ranges = ranges.reverse();
  }
  logger.verbose(
    `[EVENT_STREAM] Iterating through ${ranges.length} ranges for ${chain}:${contractAddress}:${eventName}`
  );
  const eventFilter = options?.getEventFilters
    ? options?.getEventFilters(contract.filters)
    : contract.filters[eventName]();
  for (const [rangeIdx, blockRange] of ranges.entries()) {
    const events = await contract.queryFilter(
      eventFilter,
      blockRange.fromBlock,
      blockRange.toBlock
    );

    const blockFrom = await getBlockDate(chain, blockRange.fromBlock);
    const blockTo = await getBlockDate(chain, blockRange.toBlock);
    if (events.length > 0) {
      logger.verbose(
        `[EVENT_STREAM] Got ${events.length} events for range ${rangeIdx}/${
          ranges.length
        } (${blockFrom.datetime.toISOString()} -> ${blockTo.datetime.toISOString()})`
      );
    } else {
      logger.debug(
        `[EVENT_STREAM] Got ${events.length} events for range ${rangeIdx}/${
          ranges.length
        } (${blockFrom.datetime.toISOString()} -> ${blockTo.datetime.toISOString()})`
      );
    }

    let blockNum = 0;
    let blockDate = new Date();
    for (const rawEvent of events) {
      if (!rawEvent.args) {
        throw new Error(`No event args in event ${rawEvent}`);
      }
      if (blockNum !== rawEvent.blockNumber) {
        blockNum = rawEvent.blockNumber;
        const block = await rawEvent.getBlock();
        blockDate = new Date(block.timestamp * 1000);
      }
      const mappedEvent = {
        blockNumber: rawEvent.blockNumber,
        datetime: blockDate,
        data: mapArgs(rawEvent.args),
      };
      yield mappedEvent;
    }
  }
}

export const streamERC20TransferEvents = (
  chain: Chain,
  contractAddress: string,
  options?: {
    from?: string;
    to?: string;
  }
) => {
  logger.debug(
    `[EVENT_STREAM] Streaming ERC20 transfer events for ${chain}:${contractAddress} ${JSON.stringify(
      options
    )}`
  );
  return streamContractEvents<{ from: string; to: string; value: string }>(
    chain,
    contractAddress,
    ERC20Abi,
    "Transfer",
    {
      getEventFilters: (filters) => {
        if (options?.from && options?.to) {
          return filters.Transfer(options.from, options.to);
        } else if (options?.from) {
          return filters.Transfer(options.from, null);
        } else if (options?.to) {
          return filters.Transfer(null, options.to);
        } else {
          return filters.Transfer();
        }
      },
      mapArgs: (args) => ({
        from: args.from,
        to: args.to,
        value: args.value,
      }),
    }
  );
};

export async function* streamBifiVaultUpgradeStratEvents(
  chain: Chain,
  contractAddress: string
) {
  // add a fake event for the contract creation
  const { blockNumber: deployBlockNumber, datetime: deployBlockDatetime } =
    await getFirstTransactionInfos(chain, contractAddress);
  const contract = getContract(chain, BeefyVaultV6Abi, contractAddress);
  const firstStrategyRes = await contract.functions.strategy({
    blockTag: deployBlockNumber,
  });
  yield {
    blockNumber: deployBlockNumber,
    datetime: deployBlockDatetime,
    data: { implementation: firstStrategyRes[0] as string },
  };
  // add a shortcut if the strategy never changed
  const currentStrategyRes = await contract.functions.strategy();
  if (firstStrategyRes[0] === currentStrategyRes[0]) {
    logger.verbose(
      `[EVENT_STREAM] Shortcut: no strategy change events for ${chain}:${contractAddress}`
    );
    return;
  }

  const eventStream = streamContractEvents<{ implementation: string }>(
    chain,
    contractAddress,
    BeefyVaultV6Abi,
    "UpgradeStrat",
    {
      mapArgs: (args) => ({
        implementation: args.implementation,
      }),
    }
  );
  for await (const event of eventStream) {
    yield event;
  }
}
