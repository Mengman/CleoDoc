import type {
  Definition,
  ListItem,
  PhrasingContent,
  RootContent,
  Table,
  TableCell,
  TableRow,
} from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
import type { Position } from "unist";

import type { CdmChild, CdmElement } from "@cleodoc/cdm";

import type { IngestionCdmBuilder } from "./cdm-builder.js";
import type { ParseWarning, ParseWarningCode } from "./types.js";
import type { Utf8Source } from "./utf8-source.js";

export function parseMarkdownBlocks(
  source: Utf8Source,
  builder: IngestionCdmBuilder,
  warnings: ParseWarning[],
): CdmElement[] {
  const root = fromMarkdown(source.text, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  });
  const definitions = new Map<string, Definition>();
  for (const child of root.children) {
    if (child.type === "definition") {
      definitions.set(child.identifier, child);
    }
  }
  const context = new MarkdownConversionContext(source, builder, definitions, warnings);
  return root.children.flatMap((child) => {
    const converted = context.block(child);
    return converted === null ? [] : [converted];
  });
}

class MarkdownConversionContext {
  constructor(
    private readonly source: Utf8Source,
    private readonly builder: IngestionCdmBuilder,
    private readonly definitions: ReadonlyMap<string, Definition>,
    private readonly warnings: ParseWarning[],
  ) {}

  block(node: RootContent): CdmElement | null {
    switch (node.type) {
      case "definition":
        return null;
      case "heading":
        return this.builder.node(
          `h${node.depth}`,
          this.phrasing(node.children),
          this.source.rangeFromPosition(node.position),
        );
      case "paragraph":
        return this.builder.node(
          "p",
          this.phrasing(node.children),
          this.source.rangeFromPosition(node.position),
        );
      case "blockquote":
        return this.builder.node(
          "blockquote",
          node.children.flatMap((child) => {
            const converted = this.block(child);
            return converted === null ? [] : [converted];
          }),
          this.source.rangeFromPosition(node.position),
        );
      case "list": {
        const attributes: Record<string, string> =
          node.ordered === true &&
          node.start !== undefined &&
          node.start !== null &&
          node.start !== 1
            ? { start: String(node.start) }
            : {};
        return this.builder.node(
          node.ordered === true ? "ol" : "ul",
          node.children.map((child) => this.listItem(child)),
          this.source.rangeFromPosition(node.position),
          attributes,
        );
      }
      case "code": {
        if (
          (node.lang !== undefined && node.lang !== null) ||
          (node.meta !== undefined && node.meta !== null)
        ) {
          this.warn(
            "CODE_METADATA_DROPPED",
            "代码块语言或元数据尚未进入 CDM，正文代码已保留。",
            node.position,
          );
        }
        return this.builder.node(
          "pre",
          [
            this.builder.node(
              "code",
              [this.builder.text(node.value)],
              this.source.rangeFromPosition(node.position),
            ),
          ],
          this.source.rangeFromPosition(node.position),
        );
      }
      case "table":
        return this.table(node);
      case "html":
        this.warn(
          "RAW_HTML_PRESERVED_AS_TEXT",
          "Markdown 内嵌 HTML 未执行，已作为普通文字保留。",
          node.position,
        );
        return this.rawParagraph(node.position);
      case "thematicBreak":
        this.warn(
          "UNSUPPORTED_MARKDOWN_PRESERVED_AS_TEXT",
          "分隔线尚无对应 CDM 标签，已作为普通文字保留。",
          node.position,
        );
        return this.rawParagraph(node.position);
      default:
        this.warn(
          "UNSUPPORTED_MARKDOWN_PRESERVED_AS_TEXT",
          `Markdown 节点 ${node.type} 尚未结构化，已保留原文。`,
          node.position,
        );
        return this.rawParagraph(node.position);
    }
  }

  private listItem(node: ListItem): CdmElement {
    return this.builder.node(
      "li",
      node.children.flatMap((child) => {
        const converted = this.block(child);
        return converted === null ? [] : [converted];
      }),
      this.source.rangeFromPosition(node.position),
    );
  }

