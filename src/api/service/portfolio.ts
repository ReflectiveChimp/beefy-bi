import { allChainIds, Chain } from "../../types/chain";
import { SamplingPeriod, samplingPeriodMs } from "../../types/sampling";
import { DbClient, db_query } from "../../utils/db";
import { rootLogger } from "../../utils/logger";
import { AsyncCache } from "./cache";
import { ProductService } from "./product";

const logger = rootLogger.child({ module: "api", component: "portfolio-service" });

export class PortfolioService {
  constructor(private services: { db: DbClient; cache: AsyncCache; product: ProductService }) {}

  async getInvestedProducts(investorId: number, chains: Chain[]) {
    logger.debug({ msg: "getInvestedProducts", data: { investorId, chains } });
    const res = await db_query<{
      product_id: number;
      last_balance: string;
    }>(
      `
      with last_balances as (
        select p.product_id, last(balance::numeric, b.block_number) as last_balance
        from investment_balance_ts b
        join product p on p.product_id = b.product_id
        where investor_id = %L and chain in (%L)
        group by 1
      )
      select *
      from last_balances
      where last_balance is not null
        and last_balance > 0
    `,
      [investorId, chains],
      this.services.db,
    );
    logger.trace({ msg: "getInvestedProducts", data: { investorId, chains, res: res.map((p) => p.product_id) } });
    return res;
  }

  async getInvestorPortfolioValue(investorId: number) {
    const cacheKey = `api:portfolio-service:current-value:${investorId}}`;
    const ttl = 1000 * 60 * 5; // 5 min
    return this.services.cache.wrap(cacheKey, ttl, async () => {
      logger.debug({ msg: "getInvestorPortfolioValue", data: { investorId } });
      const investedProducts = await this.getInvestedProducts(investorId, allChainIds);
      const productIds = investedProducts.map((p) => p.product_id);
      logger.trace({ msg: "getInvestorPortfolioValue", data: { investorId, productIds } });
      const priceFeedIDs = await this.services.product.getPriceFeedIds(productIds);
      const priceFeed1Ids = priceFeedIDs.map((pfs) => pfs.price_feed_1_id);
      const priceFeed2Ids = priceFeedIDs.map((pfs) => pfs.price_feed_2_id);
      const priceFeedPendingRewardsIds = priceFeedIDs.map((pfs) => pfs.pending_rewards_price_feed_id).filter((a): a is number => !!a);
      logger.trace({ msg: "getInvestorPortfolioValue", data: { investorId, productIds, priceFeed1Ids, priceFeed2Ids, priceFeedPendingRewardsIds } });

      const res = await db_query<{
        product_id: number;
        product_key: string;
        chain: Chain;
        is_eol: boolean;
        share_to_underlying_price: string;
        underlying_to_usd_price: string;
        share_balance: string;
        underlying_balance: string;
        usd_balance: string;
        pending_rewards: string;
        pending_rewards_usd: string;
      }>(
        `
          with share_balance as (
            SELECT
              b.product_id,
              last(b.balance::numeric, b.block_number) as share_balance,
              last(b.pending_rewards::numeric, b.block_number) as pending_rewards,
              last(b.datetime, b.block_number) as share_last_time
            FROM
              investment_balance_ts b
            WHERE
              b.investor_id = %L
              and b.product_id in (select unnest(ARRAY[%L]::integer[]))
            group by 1
          ),
          price_1 as (
            SELECT
              p1.price_feed_id,
              last(p1.price::numeric, p1.datetime) as price,
              last(p1.datetime, p1.datetime) as last_time
            FROM
              price_ts p1
            WHERE
              p1.price_feed_id in (select unnest(ARRAY[%L]::integer[]))
            group by 1
          ),
          price_2 as (
            SELECT
              p2.price_feed_id,
              last(p2.price::numeric, p2.datetime) as price,
              last(p2.datetime, p2.datetime) as last_time
            FROM
              price_ts p2
            WHERE
              p2.price_feed_id in (select unnest(ARRAY[%L]::integer[]))
            group by 1
          ),
          price_pending_rewards as (
            SELECT
              ppr.price_feed_id,
              last(ppr.price::numeric, ppr.datetime) as price,
              last(ppr.datetime, ppr.datetime) as last_time
            FROM
              price_ts ppr
            WHERE
              ppr.price_feed_id in (select unnest(ARRAY[%L]::integer[]))
            group by 1
          )
          select 
            p.product_id,
            p.product_key,
            p.chain,
            coalesce(p.product_data->'vault'->>'eol', p.product_data->'boost'->>'eol')::text = 'true' as is_eol,
            p1.price as share_to_underlying_price, 
            p2.price as underlying_to_usd_price,
            b.share_balance::NUMERIC(100, 24), 
            (b.share_balance * p1.price)::NUMERIC(100, 24) as underlying_balance,
            (b.share_balance * p1.price * p2.price)::NUMERIC(100, 24) as usd_balance,
            b.pending_rewards::NUMERIC(100, 24) as pending_rewards,
            (b.pending_rewards * ppr.price)::NUMERIC(100, 24) as pending_rewards_usd
          from share_balance b
            left join product p on b.product_id = p.product_id
            left join price_1 p1 on p.price_feed_1_id = p1.price_feed_id
            left join price_2 p2 on p.price_feed_2_id = p2.price_feed_id
            left join price_pending_rewards ppr on p.pending_rewards_price_feed_id = ppr.price_feed_id
          order by 1
        `,
        [investorId, productIds, priceFeed1Ids, priceFeed2Ids, priceFeedPendingRewardsIds],
        this.services.db,
      );

      logger.trace({ msg: "getInvestorPortfolioValue", data: { investorId, res } });
      return res;
    });
  }

