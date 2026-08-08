import { CdmError } from "./errors.js";
import { isCdmNodeId } from "./node-id-format.js";
import type {
  CdmDocument,
  CdmElement,
  CdmSchemaProfile,
  CdmValidationIssue,
  ValidateCdmOptions,
} from "./types.js";

export function validateCdm(
  document: CdmDocument,
  profile: CdmSchemaProfile,
  options: ValidateCdmOptions = {},
): readonly CdmValidationIssue[] {
  const issues: CdmValidationIssue[] = [];
  const ids = new Set<string>();

  if (document.root.name !== profile.rootTag) {
    issues.push({
      code: "INVALID_ROOT",
      message: `CDM 根元素必须是 <${profile.rootTag}>。`,
      path: `/${document.root.name}`,
    });
  }

  validateElement(
    document.root,
    undefined,
    `/${document.root.name}`,
    profile,
    options,
    ids,
    issues,
  );
  return issues;
}

export function assertValidCdm(
  document: CdmDocument,
  profile: CdmSchemaProfile,
  options: ValidateCdmOptions = {},
): void {
  const issues = validateCdm(document, profile, options);
  if (issues.length > 0) {
    throw new CdmError("CDM_SCHEMA_INVALID", "CDM 未通过 Schema 校验。", { issues });
  }
}

function validateElement(
  element: CdmElement,
  parentName: string | undefined,
  path: string,
  profile: CdmSchemaProfile,
  options: ValidateCdmOptions,
  ids: Set<string>,
  issues: CdmValidationIssue[],
): void {
  const definition = profile.tags[element.name];
  if (definition === undefined) {
    issues.push({ code: "UNKNOWN_TAG", message: `不支持标签 <${element.name}>。`, path });
    return;
  }

  if (
    parentName !== undefined &&
    definition.allowedParents !== undefined &&
    !definition.allowedParents.includes(parentName)
  ) {
    issues.push({
      code: "INVALID_PARENT",
      message: `<${element.name}> 不能位于 <${parentName}> 内。`,
      path,
    });
  }

  const allowedAttributes = new Set(definition.allowedAttributes ?? []);
  for (const attribute of Object.keys(element.attributes)) {
    if (!allowedAttributes.has(attribute)) {
      issues.push({
        code: "UNKNOWN_ATTRIBUTE",
        message: `<${element.name}> 不允许属性 ${attribute}。`,
        path,
      });
    }
  }
  for (const attribute of definition.requiredAttributes ?? []) {
    if (!hasNonEmptyAttribute(element, attribute)) {
      issues.push({
        code: "MISSING_ATTRIBUTE",
        message: `<${element.name}> 缺少属性 ${attribute}。`,
        path,
      });
    }
  }

  if (definition.kind === "node") {
    validateNodeId(element, path, options, ids, issues);
  }

  const elementChildren = element.children.filter((child) => child.type === "element");
  if (definition.allowsChildren === false && elementChildren.length > 0) {
    issues.push({
      code: "CHILDREN_NOT_ALLOWED",
      message: `<${element.name}> 不能包含子元素。`,
      path,
    });
  }
  if (
    definition.allowsText === false &&
    element.children.some((child) => child.type === "text" && child.value.trim().length > 0)
  ) {
    issues.push({
      code: "TEXT_NOT_ALLOWED",
      message: `<${element.name}> 不能直接包含文字。`,
      path,
    });
  }

  const childNameCounts = new Map<string, number>();
  for (const child of elementChildren) {
    const ordinal = (childNameCounts.get(child.name) ?? 0) + 1;
    childNameCounts.set(child.name, ordinal);
    const childDefinition = profile.tags[child.name];
    if (
      childDefinition !== undefined &&
      definition.allowedChildKinds !== undefined &&
      !definition.allowedChildKinds.includes(childDefinition.kind)
    ) {
      issues.push({
        code: "INVALID_PARENT",
        message: `<${element.name}> 不能包含 ${childDefinition.kind} <${child.name}>。`,
        path: `${path}/${child.name}[${ordinal}]`,
      });
    }
    if (
      definition.allowedChildTags !== undefined &&
      !definition.allowedChildTags.includes(child.name)
    ) {
      issues.push({
        code: "INVALID_PARENT",
        message: `<${element.name}> 不能包含 <${child.name}>。`,
        path: `${path}/${child.name}[${ordinal}]`,
      });
    }
    validateElement(
      child,
      element.name,
      `${path}/${child.name}[${ordinal}]`,
      profile,
      options,
      ids,
      issues,
    );
  }
}

function validateNodeId(
  element: CdmElement,
  path: string,
  options: ValidateCdmOptions,
  ids: Set<string>,
  issues: CdmValidationIssue[],
): void {
  const id = element.attributes.id;
  if (id === undefined || id.length === 0) {
    if (!options.allowMissingNodeIds) {
      issues.push({ code: "MISSING_NODE_ID", message: `<${element.name}> 缺少 Node ID。`, path });
    }
    return;
  }
  if (!isCdmNodeId(id)) {
    issues.push({ code: "INVALID_NODE_ID", message: `Node ID ${id} 格式无效。`, path });
    return;
  }
  if (ids.has(id)) {
    issues.push({ code: "DUPLICATE_NODE_ID", message: `Node ID ${id} 重复。`, path });
    return;
  }
  ids.add(id);
}

function hasNonEmptyAttribute(element: CdmElement, name: string): boolean {
  const value = element.attributes[name];
  return value !== undefined && value.trim().length > 0;
}
