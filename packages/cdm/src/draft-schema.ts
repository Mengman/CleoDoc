import type { CdmSchemaProfile, CdmTagDefinition } from "./types.js";

const inlineContainer: CdmTagDefinition = {
  kind: "node",
  allowedAttributes: ["id"],
  allowedChildTags: ["strong", "em", "mark", "i", "a", "code"],
  allowsText: true,
  allowsChildren: true,
};

const structuralContainer: CdmTagDefinition = {
  kind: "node",
  allowedAttributes: ["id"],
  allowedChildKinds: ["node"],
  allowsText: false,
  allowsChildren: true,
};

const mark: CdmTagDefinition = {
  kind: "mark",
  allowedChildKinds: ["mark"],
  allowsText: true,
  allowsChildren: true,
};

const richContainer: CdmTagDefinition = {
  kind: "node",
  allowedAttributes: ["id"],
  allowedChildKinds: ["node", "mark"],
  allowsText: true,
  allowsChildren: true,
};

/**
 * Interim schema for the confirmed CDM subset. It is deliberately named
 * draft-1 because the final CDM v1 root, style whitelist and full nesting
 * rules are still open design decisions.
 */
export const cdmDraftSchema: CdmSchemaProfile = {
  id: "draft-1",
  rootTag: "document",
  tags: {
    document: {
      ...structuralContainer,
      allowedAttributes: ["id", "version"],
      requiredAttributes: ["version"],
    },
    book: { ...structuralContainer, allowedParents: ["document"] },
    volume: {
      ...structuralContainer,
      allowedAttributes: ["id", "number"],
      allowedParents: ["book"],
    },
    chapter: {
      ...structuralContainer,
      allowedAttributes: ["id", "number"],
      allowedParents: ["document"],
    },
    "chapter-ref": {
      kind: "node",
      allowedAttributes: ["id", "document"],
      requiredAttributes: ["document"],
      allowedParents: ["book", "volume"],
      allowsText: false,
      allowsChildren: false,
    },
    article: { ...structuralContainer, allowedParents: ["document"] },
    h1: inlineContainer,
    h2: inlineContainer,
    h3: inlineContainer,
    h4: inlineContainer,
    h5: inlineContainer,
    h6: inlineContainer,
    p: inlineContainer,
    ul: { ...structuralContainer, allowedChildTags: ["li"] },
    ol: {
      ...structuralContainer,
      allowedAttributes: ["id", "start"],
      allowedChildTags: ["li"],
    },
    li: { ...richContainer, allowedParents: ["ul", "ol"] },
    blockquote: richContainer,
    pre: { ...inlineContainer, allowedChildTags: ["code"] },
    table: { ...structuralContainer, allowedChildTags: ["tr"] },
    tr: {
      ...structuralContainer,
      allowedParents: ["table"],
      allowedChildTags: ["th", "td"],
    },
    th: { ...richContainer, allowedParents: ["tr"] },
    td: { ...richContainer, allowedParents: ["tr"] },
    comment: inlineContainer,
    reference: {
      ...inlineContainer,
      allowedAttributes: ["id", "source", "chunk_id"],
      requiredAttributes: ["source"],
    },
    strong: mark,
    em: mark,
    mark,
    i: mark,
    code: {
      kind: "node",
      allowedAttributes: ["id"],
      allowsText: true,
      allowsChildren: false,
    },
    a: {
      ...inlineContainer,
      allowedAttributes: ["id", "href", "title"],
      allowedChildTags: ["strong", "em", "mark", "i", "code"],
    },
  },
};
