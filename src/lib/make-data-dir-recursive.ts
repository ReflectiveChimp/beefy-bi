import * as fs from "fs";
import * as path from "path";
import { DATA_DIRECTORY } from "../utils/config";

export async function makeDataDirRecursive(filePath: string) {
  // extract dir path from file path
  const dirPath = path.dirname(filePath);
  // check that dir is inside data dir
  if (!dirPath.startsWith(DATA_DIRECTORY)) {
    throw new Error(`${filePath} is not inside ${DATA_DIRECTORY}`);
  }

  if (!fs.existsSync(dirPath)) {
    await fs.promises.mkdir(dirPath, { recursive: true });
  }
}
