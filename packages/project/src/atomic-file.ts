import { open, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { AppError } from "../../contracts/src/index.js";

export async function writeFileAtomic(targetPath: string, content: string): Promise<void> {
  const directory = path.dirname(targetPath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(targetPath)}.${randomUUID()}.tmp`);
  let handle;

  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, targetPath);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new AppError("IO_ERROR", "无法安全写入文件。", { cause: error });
  }
}

export async function writeJsonAtomic(targetPath: string, value: unknown): Promise<void> {
  await writeFileAtomic(targetPath, `${JSON.stringify(value, null, 2)}\n`);
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Windows may not allow fsync on a directory. The file itself was already synced.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
