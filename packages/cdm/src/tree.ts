import type { CdmChild, CdmDocument, CdmElement } from "./types.js";

export function* walkCdmElements(
  documentOrElement: CdmDocument | CdmElement,
): Generator<CdmElement> {
  const root = "root" in documentOrElement ? documentOrElement.root : documentOrElement;
  yield root;
  for (const child of root.children) {
    if (child.type === "element") {
      yield* walkCdmElements(child);
    }
  }
}

export function findCdmElementById(
  documentOrElement: CdmDocument | CdmElement,
  id: string,
): CdmElement | undefined {
  for (const element of walkCdmElements(documentOrElement)) {
    if (element.attributes.id === id) {
      return element;
    }
  }
  return undefined;
}

export function getCdmTextContent(documentOrChild: CdmDocument | CdmChild): string {
  const child = "root" in documentOrChild ? documentOrChild.root : documentOrChild;
  if (child.type === "text") {
    return child.value;
  }
  return child.children.map(getCdmTextContent).join("");
}
