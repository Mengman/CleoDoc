import { AppError, type KnowledgeSourceLanguage } from "../../contracts/src/index.js";
import type { ChunkTokenizer } from "@cleodoc/document-ingestion";

import type { DisposableChunkTokenizer, MaterialTokenizerModel } from "./material-types.js";

export class MaterialTokenizerPool {
  private readonly opened = new Map<KnowledgeSourceLanguage, Promise<DisposableChunkTokenizer>>();

  constructor(
    private readonly models: Readonly<Record<KnowledgeSourceLanguage, MaterialTokenizerModel>>,
  ) {}

  get(language: KnowledgeSourceLanguage): Promise<ChunkTokenizer> {
    const existing = this.opened.get(language);
    if (existing !== undefined) return existing;
    const opened = this.open(language);
    this.opened.set(language, opened);
    return opened;
  }

  model(language: KnowledgeSourceLanguage): MaterialTokenizerModel {
    return this.models[language];
  }

  async close(): Promise<void> {
    const tokenizers = await Promise.allSettled(this.opened.values());
    this.opened.clear();
    await Promise.all(
      tokenizers.flatMap((result) =>
        result.status === "fulfilled" ? [result.value.dispose()] : [],
      ),
    );
  }

  private async open(language: KnowledgeSourceLanguage): Promise<DisposableChunkTokenizer> {
    const model = this.models[language];
    const tokenizer = await model.openTokenizer();
    if (
      tokenizer.modelId !== model.modelId ||
      tokenizer.modelRevision !== model.modelRevision ||
      tokenizer.maxInputTokens !== model.maxInputTokens
    ) {
      await tokenizer.dispose();
      throw new AppError("CONFIG_ERROR", `资料 ${language} Tokenizer 与模型配置不一致。`);
    }
    return tokenizer;
  }
}