  async getInvestorTimeline(investorId: number) {
    const cacheKey = `api:portfolio-service:timeline:${investorId}}`;
    const ttl = 1000 * 60 * 5; // 5 min
    return this.services.cache.wrap(cacheKey, ttl, async () => {
      const investedProducts = await this.getInvestedProducts(investorId, allChainIds);
      const productIds = investedProducts.map((p) => p.product_id);

      return db_query<{
        datetime: Date;
        product_key: string;
        chain: Chain;
        is_eol: boolean;
        share_to_underlying_price: string;
        underlying_to_usd_price: string;
        share_balance: string;
        underlying_balance: string;
        usd_balance: string;
        share_diff: string;
        underlying_diff: string;
        usd_diff: string;
      }>(
        `
          with investment_diff_raw as (
            select b.datetime, b.product_id, b.balance, b.balance_diff, 
              last(pr1.price::numeric, pr1.datetime) as price1, 
              last(pr2.price::numeric, pr2.datetime) as price2
            from investment_balance_ts b
            left join product p 
              on b.product_id = p.product_id
            -- we should have the exact price1 (share to underlying) from this exact block for all investment change
            left join price_ts pr1 
              on p.price_feed_1_id = pr1.price_feed_id 
              and pr1.datetime = b.datetime 
              and pr1.block_number = b.block_number 
            -- but for price 2 (underlying to usd) we need to match on approx time
            left join price_ts pr2 
              on p.price_feed_2_id = pr2.price_feed_id 
              and time_bucket('15min', pr2.datetime) = time_bucket('15min', b.datetime)
            where b.investor_id = %L
              and b.product_id in (select unnest(ARRAY[%L]::integer[]))
              and b.balance_diff != 0 -- only show changes, not reward snapshots
            group by 1,2,3,4
          ),
          investment_diff as (
            select b.datetime,
              p.product_key,
              p.chain,
              coalesce(p.product_data->'vault'->>'eol', p.product_data->'boost'->>'eol')::text = 'true' as is_eol,
              b.price1 as share_to_underlying_price, 
              b.price2 as underlying_to_usd_price,
              b.balance as share_balance, 
              (b.balance * b.price1)::NUMERIC(100, 24) as underlying_balance,
              (b.balance * b.price1 * b.price2)::NUMERIC(100, 24) as usd_balance,
              b.balance_diff as share_diff, 
              (b.balance_diff * b.price1)::NUMERIC(100, 24) as underlying_diff,
              (b.balance_diff * b.price1 * b.price2)::NUMERIC(100, 24) as usd_diff
            from investment_diff_raw b
            join product p on p.product_id = b.product_id
          )
          select * 
          from investment_diff
          order by product_key asc, datetime asc
        `,
        [investorId, productIds],
        this.services.db,
      );
    });
  }

