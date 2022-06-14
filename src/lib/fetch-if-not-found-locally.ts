import axios from "axios";
import * as fs from "fs";
import { Chain } from "../types/chain";
import { DATA_DIRECTORY } from "../utils/config";
import * as path from "path";
import { makeDataDirRecursive } from "./make-data-dir-recursive";
import { normalizeAddress } from "../utils/ethers";
import { fetchContractFirstLastTrxFromExplorer } from "./contract-transaction-infos";
import { cacheAsyncResultInRedis } from "../utils/cache";

function fetchIfNotFoundLocally<TRes, TArgs extends any[]>(
  doFetch: (...parameters: TArgs) => Promise<TRes>,
  getLocalPath: (...parameters: TArgs) => string
) {
  return async function (...parameters: TArgs): Promise<TRes> {
    const localPath = getLocalPath(...parameters);
    if (fs.existsSync(localPath)) {
      const content = await fs.promises.readFile(localPath, "utf8");
      const data = JSON.parse(content);
      return data;
    }
    const data = await doFetch(...parameters);
    await makeDataDirRecursive(localPath);
    await fs.promises.writeFile(localPath, JSON.stringify(data));
    return data;
  };
}

interface RawBeefyVault {
  id: string;
  tokenDecimals: number;
  earnContractAddress: string;
  earnedToken: string;
  isGovVault?: boolean;
  status?: string;
}
interface BeefyVault {
  id: string;
  token_name: string;
  token_decimals: number;
  token_address: string;
}
export const fetchBeefyVaultAddresses = fetchIfNotFoundLocally(
  async (chain: Chain) => {
    const res = await axios.get<RawBeefyVault[]>(
      `https://raw.githubusercontent.com/beefyfinance/beefy-v2/main/src/config/vault/${chain}.json`
    );
    const rawData: RawBeefyVault[] = res.data;
    const data: BeefyVault[] = rawData
      .filter((vault) => !(vault.isGovVault === true))
      .filter((vault) => !(vault.status === "eol"))
      .map((vault) => ({
        id: vault.id,
        token_name: vault.earnedToken,
        token_decimals: vault.tokenDecimals,
        token_address: normalizeAddress(vault.earnContractAddress),
      }));
    return data;
  },
  (chain: Chain) => path.join(DATA_DIRECTORY, chain, "beefy", "vaults.json")
);

export const fetchContractCreationInfos = fetchIfNotFoundLocally(
  async (chain: Chain, contractAddress: string) => {
    return fetchContractFirstLastTrxFromExplorer(
      chain,
      contractAddress,
      "first"
    );
  },
  (chain: Chain, contractAddress: string) =>
    path.join(
      DATA_DIRECTORY,
      chain,
      "contracts",
      normalizeAddress(contractAddress),
      "creation_date.json"
    )
);

export const fetchCachedContractLastTransaction = cacheAsyncResultInRedis(
  async (chain: Chain, contractAddress: string) => {
    return fetchContractFirstLastTrxFromExplorer(
      chain,
      contractAddress,
      "last"
    );
  },
  {
    getKey: (chain: Chain, contractAddress: string) =>
      `${chain}:${contractAddress}:last-trx`,
    dateFields: ["datetime"],
    ttl_sec: 60 * 60,
  }
);
