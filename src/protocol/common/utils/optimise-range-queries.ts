import { chunk, groupBy, keyBy, range as lodashRange, max, min, sortBy, sum } from "lodash";
import { ProgrammerError } from "../../../utils/programmer-error";
import {
  Range,
  SupportedRangeTypes,
  getRangeSize,
  rangeCovering,
  rangeIntersect,
  rangeMerge,
  rangeSlitToMaxLength,
  rangeSortedArrayExclude,
  rangeSortedSplitManyToMaxLengthAndTakeSome,
  rangeSplitManyToMaxLength,
  rangeToNumber,
  rangeValueMax,
} from "../../../utils/range";

interface Input<TRange extends SupportedRangeTypes> {
  states: {
    productKey: string;
    fullRange: Range<TRange>;
    coveredRanges: Range<TRange>[];
    toRetry: Range<TRange>[];
  }[];
  options: {
    ignoreImportState: boolean;
    maxAddressesPerQuery: number;
    maxRangeSize: number;
    maxQueriesPerProduct: number;
  };
}

interface JsonRpcBatchOutput<TRange extends SupportedRangeTypes> {
  type: "jsonrpc batch";
  queries: {
    productKey: string;
    range: Range<TRange>;
  }[];
}

interface AddressBatchOutput<TRange extends SupportedRangeTypes> {
  type: "address batch";
  queries: {
    productKeys: string[];
    range: Range<TRange>;
    // filter events after the query since we allow bigger ranges than necessary
    postFilters: {
      productKey: string;
      ranges: Range<TRange>[];
    }[];
  }[];
}

// anything internal and not exposed
type StrategyResult<T> = {
  result: T;
  totalCoverage: number;
  queryCount: number;
};

type Output<TRange extends SupportedRangeTypes> = JsonRpcBatchOutput<TRange> | AddressBatchOutput<TRange>;

/**
 * Find a good way to batch queries to minimize the quey count while also respecting the following constraints:
 * - maxAddressesPerQuery: some rpc can't accept too much addresses in their batch, or they will timeout if there is too much data
 * - maxRangeSize: most rpc restrict on how much range we can query
 * - maxQueriesPerProduct: mostly a way to avoid consuming too much memory
 */
export function optimiseRangeQueries<TRange extends SupportedRangeTypes>(input: Input<TRange>): Output<TRange> {
  // ensure we only have one input state per product
  const statesByProduct = groupBy(input.states, (s) => s.productKey);
  const duplicateStatesByProduct = Object.values(statesByProduct).filter((states) => states.length > 1);
  if (duplicateStatesByProduct.length > 0) {
    throw new ProgrammerError({ msg: "Duplicate states by product", data: { duplicateStatesByProduct } });
  }

  // sometimes we just can't batch by address
  if (input.options.maxAddressesPerQuery === 1) {
    return optimizeForJsonRpcBatch(input).result;
  }

  const jsonRpcBatch = optimizeForJsonRpcBatch(input);
  const addressBatch = optimizeForAddressBatch(input);

  let output: StrategyResult<Output<TRange>>;
  // use jsonrpc batch if there is a tie in request count, which can happen when we have a low maxQueries option
  // we want to use the method with the most coverage
  if (jsonRpcBatch.queryCount === addressBatch.queryCount) {
    output = jsonRpcBatch.totalCoverage > addressBatch.totalCoverage ? jsonRpcBatch : addressBatch;
  } else {
    // otherwise use the method with the least queries
    output = jsonRpcBatch.queryCount < addressBatch.queryCount ? jsonRpcBatch : addressBatch;
  }

  return output.result;
}

