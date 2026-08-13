import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DesktopCredentialStore,
  type DesktopSecretProtection,
} from "./desktop-credential-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("DesktopCredentialStore", () => {
  it("persists only protected API key bytes and decrypts them after restart", async () => {
    // Verify that the credential file never contains the plaintext API key.
    const fixture = await createFixture();
    await fixture.store.saveApiKey("sk-private-value");

    expect((await readFile(fixture.credentialPath)).toString("utf8")).not.toContain(
      "sk-private-value",
    );
    expect(await fixture.store.readApiKey()).toBe("sk-private-value");
  });

  it("refuses to persist when secure OS protection is unavailable", async () => {
    // Verify that an unavailable system key store cannot fall back to plaintext persistence.
    const fixture = await createFixture(false);

    await expect(fixture.store.saveApiKey("sk-private-value")).rejects.toMatchObject({
      code: "CONFIG_ERROR",
    });
    await expect(fixture.store.hasApiKey()).resolves.toBe(false);
  });
});

async function createFixture(available = true): Promise<{
  readonly credentialPath: string;
  readonly store: DesktopCredentialStore;
}> {
  // Create an isolated credential path backed by reversible fake protection.
  const root = await mkdtemp(path.join(tmpdir(), "cleodoc-credentials-"));
  temporaryDirectories.push(root);
  const protection: DesktopSecretProtection = {
    isAvailable: async () => available,
    encrypt: async (value) => Buffer.from(value, "utf8").reverse(),
    decrypt: async (value) => ({
      result: Buffer.from(value).reverse().toString("utf8"),
      shouldReEncrypt: false,
    }),
  };
  const credentialPath = path.join(root, "api-key.bin");
  return { credentialPath, store: new DesktopCredentialStore(credentialPath, protection) };
}