  async getInvestorProductUsdValueTs(investorId: number, productId: number, bucketSize: SamplingPeriod, timeRange: SamplingPeriod) {
    const cacheKey = `api:portfolio-service:investor-product-usd-value:${investorId}-${productId}-${bucketSize}-${timeRange}`;
    const ttl = 1000 * 60 * 5; // 5 min
    return this.services.cache.wrap(cacheKey, ttl, async () => {
      const priceFeedIDs = await this.services.product.getPriceFeedIds([productId]);
      const priceFeed1Ids = priceFeedIDs.map((pfs) => pfs.price_feed_1_id);
      const priceFeed2Ids = priceFeedIDs.map((pfs) => pfs.price_feed_2_id);
      const priceFeedPendingRewardsIds = priceFeedIDs
        .map((pfs) => pfs.pending_rewards_price_feed_id)
        .concat([-1]) // make sure it's not empty
        .filter((id) => !!id);
      const to = new Date();
      const from = new Date(to.getTime() - samplingPeriodMs[timeRange]);

      return db_query<{
        datetime: string;
        share_balance: string;
        underlying_balance: string;
        usd_balance: string;
        pending_rewards: string;
        pending_rewards_usd: string;
      }>(
        `
          with balance_ts as (
            select * 
            from narrow_gapfilled_investor_balance(%L::timestamptz, %L::timestamptz, %L::interval, %L, ARRAY[%L]::integer[])
            where balance is not null or pending_rewards is not null
          ),
          price_1_ts as (
            select *
            from  narrow_gapfilled_price(%L::timestamptz, %L::timestamptz, %L::interval, ARRAY[%L]::integer[])
            where price is not null
          ),
          price_2_ts as (
            select *
            from  narrow_gapfilled_price(%L::timestamptz, %L::timestamptz, %L::interval, ARRAY[%L]::integer[])
            where price is not null
          ),
          price_rewards_ts as (
            select *
            from  narrow_gapfilled_price(%L::timestamptz, %L::timestamptz, %L::interval, ARRAY[%L]::integer[])
            where price is not null
          )
          select
            b.datetime as datetime,
            b.balance as share_balance,
            (b.balance * p1.price)::NUMERIC(100, 24) as underlying_balance,
            (b.balance * p1.price * p2.price)::NUMERIC(100, 24) as "usd_balance",
            (b.pending_rewards)::NUMERIC(100, 24) as "pending_rewards",
            (b.pending_rewards * ppr.price)::NUMERIC(100, 24) as "pending_rewards_usd"
          from balance_ts b
            left join product pr on b.product_id = pr.product_id
            left join price_1_ts p1 on b.datetime = p1.datetime and pr.price_feed_1_id = p1.price_feed_id
            left join price_2_ts p2 on b.datetime = p2.datetime and pr.price_feed_2_id = p2.price_feed_id
            left join price_rewards_ts ppr on b.datetime = ppr.datetime and pr.pending_rewards_price_feed_id = ppr.price_feed_id
          order by 1;
        `,
        [
          // balance_ts
          from.toISOString(),
          to.toISOString(),
          bucketSize,
          investorId,
          [productId],
          // price_1_ts
          from.toISOString(),
          to.toISOString(),
          bucketSize,
          priceFeed1Ids,
          // price_2_ts
          from.toISOString(),
          to.toISOString(),
          bucketSize,
          priceFeed2Ids,
          // price_rewards_ts
          from.toISOString(),
          to.toISOString(),
          bucketSize,
          priceFeedPendingRewardsIds,
        ],
        this.services.db,
      );
    });
  }
}
