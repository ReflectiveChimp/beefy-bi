import { allChainIds, Chain } from "../types/chain";
import { logger } from "../utils/logger";
import yargs from "yargs";
import { normalizeAddress } from "../utils/ethers";
import {
  allSamplingPeriods,
  SamplingPeriod,
  samplingPeriodMs,
  streamBlockSamplesFrom,
} from "../lib/csv-block-samples";
import { sleep } from "../utils/async";
import {
  fetchBeefyVaultAddresses,
  fetchContractCreationInfos,
} from "../lib/fetch-if-not-found-locally";
import {
  BeefyVaultV6PPFSData,
  fetchBeefyPPFS,
  getBeefyVaultV6PPFSWriteStream,
  getLastImportedBeefyVaultV6PPFSData,
} from "../lib/csv-vault-ppfs";
import { batchAsyncStream } from "../utils/batch";
import { ArchiveNodeNeededError } from "../lib/shared-resources/shared-rpc";
import { shuffle } from "lodash";
import { runMain } from "../utils/process";

async function main() {
  const argv = await yargs(process.argv.slice(2))
    .usage("Usage: $0 [options]")
    .options({
      chain: { choices: allChainIds, alias: "c", demand: true },
      period: { choices: allSamplingPeriods, alias: "p", default: "4hour" },
      vaultId: { alias: "v", demand: false, string: true },
    }).argv;

  const chain = argv.chain as Chain;
  const samplingPeriod = argv.period as SamplingPeriod;
  const vaultId = argv.vaultId;

  logger.info(`[PPFS] Importing ${chain} ppfs with period ${samplingPeriod}.`);
  // find out which vaults we need to parse
  const vaults = shuffle(await fetchBeefyVaultAddresses(chain));
  for (const vault of vaults) {
    if (vaultId && vault.id !== vaultId) {
      logger.debug(`[PPFS] Skipping vault ${vault.id}`);
      continue;
    }

    logger.info(`[PPFS] Importing ppfs for ${chain}:${vault.id}`);

    const contractAddress = normalizeAddress(vault.token_address);

    // find out the vault creation block or last imported ppfs
    let lastImportedBlock =
      (
        await getLastImportedBeefyVaultV6PPFSData(
          chain,
          contractAddress,
          samplingPeriod
        )
      )?.blockNumber || null;
    if (lastImportedBlock === null) {
      // get creation block of the contract
      const { blockNumber } = await fetchContractCreationInfos(
        chain,
        contractAddress
      );
      // we skip the creation block
      lastImportedBlock = blockNumber;
    }
    logger.debug(
      `[PPFS] importing from block ${lastImportedBlock} for ${chain}:${vault.id}`
    );
    const blockSampleStream = streamBlockSamplesFrom(
      chain,
      samplingPeriod,
      lastImportedBlock
    );

    const { writeBatch } = await getBeefyVaultV6PPFSWriteStream(
      chain,
      contractAddress,
      samplingPeriod
    );

    try {
      for await (const blockDataBatch of batchAsyncStream(
        blockSampleStream,
        10
      )) {
        logger.verbose(
          `[PPFS] Fetching data of ${chain}:${vault.id} (${contractAddress}) for ${blockDataBatch.length} blocks starting from ${blockDataBatch[0].blockNumber}`
        );
        const vaultData: BeefyVaultV6PPFSData[] = [];
        for (const blockData of blockDataBatch) {
          const ppfs = await fetchBeefyPPFS(
            chain,
            contractAddress,
            blockData.blockNumber
          );

          vaultData.push({
            blockNumber: blockData.blockNumber,
            datetime: blockData.datetime,
            pricePerFullShare: ppfs.toString(),
          });
        }
        writeBatch(vaultData);
      }
    } catch (e) {
      if (e instanceof ArchiveNodeNeededError) {
        logger.error(
          `[PPFS] Archive node needed, skipping vault ${chain}:${vault.id}`
        );
        continue;
      } else {
        logger.error(
          `[PPFS] Error fetching ppfs, skipping vault ${chain}:${vault.id}`
        );
        continue;
      }
    }
  }
  logger.info(
    `[PPFS] Finished importing ppfs for ${chain}. Sleeping for a bit`
  );
  await sleep(samplingPeriodMs[samplingPeriod] * 10);
}

runMain(main);
