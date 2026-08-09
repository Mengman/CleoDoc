import { getCdmTextContent, type CdmDocument, type CdmElement } from "@cleodoc/cdm";

import { DocumentIngestionError } from "./errors.js";

export type DetectedDocumentLanguage = "zh" | "en";

export interface LanguageDetectionOptions {
  readonly minBlockUnits: number;
}

const EXCLUDED_CONTAINERS = new Set([
  "li",
  "pre",
  "code",
  "table",
  "tr",
  "th",
  "td",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);
const LANGUAGE_ORDER: readonly DetectedDocumentLanguage[] = ["zh", "en"];

export function detectDocumentLanguages(
  document: CdmDocument,
  options: LanguageDetectionOptions,
): DetectedDocumentLanguage[] {
  if (!Number.isInteger(options.minBlockUnits) || options.minBlockUnits < 1) {
    throw new DocumentIngestionError("INVALID_LANGUAGE_OPTIONS", "资料语言检测参数无效。");
  }

  const weights: Record<DetectedDocumentLanguage, number> = { zh: 0, en: 0 };
  visit(document.root, options.minBlockUnits, weights);
  const detected = LANGUAGE_ORDER.filter((language) => weights[language] > 0).sort(
    (left, right) =>
      weights[right] - weights[left] ||
      LANGUAGE_ORDER.indexOf(left) - LANGUAGE_ORDER.indexOf(right),
  );
  return detected.length === 0 ? ["zh"] : detected;
}

function visit(
  element: CdmElement,
  minBlockUnits: number,
  weights: Record<DetectedDocumentLanguage, number>,
): void {
  if (EXCLUDED_CONTAINERS.has(element.name)) return;

  if (element.name === "p") {
    addBlock(getCdmTextContent(element), minBlockUnits, weights);
    return;
  }
  if (element.name === "blockquote" && !hasDescendantParagraph(element)) {
    addBlock(getCdmTextContent(element), minBlockUnits, weights);
    return;
  }
  for (const child of element.children) {
    if (child.type === "element") visit(child, minBlockUnits, weights);
  }
}

function addBlock(
  content: string,
  minBlockUnits: number,
  weights: Record<DetectedDocumentLanguage, number>,
): void {
  const hanCharacters = content.match(/\p{Script=Han}/gu)?.length ?? 0;
  const englishWords = content.match(/[A-Za-z]+(?:['’][A-Za-z]+)*/gu)?.length ?? 0;
  if (hanCharacters + englishWords <= minBlockUnits || hanCharacters === englishWords) return;
  if (hanCharacters > englishWords) weights.zh += hanCharacters;
  else weights.en += englishWords;
}

function hasDescendantParagraph(element: CdmElement): boolean {
  return element.children.some(
    (child) => child.type === "element" && (child.name === "p" || hasDescendantParagraph(child)),
  );
}
