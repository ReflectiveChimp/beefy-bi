import { logger } from "../utils/logger";
import {
  db_query,
  insertVaultTokenRateBatch,
  prepareInsertVaultRateBatch,
} from "../utils/db";
import { getContract } from "../utils/ethers";
import BeefyVaultV6Abi from "../../data/interfaces/beefy/BeefyVaultV6/BeefyVaultV6.json";
import * as lodash from "lodash";

async function main() {
  const chain = "fantom";
  //const contractAddress = "0x95EA2284111960c748edF4795cb3530e5E423b8c";
  const contractAddress = "0x41D44B276904561Ac51855159516FD4cB2c90968";

  await prepareInsertVaultRateBatch(chain, contractAddress);

  // first, get all block numbers for which we need vault rates
  const blockRows = await db_query<{ block_number: number; time: Date }>(
    `
    select distinct block_number, time
    from erc20_transfer
    where chain = %L and contract_address = %L and time is not null
    and block_number not in (
      select block_number
      from vault_token_to_underlying_rate
      where chain = %L and contract_address = %L
    )
    order by block_number asc
  `,
    [chain, contractAddress, chain, contractAddress]
  );
  const contract = getContract(chain, BeefyVaultV6Abi, contractAddress);

  logger.info(`Processing ${blockRows.length} blocks`);

  const blockRowBatches = lodash.chunk(blockRows, 100);
  for (const [idx, blockRowBatch] of blockRowBatches.entries()) {
    logger.verbose(
      `Processing ${blockRowBatch.length} blocks (${idx}/${blockRowBatches.length})`
    );
    const data: { ppfs: string; block_number: number; time: Date }[] = [];
    for (const blockRow of blockRowBatch) {
      try {
        const ppfs = await contract.functions.getPricePerFullShare({
          // a block tag to simulate the execution at, which can be used for hypothetical historic analysis;
          //note that many backends do not support this, or may require paid plans to access as the node
          // database storage and processing requirements are much higher
          blockTag: blockRow.block_number,
        });
        data.push({
          ppfs: ppfs.toString(),
          block_number: blockRow.block_number,
          time: blockRow.time,
        });
      } catch (e) {
        logger.error(e);
      }
    }
    await insertVaultTokenRateBatch(
      data.map((d) => ({
        block_number: d.block_number,
        chain: chain,
        contract_address: contractAddress,
        rate: d.ppfs,
        time: d.time.toISOString(),
      }))
    );
  }
}

main()
  .then(() => {
    logger.info("Done");
    process.exit(0);
  })
  .catch((e) => {
    console.log(e);
    logger.error(e);
    process.exit(1);
  });
