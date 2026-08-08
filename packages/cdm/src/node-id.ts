import { randomBytes } from "node:crypto";

import { CdmError } from "./errors.js";
import {
  CDM_NODE_ID_ALPHABET,
  CDM_NODE_ID_LENGTH,
  CDM_NODE_ID_PATTERN,
  isCdmNodeId,
} from "./node-id-format.js";
import type { CdmChild, CdmDocument, CdmElement, CdmSchemaProfile } from "./types.js";
import { assertValidCdm } from "./validation.js";

export { CDM_NODE_ID_ALPHABET, CDM_NODE_ID_LENGTH, CDM_NODE_ID_PATTERN, isCdmNodeId };

export type CdmRandomBytes = (size: number) => Uint8Array;

export function generateCdmNodeId(
  existingIds: ReadonlySet<string>,
  randomSource: CdmRandomBytes = randomBytes,
): string {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const bytes = randomSource(CDM_NODE_ID_LENGTH);
    if (bytes.length !== CDM_NODE_ID_LENGTH) {
      throw new CdmError("CDM_ID_GENERATION_FAILED", "Node ID 随机源返回了错误的字节数。");
    }
    let candidate = "";
    for (const byte of bytes) {
      candidate += CDM_NODE_ID_ALPHABET[byte & 31];
    }
    if (!existingIds.has(candidate)) {
      return candidate;
    }
  }
  throw new CdmError("CDM_ID_GENERATION_FAILED", "连续 10 次未能生成可用的 Node ID。");
}

export function assignMissingNodeIds(
  document: CdmDocument,
  profile: CdmSchemaProfile,
  randomSource: CdmRandomBytes = randomBytes,
): CdmDocument {
  assertValidCdm(document, profile, { allowMissingNodeIds: true });
  const ids = collectExistingIds(document.root);
  const root = assignElementIds(document.root, profile, ids, randomSource);
  const result = { root };
  assertValidCdm(result, profile);
  return result;
}

function collectExistingIds(root: CdmElement): Set<string> {
  const ids = new Set<string>();
  visit(root);
  return ids;

  function visit(element: CdmElement): void {
    const id = element.attributes.id;
    if (id !== undefined) {
      ids.add(id);
    }
    for (const child of element.children) {
      if (child.type === "element") {
        visit(child);
      }
    }
  }
}

function assignElementIds(
  element: CdmElement,
  profile: CdmSchemaProfile,
  ids: Set<string>,
  randomSource: CdmRandomBytes,
): CdmElement {
  const definition = profile.tags[element.name];
  const attributes = { ...element.attributes };
  if (definition?.kind === "node" && attributes.id === undefined) {
    const id = generateCdmNodeId(ids, randomSource);
    attributes.id = id;
    ids.add(id);
  }
  return {
    type: "element",
    name: element.name,
    attributes,
    children: element.children.map((child): CdmChild => {
      if (child.type === "text") {
        return child;
      }
      return assignElementIds(child, profile, ids, randomSource);
    }),
  };
}