/**
 * Do some address batching using this probably not optimal algorithm
 *
 * Given the data needs below:
 *
 * 0x1: [100,299]
 * 0x2: [200,399]
 * 0x3: [250,349]
 *
 * Now, we pick a cell size, something like x% of the max size. X being a configuration of this algorithm.
 *
 * Say we got a cell size of 50 from now on, a maxRangeSize of 100 and maxAddressesPerQuery of 2.
 * We place the product queries in a grid like so:
 *
 *     | [100,149] [150,199] [200,249] [250,299] [300,349] [350,399] |
 * ----------------------------------------------------------------- |
 * 0x1 |     x         x         x         x                         |
 * 0x2 |                         x         x         x         x     |
 * 0x3 |                                   x         x               |
 * ----------------------------------------------------------------- |
 *
 * The individual cells represent data needs, please note that it's not a regular grid in the sense that rows are not ordered.
 *
 * Now we try to "fill" this grid using rectangles of length `maxRangeSize` and height `maxAddressesPerQuery`. Those will be our queries.
 * To create a query, we start from the left-most data-need and include the whole `maxRangeSize` of this product.
 * Until we have filled the `maxAddressesPerQuery` requirement, find the product that would benefit the most from being added to the batch and add it.
 * Repeat until all the grid is covered.
 *
 * For the previous example, the result would be this:
 *
 *     | [100,149] [150,199] [200,249] [250,299] [300,349] [350,399] |
 * ----------------------------------------------------------------- |
 * 0x1 | [1  x         x  1] [2   x        x  2]                     |
 * 0x2 |                     [2   x        x  2] [4  x         x  4] |
 * 0x3 |                     [3            x  3] [4  x            4] |
 * ----------------------------------------------------------------- |
 *
 * A special case that will happen often is when there is recent data to cover and very old data to reimport.
 * In this case we have a grid with data blobs separated by large gaps we don't want to look at for performance.
 *
 * To handle those cases we build a range index composed of every cell span.
 * Example with 0x4 [150,199] [550,599] below:
 *
 *     | [100,149] [150,199] [200,249] [250,299] [300,349] [350,399] [400,449] [450,499] [500,549] [550,599] |
 * --------------------------------------------------------------------------------------------------------- |
 * 0x1 |     x         x         x         x                                                                 |
 * 0x2 |                         x         x         x         x                                             |
 * 0x3 |                                   x         x                                                       |
 * 0x4 |               x                                                                     x               |
 * --------------------------------------------------------------------------------------------------------- |
 * => Range index: [[100, 399], [500, 549]].
 *
 * This way we can realign the range queries each time and have a better coverage for every blob of data.
 * Sometimes the blobs are close enough that we can merge them
 *
 * PS: note that the implementation could be way faster using a grid of bits and bitwise operations.
 */
function optimizeForAddressBatch<TRange extends SupportedRangeTypes>({
  states,
  options: { ignoreImportState, maxAddressesPerQuery, maxRangeSize },
}: Input<TRange>): StrategyResult<Output<TRange>> {
  const strategyResult: StrategyResult<AddressBatchOutput<TRange>> = {
    result: {
      type: "address batch",
      queries: [],
    },
    totalCoverage: 0,
    queryCount: 0,
  };

  // identify the ranges we need to cover
  const rangesToQuery = states.map(({ productKey, fullRange, coveredRanges, toRetry }) => ({
    productKey: productKey,
    ranges: ignoreImportState ? [fullRange] : rangeSortedArrayExclude([fullRange], [...coveredRanges, ...toRetry]),
  }));

  // idenfify blobs of data to cover and slice vertically
  const rangeIndex = _buildRangeIndex(
    rangesToQuery.map((s) => s.ranges),
    { mergeIfCloserThan: maxRangeSize, verticalSlicesSize: maxRangeSize },
  );

  // apply our algorithm to each part of the data independently
  for (let rangeIndexPart of rangeIndex) {
    // first, identify which parts of the ranges to cover we have on this part of the index
    let indexedToQuery = rangesToQuery
      .map(({ productKey, ranges }) => ({ productKey, ranges: rangeIntersect(ranges, rangeIndexPart) }))
      .filter(({ ranges }) => ranges.length > 0)
      .map(({ productKey, ranges }) => ({
        productKey,
        ranges,
        min: min(ranges.map((r) => r.from)) as number,
        max: max(ranges.map((r) => r.to)) as number,
        coverage: sum(ranges.map((r) => getRangeSize(r))),
        random: Math.random(),
      }));

    // now we build queries
    // find the product that would benefit the most from being included by sorting by range size, use random in case of tie
    indexedToQuery = sortBy(
      indexedToQuery,
      (s) => s.coverage,
      (s) => s.random,
    ).reverse();

    const queries = chunk(indexedToQuery, maxAddressesPerQuery).map((parts) => ({
      productKeys: parts.map((part) => part.productKey),
      range: rangeCovering(parts.flatMap((part) => part.ranges)),
      postFilters: parts.map((part) => ({ productKey: part.productKey, ranges: part.ranges })),
      coverage: sum(parts.flatMap((part) => part.ranges).map((r) => getRangeSize(r))),
    }));

    // merge with current result
    strategyResult.result.queries = strategyResult.result.queries.concat(
      queries.map(({ productKeys, range, postFilters }) => ({ productKeys, range, postFilters })),
    );
    strategyResult.queryCount += queries.length;
    strategyResult.totalCoverage += sum(queries.map((q) => q.coverage));
  }

  return strategyResult;
}

