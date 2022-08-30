import { Chain } from "../types/chain";
import * as ethers from "ethers";
import { cacheAsyncResultInRedis } from "./cache";
import { callLockProtectedRpc } from "../lib/shared-resources/shared-rpc";
import axios from "axios";
import { isNumber } from "lodash";
import { rootLogger } from "./logger2";

const logger = rootLogger.child({ module: "utils", component: "ethers" });

export interface BlockDateInfos {
  blockNumber: number;
  datetime: Date;
}

export async function fetchBlockData(
  chain: Chain,
  blockNumber: ethers.ethers.providers.BlockTag
): Promise<BlockDateInfos> {
  logger.debug({ msg: "Fetching block", data: { chain, blockNumber } });

  return callLockProtectedRpc(chain, async (provider) => {
    // for some reason ethers don't understand celo's response
    if (chain === "celo") {
      // documentation: https://www.quicknode.com/docs/ethereum/eth_getBlockByNumber
      let blockParam = isNumber(blockNumber) ? ethers.utils.hexlify(blockNumber) : blockNumber;
      // FIXES: invalid argument 0: hex number with leading zero digits
      if (blockParam.startsWith("0x0")) {
        blockParam = blockParam.replace(/^0x0+/, "0x");
        blockParam = blockParam === "0x" ? "0x0" : blockParam;
      }
      const res = await axios.post<{
        result: { timestamp: string; number: string };
      }>(provider.connection.url, {
        method: "eth_getBlockByNumber",
        params: [blockParam, false],
        id: 1,
        jsonrpc: "2.0",
      });
      const blockRes = res.data.result;
      if (!blockRes || blockRes?.number === undefined) {
        throw new Error(`Invalid block result for celo ${chain}:${blockNumber} ${JSON.stringify(res.data)}`);
      }
      const blocknum = ethers.BigNumber.from(blockRes.number).toNumber();

      const datetime = new Date(ethers.BigNumber.from(blockRes.timestamp).toNumber() * 1000);
      return {
        blockNumber: blocknum,
        datetime,
      };
    } else {
      const block = await provider.getBlock(blockNumber);

      return {
        blockNumber: block.number,
        datetime: new Date(block.timestamp * 1000),
      };
    }
  });
}

export const getRedisCachedBlockDate = cacheAsyncResultInRedis(fetchBlockData, {
  getKey: (chain, blockNumber) => `${chain}:${blockNumber}`,
  dateFields: ["datetime"],
});

export function normalizeAddress(address: string) {
  // special case to avoid ethers.js throwing an error
  // Error: invalid address (argument="address", value=Uint8Array(0x0000000000000000000000000000000000000000), code=INVALID_ARGUMENT, version=address/5.6.1)
  if (address === "0x0000000000000000000000000000000000000000") {
    return address;
  }
  return ethers.utils.getAddress(address);
}
