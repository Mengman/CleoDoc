import { access, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import { AppError } from "../../../../packages/contracts/src/index.js";

export interface DesktopSecretProtection {
  readonly isAvailable: () => Promise<boolean>;
  readonly encrypt: (plainText: string) => Promise<Buffer>;
  readonly decrypt: (
    encrypted: Buffer,
  ) => Promise<{ readonly result: string; readonly shouldReEncrypt: boolean }>;
}

export class DesktopCredentialStore {
  constructor(
    private readonly credentialPath: string,
    private readonly protection: DesktopSecretProtection,
  ) {}

  async isAvailable(): Promise<boolean> {
    return this.protection.isAvailable();
  }

  async hasApiKey(): Promise<boolean> {
    return access(this.credentialPath).then(
      () => true,
      () => false,
    );
  }

  async saveApiKey(apiKey: string): Promise<void> {
    // Encrypt and atomically persist an API key outside project and YAML storage.
    const encrypted = await this.encryptApiKey(apiKey);
    await writeBufferAtomic(this.credentialPath, encrypted);
  }

  async readApiKey(): Promise<string | undefined> {
    // Decrypt a persisted API key and refresh ciphertext after OS key rotation.
    const encrypted = await readFile(this.credentialPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw new AppError("IO_ERROR", "无法读取已保存的 API Key。", { cause: error });
    });
    if (encrypted === undefined) return undefined;
    try {
      const decrypted = await this.protection.decrypt(encrypted);
      if (decrypted.shouldReEncrypt) await this.saveApiKey(decrypted.result);
      return decrypted.result;
    } catch (error) {
      throw new AppError("CONFIG_ERROR", "无法解密已保存的 API Key。", { cause: error });
    }
  }

  private async encryptApiKey(apiKey: string): Promise<Buffer> {
    // Refuse persistence when the operating system cannot protect the credential.
    if (!(await this.protection.isAvailable())) {
      throw new AppError("CONFIG_ERROR", "当前系统没有可用的安全凭据存储，API Key 未保存。");
    }
    try {
      return await this.protection.encrypt(apiKey);
    } catch (error) {
      throw new AppError("CONFIG_ERROR", "系统安全凭据存储暂时不可用，API Key 未保存。", {
        cause: error,
      });
    }
  }
}

async function writeBufferAtomic(filePath: string, value: Buffer): Promise<void> {
  // Write encrypted bytes through a restricted temporary file and atomic replacement.
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(value);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
