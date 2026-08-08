import type { CdmElement } from "@cleodoc/cdm";

import type { IngestionCdmBuilder } from "./cdm-builder.js";
import type { Utf8Source } from "./utf8-source.js";

interface SourceLine {
  readonly start: number;
  readonly contentEnd: number;
  readonly content: string;
}

export function parseTextBlocks(source: Utf8Source, builder: IngestionCdmBuilder): CdmElement[] {
  return readLines(source.text)
    .map(trimLine)
    .filter((line): line is SourceLine => line !== null)
    .map((line) =>
      builder.node(
        "p",
        [builder.text(line.content)],
        source.rangeFromTextOffsets(line.start, line.contentEnd),
      ),
    );
}

function trimLine(line: SourceLine): SourceLine | null {
  const withoutLeadingWhitespace = line.content.trimStart();
  const content = withoutLeadingWhitespace.trimEnd();
  if (content.length === 0) {
    return null;
  }
  const start = line.start + line.content.length - withoutLeadingWhitespace.length;
  return { start, contentEnd: start + content.length, content };
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
