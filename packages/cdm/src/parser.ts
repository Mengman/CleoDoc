import { SaxesParser } from "saxes";

import { CdmError } from "./errors.js";
import type { CdmChild, CdmDocument, CdmElement, CdmSchemaProfile } from "./types.js";
import { assertValidCdm } from "./validation.js";

interface MutableElement {
  type: "element";
  name: string;
  attributes: Record<string, string>;
  children: CdmChild[];
}

export function parseCdmXml(xml: string): CdmDocument {
  if (xml.trim().length === 0) {
    throw new CdmError("CDM_XML_INVALID", "CDM XML 不能为空。");
  }

  const stack: MutableElement[] = [];
  let root: CdmElement | undefined;
  const parser = new SaxesParser<{ xmlns: false }>({ xmlns: false });

  parser.on("doctype", () => {
    throw new CdmError("CDM_XML_INVALID", "CDM 不允许 DOCTYPE 或自定义实体。");
  });
  parser.on("comment", () => {
    throw new CdmError("CDM_XML_INVALID", "CDM 不允许 XML 注释；文档批注必须使用 CDM <comment>。");
  });
  parser.on("processinginstruction", ({ target }) => {
    throw new CdmError("CDM_XML_INVALID", `CDM 不允许处理指令 <?${target}?>。`);
  });
  parser.on("opentag", (tag) => {
    const element: MutableElement = {
      type: "element",
      name: tag.name,
      attributes: { ...tag.attributes },
      children: [],
    };
    const parent = stack.at(-1);
    if (parent === undefined) {
      root = element;
    } else {
      parent.children.push(element);
    }
    stack.push(element);
  });
  parser.on("text", (value) => appendText(stack.at(-1), value));
  parser.on("cdata", (value) => appendText(stack.at(-1), value));
  parser.on("closetag", () => {
    stack.pop();
  });

  try {
    parser.write(xml).close();
  } catch (error) {
    if (error instanceof CdmError) {
      throw error;
    }
    throw new CdmError("CDM_XML_INVALID", "CDM XML 不是结构完整的严格 XML。", {
      cause: error,
    });
  }

  if (root === undefined) {
    throw new CdmError("CDM_XML_INVALID", "CDM XML 缺少根元素。");
  }
  return { root };
}

export function parseAndValidateCdmXml(xml: string, profile: CdmSchemaProfile): CdmDocument {
  const document = parseCdmXml(xml);
  assertValidCdm(document, profile);
  return document;
}

function appendText(parent: MutableElement | undefined, value: string): void {
  if (parent === undefined || value.length === 0) {
    return;
  }
  const previous = parent.children.at(-1);
  if (previous?.type === "text") {
    parent.children[parent.children.length - 1] = {
      type: "text",
      value: previous.value + value,
    };
    return;
  }
  parent.children.push({ type: "text", value });
}
