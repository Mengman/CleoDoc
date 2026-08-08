import type { CdmElement } from "@cleodoc/cdm";

import type { IngestionCdmBuilder } from "./cdm-builder.js";
import type { Utf8Source } from "./utf8-source.js";

interface SourceLine {
  readonly start: number;
  readonly contentEnd: number;
  readonly content: string;
}

export function parseTextBlocks(source: Utf8Source, builder: IngestionCdmBuilder): CdmElement[] {
  const blocks: CdmElement[] = [];
  let paragraphStart: number | undefined;
  let paragraphEnd = 0;
  let paragraphLines: string[] = [];

  for (const line of readLines(source.text)) {
    if (/^[\t ]*$/.test(line.content)) {
      flushParagraph();
      continue;
    }
    paragraphStart ??= line.start;
    paragraphEnd = line.contentEnd;
    paragraphLines.push(line.content);
  }
  flushParagraph();
  return blocks;

  function flushParagraph(): void {
    if (paragraphStart === undefined) {
      return;
    }
    blocks.push(
      builder.node(
        "p",
        [builder.text(paragraphLines.join("\n"))],
        source.rangeFromTextOffsets(paragraphStart, paragraphEnd),
      ),
    );
    paragraphStart = undefined;
    paragraphEnd = 0;
    paragraphLines = [];
  }
}

function readLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < text.length) {
    let contentEnd = start;
    while (contentEnd < text.length && text[contentEnd] !== "\r" && text[contentEnd] !== "\n") {
      contentEnd += 1;
    }
    let nextStart = contentEnd;
    if (text[nextStart] === "\r") {
      nextStart += 1;
      if (text[nextStart] === "\n") {
        nextStart += 1;
      }
    } else if (text[nextStart] === "\n") {
      nextStart += 1;
    }
    lines.push({ start, contentEnd, content: text.slice(start, contentEnd) });
    start = nextStart;
  }
  return lines;
}
