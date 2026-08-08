import type { CdmChild, CdmDocument, CdmElement, CdmSchemaProfile } from "./types.js";
import { assertValidCdm } from "./validation.js";

export function serializeCdm(document: CdmDocument, profile: CdmSchemaProfile): string {
  assertValidCdm(document, profile);
  return serializeElement(document.root);
}

function serializeElement(element: CdmElement): string {
  const attributes = Object.entries(element.attributes)
    .sort(([left], [right]) => compareAttributeNames(left, right))
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join("");
  if (element.children.length === 0) {
    return `<${element.name}${attributes}/>`;
  }
  const children = element.children.map(serializeChild).join("");
  return `<${element.name}${attributes}>${children}</${element.name}>`;
}

function serializeChild(child: CdmChild): string {
  return child.type === "text" ? escapeText(child.value) : serializeElement(child);
}

function compareAttributeNames(left: string, right: string): number {
  return attributePriority(left) - attributePriority(right) || left.localeCompare(right);
}

function attributePriority(name: string): number {
  if (name === "id") {
    return 0;
  }
  if (name === "version") {
    return 1;
  }
  return 2;
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;");
}
