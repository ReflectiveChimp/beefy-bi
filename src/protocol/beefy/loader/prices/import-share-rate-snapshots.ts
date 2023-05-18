import { groupBy, min } from "lodash";
import * as Rx from "rxjs";
import { Chain } from "../../../../types/chain";
import { samplingPeriodMs } from "../../../../types/sampling";
import { MS_PER_BLOCK_ESTIMATE } from "../../../../utils/config";
import { mergeLogsInfos, rootLogger } from "../../../../utils/logger";
import { ProgrammerError } from "../../../../utils/programmer-error";
import { Range, isValidRange, rangeExcludeMany, rangeMerge } from "../../../../utils/range";
import { excludeNullFields$ } from "../../../../utils/rxjs/utils/exclude-null-field";
import { fetchContractCreationInfos$ } from "../../../common/connector/contract-creation";
import { ERC20Transfer } from "../../../common/connector/erc20-transfers";
import { addRegularIntervalBlockRangesQueries } from "../../../common/connector/import-queries";
import { latestBlockNumber$ } from "../../../common/connector/latest-block-number";
import { upsertBlock$ } from "../../../common/loader/blocks";
import { fetchChainBlockList$ } from "../../../common/loader/chain-block-list";
import { fetchPriceFeedContractCreationInfos } from "../../../common/loader/fetch-product-creation-infos";
import { createShouldIgnoreFn } from "../../../common/loader/ignore-address";
import { DbProductShareRateImportState, DbProductShareRateImportState, addMissingImportState$ } from "../../../common/loader/import-state";
import { upsertInvestment$ } from "../../../common/loader/investment";
import { upsertInvestor$ } from "../../../common/loader/investor";
import { DbPriceFeed } from "../../../common/loader/price-feed";
import { upsertPrice$ } from "../../../common/loader/prices";
import { DbBeefyProduct } from "../../../common/loader/product";
import { ErrorEmitter, ImportCtx } from "../../../common/types/import-context";
import { ImportRangeResult } from "../../../common/types/import-query";
import { isProductDashboardEOL } from "../../../common/utils/eol";
import { executeSubPipeline$ } from "../../../common/utils/execute-sub-pipeline";
import { createImportStateUpdaterRunner } from "../../../common/utils/import-state-updater-runner";
import { extractObjsAndRangeFromOptimizerOutput, optimizeRangeQueries } from "../../../common/utils/optimize-range-queries";
import { ChainRunnerConfig } from "../../../common/utils/rpc-chain-runner";
import { extractProductTransfersFromOutputAndTransfers, fetchProductEvents$ } from "../../connector/product-events";
import { fetchBeefyTransferData$ } from "../../connector/transfer-data";
import { getProductContractAddress } from "../../utils/contract-accessors";
import { getInvestmentsImportStateKey, getPriceFeedImportStateKey } from "../../utils/import-state";
import { isBeefyBoost, isBeefyGovVault, isBeefyStandardVault } from "../../utils/type-guard";
import { upsertInvestorCacheChainInfos$ } from "./investor-cache";

const logger = rootLogger.child({ module: "beefy", component: "investment-import" });