  private table(node: Table): CdmElement {
    return this.builder.node(
      "table",
      node.children.map((row, index) => this.tableRow(row, index === 0)),
      this.source.rangeFromPosition(node.position),
    );
  }

  private tableRow(node: TableRow, header: boolean): CdmElement {
    return this.builder.node(
      "tr",
      node.children.map((cell) => this.tableCell(cell, header)),
      this.source.rangeFromPosition(node.position),
    );
  }

  private tableCell(node: TableCell, header: boolean): CdmElement {
    return this.builder.node(
      header ? "th" : "td",
      this.phrasing(node.children),
      this.source.rangeFromPosition(node.position),
    );
  }

  private phrasing(nodes: readonly PhrasingContent[]): CdmChild[] {
    const children: CdmChild[] = [];
    for (const node of nodes) {
      switch (node.type) {
        case "text":
          appendText(children, node.value, this.builder);
          break;
        case "emphasis":
        case "strong":
        case "delete":
          appendChildren(children, this.phrasing(node.children));
          break;
        case "inlineCode":
          children.push(
            this.builder.node(
              "code",
              [this.builder.text(node.value)],
              this.source.rangeFromPosition(node.position),
            ),
          );
          break;
        case "break":
          appendText(children, "\n", this.builder);
          break;
        case "link":
          children.push(
            this.builder.node(
              "a",
              this.phrasing(node.children),
              this.source.rangeFromPosition(node.position),
              linkAttributes(node.url, node.title),
            ),
          );
          break;
        case "linkReference": {
          const definition = this.definitions.get(node.identifier);
          if (definition === undefined) {
            this.warn(
              "UNRESOLVED_LINK_REFERENCE",
              `链接引用 ${node.identifier} 没有对应定义，已保留链接文字。`,
              node.position,
            );
            appendChildren(children, this.phrasing(node.children));
          } else {
            children.push(
              this.builder.node(
                "a",
                this.phrasing(node.children),
                this.source.rangeFromPosition(node.position),
                linkAttributes(definition.url, definition.title),
              ),
            );
          }
          break;
        }
        case "image":
        case "imageReference":
          this.warn(
            "IMAGE_REDUCED_TO_ALT_TEXT",
            "图片不在当前解析范围，已保留替代文字。",
            node.position,
          );
          appendText(children, node.alt ?? "", this.builder);
          break;
        case "html":
          this.warn(
            "RAW_HTML_PRESERVED_AS_TEXT",
            "Markdown 内嵌 HTML 未执行，已作为普通文字保留。",
            node.position,
          );
          appendText(children, node.value, this.builder);
          break;
        case "footnoteReference":
          this.warn(
            "UNSUPPORTED_MARKDOWN_PRESERVED_AS_TEXT",
            "脚注尚未结构化，已保留原文。",
            node.position,
          );
          appendText(children, this.source.slice(node.position), this.builder);
          break;
      }
    }
    return children;
  }

  private rawParagraph(position: Position | undefined): CdmElement {
    return this.builder.node(
      "p",
      [this.builder.text(this.source.slice(position))],
      this.source.rangeFromPosition(position),
    );
  }

  private warn(code: ParseWarningCode, message: string, position: Position | undefined): void {
    const range = position === undefined ? {} : this.source.rangeFromPosition(position);
    this.warnings.push({ code, message, ...range });
  }
}

function linkAttributes(url: string, title: string | null | undefined): Record<string, string> {
  return title === undefined || title === null ? { href: url } : { href: url, title };
}

function appendText(children: CdmChild[], value: string, builder: IngestionCdmBuilder): void {
  const previous = children.at(-1);
  if (previous?.type === "text") {
    children[children.length - 1] = builder.text(previous.value + value);
  } else {
    children.push(builder.text(value));
  }
}

function appendChildren(target: CdmChild[], source: readonly CdmChild[]): void {
  for (const child of source) {
    if (child.type === "text") {
      const previous = target.at(-1);
      if (previous?.type === "text") {
        target[target.length - 1] = { type: "text", value: previous.value + child.value };
        continue;
      }
    }
    target.push(child);
  }
}
