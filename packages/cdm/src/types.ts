export interface CdmText {
  readonly type: "text";
  readonly value: string;
}

export interface CdmElement {
  readonly type: "element";
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly CdmChild[];
}

export type CdmChild = CdmElement | CdmText;

export interface CdmDocument {
  readonly root: CdmElement;
}

export type CdmTagKind = "node" | "mark";

export interface CdmTagDefinition {
  readonly kind: CdmTagKind;
  readonly allowedAttributes?: readonly string[];
  readonly requiredAttributes?: readonly string[];
  readonly allowedParents?: readonly string[];
  readonly allowedChildKinds?: readonly CdmTagKind[];
  readonly allowedChildTags?: readonly string[];
  readonly allowsText?: boolean;
  readonly allowsChildren?: boolean;
}

export interface CdmSchemaProfile {
  readonly id: string;
  readonly rootTag: string;
  readonly tags: Readonly<Record<string, CdmTagDefinition>>;
}

export type CdmValidationIssueCode =
  | "INVALID_ROOT"
  | "UNKNOWN_TAG"
  | "INVALID_PARENT"
  | "UNKNOWN_ATTRIBUTE"
  | "MISSING_ATTRIBUTE"
  | "MISSING_NODE_ID"
  | "INVALID_NODE_ID"
  | "DUPLICATE_NODE_ID"
  | "TEXT_NOT_ALLOWED"
  | "CHILDREN_NOT_ALLOWED";

export interface CdmValidationIssue {
  readonly code: CdmValidationIssueCode;
  readonly message: string;
  readonly path: string;
}

export interface ValidateCdmOptions {
  readonly allowMissingNodeIds?: boolean;
}