export function createBeefyShareRateSnapshotsRunner(options: { chain: Chain; runnerConfig: ChainRunnerConfig<DbPriceFeed> }) {
  return createImportStateUpdaterRunner<DbPriceFeed, number>({
    cacheKey: "beefy:product:share-rate:" + options.runnerConfig.behaviour.mode,
    logInfos: { msg: "Importing historical beefy investments", data: { chain: options.chain } },
    runnerConfig: options.runnerConfig,
    getImportStateKey: getPriceFeedImportStateKey,
    pipeline$: (ctx, emitError, getLastImportedBlockNumber) => {
      const shouldIgnoreFnPromise = createShouldIgnoreFn({ client: ctx.client, chain: ctx.chain });

      const createImportStateIfNeeded$: Rx.OperatorFunction<
        DbPriceFeed,
        { priceFeed: DbPriceFeed; importState: DbProductShareRateImportState | null }
      > =
        ctx.behaviour.mode === "recent"
          ? Rx.pipe(Rx.map((priceFeed) => ({ priceFeed, importState: null })))
          : addMissingImportState$<
              DbPriceFeed,
              { priceFeed: DbPriceFeed; importState: DbProductShareRateImportState },
              DbProductShareRateImportState
            >({
              ctx,
              getImportStateKey: getPriceFeedImportStateKey,
              formatOutput: (priceFeed, importState) => ({ priceFeed, importState }),
              createDefaultImportState$: Rx.pipe(
                fetchPriceFeedContractCreationInfos({
                  ctx,
                  emitError: (item, report) => {
                    logger.error(mergeLogsInfos({ msg: "Error while fetching price feed contract creation infos. ", data: item }, report.infos));
                    logger.error(report.error);
                    throw new Error("Error while fetching price feed creation infos. " + item.priceFeedId);
                  },
                  importStateType: "product:investment", // we want to find the contract creation date we already fetched from the investment pipeline
                  which: "price-feed-1", // we work on the first applied price
                  productType: "beefy:vault",
                  getPriceFeedId: (item) => item.priceFeedId,
                  formatOutput: (item, contractCreationInfo) => ({ ...item, contractCreationInfo }),
                }),

                // drop those without a creation info
                excludeNullFields$("contractCreationInfo"),

                Rx.map((item) => ({
                  obj: item,
                  importData: {
                    type: "product:share-rate",
                    priceFeedId: item.priceFeedId,
                    chain: item.contractCreationInfo.chain,
                    productId: item.contractCreationInfo.productId,
                    chainLatestBlockNumber: 0,
                    contractCreatedAtBlock: item.contractCreationInfo.contractCreatedAtBlock,
                    contractCreationDate: item.contractCreationInfo.contractCreationDate,
                    ranges: {
                      lastImportDate: new Date(),
                      coveredRanges: [],
                      toRetry: [],
                    },
                  },
                })),
              ),
            });

      return Rx.pipe(
        // create the import state if it does not exists
        createImportStateIfNeeded$,

        excludeNullFields$("importState"),

        // generate our queries
        Rx.pipe(
          // like Rx.toArray() but non blocking if import state creation takes too much time
          Rx.bufferTime(ctx.streamConfig.maxInputWaitMs),
          Rx.filter((objs) => objs.length > 0),

          // go get the latest block number for this chain
          latestBlockNumber$({
            ctx: ctx,
            emitError: (items, report) => {
              logger.error(mergeLogsInfos({ msg: "Failed to get latest block number block", data: { items } }, report.infos));
              logger.error(report.error);
              throw new Error("Failed to get latest block number block");
            },
            formatOutput: (items, latestBlockNumber) => ({ items, latestBlockNumber }),
          }),

          Rx.pipe(
            // find out an interpolation of block numbers at 15min intervals
            fetchChainBlockList$({
              ctx: ctx,
              emitError: (item, report) => {
                logger.error(mergeLogsInfos({ msg: "Error while fetching the chain block list", data: item }, report.infos));
                logger.error(report.error);
                throw new Error("Error while adding covering block ranges");
              },
              getChain: () => options.chain,
              timeStep: "15min",
              getFirstDate: (item) => min(item.items.map((i) => i.importState.importData.contractCreationDate)) as Date,
              formatOutput: (obj, blockList) => ({ obj, blockList }),
            }),

            // transform to ranges
            Rx.map((item) => {
              const blockRanges: Range<number>[] = [];
              const blockList = sortBy(item.blockList, (block) => block.interpolated_block_number);
              for (let i = 0; i < blockList.length - 1; i++) {
                const block = blockList[i];
                const nextBlock = item.blockList[i + 1];
                blockRanges.push({ from: block.interpolated_block_number, to: nextBlock.interpolated_block_number - 1 });
              }
              return { ...item, blockRanges };
            }),
          ),

          addRegularIntervalBlockRangesQueries({
            ctx,
            emitError: (item, report) => {
              logger.error(mergeLogsInfos({ msg: "Error while adding covering block ranges", data: item }, report.infos));
              logger.error(report.error);
              throw new Error("Error while adding covering block ranges");
            },
            chain: options.chain,
            timeStep: "15min",
            getImportState: (item) => item.importState,
            formatOutput: (item, latestBlockNumber, blockRanges) => blockRanges.map((range) => ({ ...item, range, latest: latestBlockNumber })),
          }),

          Rx.map(({ items, latestBlockNumber }) =>
            optimizeRangeQueries({
              objKey: (item) => item.priceFeed.feedKey,
              states: items
                .map(({ priceFeed, importState }) => {
                  // compute recent full range in case we need it
                  // fetch the last hour of data
                  const maxBlocksPerQuery = ctx.rpcConfig.rpcLimitations.maxGetLogsBlockSpan;
                  const period = samplingPeriodMs["1hour"];
                  const periodInBlockCountEstimate = Math.floor(period / MS_PER_BLOCK_ESTIMATE[ctx.chain]);

                  const lastImportedBlockNumber = getLastImportedBlockNumber();
                  const diffBetweenLastImported = lastImportedBlockNumber ? latestBlockNumber - (lastImportedBlockNumber + 1) : Infinity;

                  const blockCountToFetch = Math.min(maxBlocksPerQuery, periodInBlockCountEstimate, diffBetweenLastImported);
                  const fromBlock = latestBlockNumber - blockCountToFetch;
                  const toBlock = latestBlockNumber;

                  const recentFullRange = {
                    from: fromBlock - ctx.behaviour.waitForBlockPropagation,
                    to: toBlock - ctx.behaviour.waitForBlockPropagation,
                  };

                  let fullRange: Range<number>;

                  if (ctx.behaviour.mode !== "recent" && importState !== null) {
                    // exclude latest block query from the range
                    const isLive = !isProductDashboardEOL(product);
                    const skipRecent = ctx.behaviour.skipRecentWindowWhenHistorical;
                    let doSkip = false;
                    if (skipRecent === "all") {
                      doSkip = true;
                    } else if (skipRecent === "none") {
                      doSkip = false;
                    } else if (skipRecent === "live") {
                      doSkip = isLive;
                    } else if (skipRecent === "eol") {
                      doSkip = !isLive;
                    } else {
                      throw new ProgrammerError({ msg: "Invalid skipRecentWindowWhenHistorical value", data: { skipRecent } });
                    }
                    // this is the whole range we have to cover
                    fullRange = {
                      from: importState.importData.contractCreatedAtBlock,
                      to: Math.min(latestBlockNumber - ctx.behaviour.waitForBlockPropagation, doSkip ? recentFullRange.to : Infinity),
                    };
                  } else {
                    fullRange = recentFullRange;
                  }

                  // this can happen when we force the block number in the past and we are treating a recent product
                  if (fullRange.from > fullRange.to) {
                    const importStateKey = importState?.importKey || getInvestmentsImportStateKey(product);
                    if (ctx.behaviour.forceConsideredBlockRange !== null) {
                      logger.info({
                        msg: "current block number set too far in the past to treat this product",
                        data: { fullRange, importStateKey },
                      });
                    } else {
                      logger.error({
                        msg: "Full range is invalid",
                        data: { fullRange, importStateKey },
                      });
                      if (process.env.NODE_ENV === "development") {
                        throw new ProgrammerError("Full range is invalid");
                      }
                    }
                  }

                  const coveredRanges = ctx.behaviour.ignoreImportState ? [] : importState?.importData.ranges.coveredRanges || [];
                  let toRetry =
                    !ctx.behaviour.ignoreImportState && ctx.behaviour.mode === "historical" && importState !== null
                      ? importState.importData.ranges.toRetry
                      : [];

                  // apply our range restriction everywhere
                  if (ctx.behaviour.forceConsideredBlockRange !== null) {
                    const restrict = ctx.behaviour.forceConsideredBlockRange;
                    fullRange = {
                      from: Math.max(fullRange.from, restrict.from),
                      to: Math.min(fullRange.to, restrict.to),
                    };
                    toRetry = rangeMerge(
                      toRetry
                        .map((range) => ({
                          from: Math.max(range.from, restrict.from),
                          to: Math.min(range.to, restrict.to),
                        }))
                        .filter((r) => isValidRange(r)),
                    );
                  }

                  return { obj: { priceFeed, latestBlockNumber }, fullRange, coveredRanges, toRetry };
                })
                // this can happen if we restrict a very recent product with forceConsideredBlockRange
                .filter((state) => isValidRange(state.fullRange)),
              options: {
                ignoreImportState: ctx.behaviour.ignoreImportState,
                maxAddressesPerQuery: ctx.rpcConfig.rpcLimitations.maxGetLogsAddressBatchSize || 1,
                maxQueriesPerProduct: ctx.behaviour.limitQueriesCountTo.investment,
                maxRangeSize: ctx.rpcConfig.rpcLimitations.maxGetLogsBlockSpan,
              },
            }),
          ),
          Rx.concatAll(),
        ),

        // detect interesting events in this ranges
        Rx.pipe(
          fetchProductEvents$({
            ctx,
            emitError: (query, report) =>
              extractObjsAndRangeFromOptimizerOutput({ output: query, objKey: (o) => o.product.productKey }).map(({ obj, range }) =>
                emitError({ target: obj.product, latest: obj.latestBlockNumber, range }, report),
              ),
            getCallParams: (query) => query,
            formatOutput: (query, transfers) => {
              return extractProductTransfersFromOutputAndTransfers(query, (o) => o.product, transfers).flatMap(
                ({ obj: { latestBlockNumber, product }, range, transfers }) => ({ latestBlockNumber, product, range, transfers }),
              );
            },
          }),
          Rx.concatAll(),

          // split the full range into a list of transfers data so we immediately handle ranges where there is no data to fetch
          Rx.map((item) => {
            const transfersByblockNumber = groupBy(item.transfers, (t) => t.blockNumber);
            const rangesWithTransfers = Object.values(transfersByblockNumber).map((transfers) => ({
              ...item,
              transfers,
              range: { from: transfers[0].blockNumber, to: transfers[0].blockNumber },
            }));
            const rangesWithoutEvents = rangeExcludeMany(
              item.range,
              rangesWithTransfers.flatMap((r) => r.range),
            );

            return rangesWithTransfers.concat(rangesWithoutEvents.map((r) => ({ ...item, transfers: [], range: r })));
          }),

          Rx.concatAll(),
        ),

        // then for each query, do the import
        executeSubPipeline$({
          ctx,
          emitError: ({ product, latestBlockNumber, range }, report) => emitError({ target: product, latest: latestBlockNumber, range }, report),
          getObjs: async ({ product, latestBlockNumber, range, transfers }) => {
            const shouldIgnoreFn = await shouldIgnoreFnPromise;
            return transfers
              .map((transfer): TransferToLoad => ({ range, transfer, product, latest: latestBlockNumber }))
              .filter((transfer) => {
                const shouldIgnore = shouldIgnoreFn(transfer.transfer.ownerAddress);
                if (shouldIgnore) {
                  logger.trace({ msg: "ignoring transfer", data: { chain: ctx.chain, transfer } });
                } else {
                  logger.trace({ msg: "not ignoring transfer", data: { chain: ctx.chain, ownerAddress: transfer.transfer.ownerAddress } });
                }
                return !shouldIgnore;
              });
          },
          pipeline: (emitError) => loadTransfers$({ ctx: ctx, emitError }),
          formatOutput: (item, _ /* we don't care about the result */) => item,
        }),

        Rx.map(
          ({ product, latestBlockNumber, range }): ImportRangeResult<DbBeefyProduct, number> => ({
            success: true,
            latest: latestBlockNumber,
            range,
            target: product,
          }),
        ),
      );
    },
  });
}

