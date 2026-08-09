import { mkdir, readFile } from "node:fs/promises";
import { TextDecoder } from "node:util";

import { AppError } from "../../contracts/src/index.js";
import { resolveInsideProject } from "../../project/src/index.js";
import { decodeMaterialText, type MaterialInputEncoding } from "./text-decoding.js";

export async function ensureMaterialDirectories(projectRoot: string): Promise<void> {
  const materials = await resolveInsideProject(projectRoot, "materials");
  const metadata = await resolveInsideProject(projectRoot, "sources/metadata");
  const derivedDocuments = await resolveInsideProject(projectRoot, ".cleo/derived/documents");
  const derivedChunks = await resolveInsideProject(projectRoot, ".cleo/derived/chunks");
  await Promise.all([
    mkdir(materials.absolutePath, { recursive: true }),
    mkdir(metadata.absolutePath, { recursive: true }),
    mkdir(derivedDocuments.absolutePath, { recursive: true }),
    mkdir(derivedChunks.absolutePath, { recursive: true }),
  ]);
}

export async function readOptionalFile(filePath: string): Promise<string | null> {
  return await readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

export async function readMaterialFile(
  filePath: string,
  requestedEncoding: MaterialInputEncoding | undefined,
  maxImportBytes: number,
) {
  const content = await readFile(filePath);
  if (content.byteLength > maxImportBytes) {
    throw new AppError("VALIDATION_ERROR", "单份资料超过了软件配置允许的大小。");
  }
  return decodeMaterialText(content, requestedEncoding);
}

export async function readStoredUtf8Text(
  filePath: string,
  maxImportBytes: number,
): Promise<string> {
  const content = await readFile(filePath);
  if (content.byteLength > maxImportBytes) {
    throw new AppError("VALIDATION_ERROR", "单份资料超过了软件配置允许的大小。");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (error) {
    throw new AppError("VALIDATION_ERROR", "项目内资料副本必须是有效的 UTF-8 文本。", {
      cause: error,
    });
  }
}