export function _buildRangeIndex<TRange extends SupportedRangeTypes>(
  input: Range<TRange>[][],
  { mergeIfCloserThan, verticalSlicesSize }: { mergeIfCloserThan: number; verticalSlicesSize: number },
): Range<TRange>[] {
  const ranges = rangeMerge(input.flatMap((s) => s));
  if (ranges.length <= 1) {
    return ranges;
  }

  // merge the index if the ranges are "close enough"
  const res: Range<TRange>[] = [];
  // we take advantage of the ranges being sorted after merge
  let buildUp = ranges.shift() as Range<TRange>;
  while (ranges.length > 0) {
    const currentRange = ranges.shift() as Range<TRange>;
    const bn = rangeToNumber(buildUp);
    const cn = rangeToNumber(currentRange);

    // merge if possible
    if (bn.to + mergeIfCloserThan >= cn.from) {
      buildUp.to = rangeValueMax([currentRange.to, buildUp.to]) as TRange;
    } else {
      // otherwise we changed blob
      res.push(buildUp);
      buildUp = currentRange;
    }
  }
  res.push(buildUp);

  // now split into vertical slices
  return rangeSplitManyToMaxLength(res, verticalSlicesSize);
}

/**
 * A simple method where we simply do one request per product range
 */
function optimizeForJsonRpcBatch<TRange extends SupportedRangeTypes>({
  states,
  options: { ignoreImportState, maxQueriesPerProduct, maxRangeSize },
}: Input<TRange>): StrategyResult<Output<TRange>> {
  const queries = states.flatMap(({ productKey, fullRange, coveredRanges, toRetry }) => {
    let ranges = [fullRange];

    // exclude covered ranges and retry ranges
    if (!ignoreImportState) {
      ranges = rangeSortedArrayExclude([fullRange], [...coveredRanges, ...toRetry]);
    }

    // split in ranges no greater than the maximum allowed
    // order by new range first since it's more important and more likely to be available via RPC calls
    ranges = rangeSortedSplitManyToMaxLengthAndTakeSome(ranges, maxRangeSize, maxQueriesPerProduct, "desc");

    // if there is room, add the ranges that failed to be imported
    if (ranges.length < maxQueriesPerProduct) {
      toRetry = rangeSortedSplitManyToMaxLengthAndTakeSome(toRetry, maxRangeSize, maxQueriesPerProduct - ranges.length, "desc");

      // put retries last
      ranges = ranges.concat(toRetry);
    }
    // limit the amount of queries sent
    if (ranges.length > maxQueriesPerProduct) {
      ranges = ranges.slice(0, maxQueriesPerProduct);
    }

    return ranges.map((range) => ({ productKey, range }));
  });

  const totalCoverage = sum(queries.map((q) => getRangeSize(q.range)));
  return {
    result: {
      type: "jsonrpc batch",
      queries: queries,
    },
    totalCoverage,
    queryCount: queries.length,
  };
}