type TransferToLoad<TProduct extends DbBeefyProduct = DbBeefyProduct> = {
  transfer: ERC20Transfer;
  product: TProduct;
  range: Range<number>;
  latest: number;
};

function loadTransfers$<TObj, TInput extends { parent: TObj; target: TransferToLoad<DbBeefyProduct> }, TErr extends ErrorEmitter<TInput>>(options: {
  ctx: ImportCtx;
  emitError: TErr;
}) {
  return Rx.pipe(
    Rx.tap((item: TInput) => logger.trace({ msg: "loading transfer", data: { chain: options.ctx.chain, transferData: item } })),

    fetchBeefyTransferData$({
      ctx: options.ctx,
      emitError: options.emitError,
      getCallParams: (item) => {
        const balance = {
          decimals: item.target.transfer.tokenDecimals,
          contractAddress: item.target.transfer.tokenAddress,
          ownerAddress: item.target.transfer.ownerAddress,
        };
        const blockNumber = item.target.transfer.blockNumber;
        if (isBeefyStandardVault(item.target.product)) {
          return {
            shareRateParams: {
              vaultAddress: item.target.product.productData.vault.contract_address,
              underlyingDecimals: item.target.product.productData.vault.want_decimals,
              vaultDecimals: item.target.product.productData.vault.token_decimals,
            },
            balance,
            blockNumber,
            fetchShareRate: true,
          };
        } else if (isBeefyBoost(item.target.product)) {
          return {
            shareRateParams: {
              vaultAddress: item.target.product.productData.boost.staked_token_address,
              underlyingDecimals: item.target.product.productData.boost.vault_want_decimals,
              vaultDecimals: item.target.product.productData.boost.staked_token_decimals,
            },
            balance,
            blockNumber,
            fetchShareRate: true,
          };
        } else if (isBeefyGovVault(item.target.product)) {
          return {
            balance,
            blockNumber,
            fetchShareRate: false,
          };
        }
        logger.error({ msg: "Unsupported product type", data: { product: item.target.product } });
        throw new ProgrammerError("Unsupported product type");
      },
      formatOutput: (item, { balance, blockDatetime, shareRate }) => ({ ...item, blockDatetime, balance, shareRate }),
    }),

    // ==============================
    // now we are ready for the insertion
    // ==============================

    // insert the block data
    upsertBlock$({
      ctx: options.ctx,
      emitError: options.emitError,
      getBlockData: (item) => ({
        blockNumber: item.target.transfer.blockNumber,
        chain: options.ctx.chain,
        datetime: item.blockDatetime,
      }),
      formatOutput: (item, investorId) => ({ ...item, investorId }),
    }),

    // insert the investor data
    upsertInvestor$({
      ctx: options.ctx,
      emitError: options.emitError,
      getInvestorData: (item) => ({
        address: item.target.transfer.ownerAddress,
        investorData: {},
      }),
      formatOutput: (item, investorId) => ({ ...item, investorId }),
    }),

    // insert ppfs as a price
    upsertPrice$({
      ctx: options.ctx,
      emitError: options.emitError,
      getPriceData: (item) => ({
        priceFeedId: item.target.product.priceFeedId1,
        blockNumber: item.target.transfer.blockNumber,
        price: item.shareRate,
        datetime: item.blockDatetime,
      }),
      formatOutput: (item, priceRow) => ({ ...item, priceRow }),
    }),

    // insert the investment data
    upsertInvestment$({
      ctx: options.ctx,
      emitError: options.emitError,
      getInvestmentData: (item) => ({
        datetime: item.blockDatetime,
        blockNumber: item.target.transfer.blockNumber,
        productId: item.target.product.productId,
        investorId: item.investorId,
        transactionHash: item.target.transfer.transactionHash,
        // balance is expressed in vault shares
        balance: item.balance,
        balanceDiff: item.target.transfer.amountTransferred,
        pendingRewards: null,
        pendingRewardsDiff: null,
      }),
      formatOutput: (item, investment) => ({ ...item, investment, result: true }),
    }),

    // push all this data to the investor cache so we can use it later
    upsertInvestorCacheChainInfos$({
      ctx: options.ctx,
      emitError: options.emitError,
      getInvestorCacheChainInfos: (item) => ({
        product: item.target.product,
        data: {
          productId: item.investment.productId,
          investorId: item.investment.investorId,
          datetime: item.investment.datetime,
          blockNumber: item.investment.blockNumber,
          transactionHash: item.target.transfer.transactionHash,
          balance: item.investment.balance,
          balanceDiff: item.investment.balanceDiff,
          pendingRewards: null,
          pendingRewardsDiff: null,
          shareToUnderlyingPrice: item.shareRate,
          underlyingBalance: item.investment.balance.mul(item.shareRate),
          underlyingDiff: item.investment.balanceDiff.mul(item.shareRate),
        },
      }),
      formatOutput: (item, investorCacheChainInfos) => ({ ...item, investorCacheChainInfos }),
    }),
  );
}
