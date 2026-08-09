# CleoDoc 本地 RAG 与索引设计

状态：上游 TXT/Markdown 解析与 Baseline ChunkDraft 已实现；Chunk 入库、索引与 RAG 尚未实现

更新日期：2026-08-09

本文定义 CleoDoc 如何使用已经生成的纯文本 Chunk 建立本地全文、向量和混合检索，并把 LLM 使用的证据回溯到原始资料。重点回答三个问题：

1. SQLite、FTS5 和 Embedding 分别承担什么职责。
2. RAG Tool 向 LLM 暴露哪些 Chunk 信息。
3. 正式文档中的引用如何通过 Chunk 回到原始 TXT/Markdown。

TXT/Markdown 如何解析为临时 CDM、如何丢弃样式并生成纯文本 Chunk，见[资料解析与切片设计](./DOCUMENT_PARSING_AND_CHUNKING_DESIGN.md)。统一内部文档协议见 [CDM 设计](./CDM_DOCUMENT_FORMAT_DESIGN.md)；数据库表字段见[数据库设计](./DATABASE_DESIGN.md)；LLM 如何选择和调用 Tool，见 [Tool Call 技术设计](./TOOL_CALL_DESIGN.md)；实施顺序只在[开发计划](./DEVELOPMENT_PLAN.md)维护。

## 1. 设计目标

CleoDoc 的 RAG 面向单机桌面应用以及未来可能的移动端、嵌入式设备，不依赖常驻服务器或独立向量数据库服务。设计必须满足：

- 原始资料永远可以独立读取，索引损坏不会损坏资料。
- Chunk、全文索引和向量都可以从原始资料重建。
- 当前 TXT/Markdown Chunk 能通过 Source 与字节范围定位回原件。
- Source Hash 变化时，旧位置和引用不会继续伪装成有效定位。
- FTS5 失败时可以重建，Embedding 失败时全文检索仍然可用。
- 项目检索严格隔离，不返回未显式链接的其他项目内容。
- 存储结构不绑定某个尚未稳定的向量扩展。
- 在普通个人设备上控制安装包体积、内存、磁盘、CPU 和电量消耗。

## 2. 核心结论

当前设计确认以下决策：

1. **导入资料的原始文件是最高权威来源。** 临时 CDM 可以在 Chunk 入库后删除，RAG 和引用回溯不能依赖临时 CDM 或其 Node ID。
2. **Chunk 是纯文本数据库投影。** `knowledge_chunks.content` 不保存 CDM、Markdown、标题路径或格式信息。
3. **Chunk 直接回溯原件。** `source_id` 关联 Source，`start_offset` 与 `end_offset` 定位当前 TXT/Markdown 的连续原文字节范围。
4. **不为每个 Chunk 创建文件。** 正式 Chunk 正文和定位字段直接保存在 SQLite；当前 `.cleo/derived/chunks/<source-id>.chunks.json` 只是按 Source 汇总的临时检查产物，不是 RAG 存储层。
5. **FTS5 与 Chunk 使用 External Content 模式。** FTS 索引通过整数 `rowid` 引用 `knowledge_chunks`，不另存一份业务正文。
6. **Embedding 与 Chunk 分表。** 一个 Chunk 可以针对不同模型生成不同向量，模型升级不要求修改 Chunk。
7. **v0.1 不依赖向量扩展。** 向量先以 `Float32Array` BLOB 保存在 SQLite，经元数据过滤后在 Worker 中执行精确余弦检索。
8. **需要 SQLite 向量扩展时，优先试验 sqlite-vec；vec1 保持观察。** 两者都只能位于 `VectorIndex` 适配层后面，不能渗透到领域类型和事实文件。

## 3. 总体数据流

```mermaid
flowchart TD
    SOURCE["原始 TXT / Markdown"] --> PARSER["解析与临时 CDM"]
    PARSER --> CHUNKER["结构切片与纯文本提取"]
    CHUNKER --> CHUNKS["SQLite knowledge_chunks"]
    CHUNKS --> FTS["SQLite FTS5"]
    CHUNKS --> EMBEDDER["本地 Embedding Worker"]
    EMBEDDER --> VECTORS["SQLite chunk_embeddings"]
    FTS --> FUSION["混合召回与 RRF"]
    VECTORS --> FUSION
    FUSION --> EVIDENCE["证据包与 ContextManifest"]
```

数据职责如下：

| 数据 | 推荐位置 | 性质 | 是否可重建 |
|---|---|---|---|
| CleoDoc 原生 CDM 文档 | 项目文档目录（具体扩展名待定） | 可移植事实源 | 否 |
| 导入或现存 Markdown/TXT | `materials/` 等项目目录 | 原始事实源 | 否 |
| 导入资料的临时 CDM XML | `.cleo/derived/documents/<source-id>.cdm.xml`（开发期暂定） | 可选解析 Debug 产物 | 是 |
| 导入资料的临时切片预览 | `.cleo/derived/chunks/<source-id>.chunks.json`（开发期暂定） | 按 Source 汇总的可选 Debug 产物 | 是 |
| Chunk 正文和定位信息 | SQLite `knowledge_chunks` | 检索投影 | 是 |
| FTS5 倒排索引 | SQLite `knowledge_chunk_fts*` | 查询索引 | 是 |
| Embedding | SQLite `chunk_embeddings` | 模型派生物 | 是 |
| 向量虚拟表或 ANN 索引 | SQLite 扩展表 | 可选加速索引 | 是 |

`.cleo/derived` 的具体目录名可以在实现时调整，但其语义必须保持为“可删除、可重建的派生物”，不能成为原始资料的唯一副本。

## 4. 解析与 Chunk 输入边界

资料解析和切片由[资料解析与切片设计](./DOCUMENT_PARSING_AND_CHUNKING_DESIGN.md)负责。RAG 层只接受已经通过校验并写入 SQLite 的 Chunk：

```ts
interface KnowledgeChunk {
  chunkId: string;
  sourceId: string;
  ordinal: number;
  content: string;
  startOffset: number;
  endOffset: number;
  chunkerVersion: string;
}
```

这里：

- `content` 只能是规范化纯文本，不含 CDM、XML、Markdown 或标题路径。
- `startOffset`、`endOffset` 是项目内规范化 UTF-8 TXT/Markdown 资料副本的连续字节范围。
- Source Hash 保存在现有 `sources` 表，不重复进入每个 Chunk。
- 临时 CDM 和 Node ID 不进入 RAG 公共类型，也不参与长期引用回溯。
- `chunk_rowid` 可以在数据库内部关联 FTS 和向量，但不能出现在 Tool Result 或 CDM 中。

Chunk 是 FTS、Embedding、混合召回和 LLM 证据包的候选单元。它不是事实源，也不创建独立文件；数据库损坏时从原始资料重新解析和切片。

## 5. Chunk 身份与引用边界

当前把 `chunk_id` 视为公开、稳定、不透明的标识：

- 应用重启、FTS 重建和 Embedding 重建不改变 `chunk_id`。
- 临时 CDM 删除不改变已经入库的 Chunk。
- 已使用的 `chunk_id` 不得静默复用到另一段内容。
- 资料更新和重新切片时如何继承 Chunk ID 暂缓设计。

需要严格区分：

- **索引重建**：从已有 Chunk 重建 FTS 或 Embedding，不影响身份。
- **Chunk 重建**：重新解析原始资料并切片，可能影响身份，当前不实现自动迁移。

Chunk 引用通过 `source + chunk_id` 找到数据库记录，再以该记录的 `start_offset`、`end_offset` 和 Source 的 `content_hash` 回到原始 TXT/Markdown。长期引用不能指向临时 CDM Node、FTS Row ID、Embedding 行或绝对文件路径。

## 6. SQLite 与 FTS5

### 6.1 Chunk 内容表

Source 和 Chunk 的完整字段说明以[数据库设计](./DATABASE_DESIGN.md)为准。RAG 依赖的最小 Chunk 关系为：

```sql
CREATE TABLE knowledge_chunks (
  chunk_rowid     INTEGER PRIMARY KEY,
  chunk_id        TEXT NOT NULL UNIQUE,
  source_id       TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  ordinal         INTEGER NOT NULL,
  content         TEXT NOT NULL,
  start_offset    INTEGER NOT NULL,
  end_offset      INTEGER NOT NULL,
  chunker_version TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE (source_id, ordinal)
);
```

这是设计草案，不表示表已经进入当前数据库 Schema。真正实现时需要与项目、来源、访问范围和删除语义一并评审后提升 Schema 版本。

### 6.2 External Content FTS

```sql
CREATE VIRTUAL TABLE knowledge_chunk_fts USING fts5(
  content,
  content = 'knowledge_chunks',
  content_rowid = 'chunk_rowid',
  tokenize = 'trigram'
);
```

这里的 External Content 指 FTS5 从同一个 SQLite 数据库中的 `knowledge_chunks` 读取正文，不是引用文件系统里的 Chunk 文件。FTS5 的 `*_data`、`*_idx`、`*_docsize` 和 `*_config` 仍会存在，它们是倒排索引的内部影子表，不是重复的业务表。

写入、更新和删除必须通过同一个 Repository 事务同时维护内容表与 FTS。FTS 校验失败时可以执行 `rebuild`，不能反向用 FTS 内容恢复事实源。

### 6.3 中文检索

- 普通中文片段优先使用 FTS5 trigram。
- 两字人名、短别名、编号和精确专名不能只依赖 trigram，应使用标题、人名、别名等精确字段索引补充。
- 查询必须先限制当前项目和允许的资料范围，再召回正文。
- Tool Result 返回公开的 `source`、`chunk_id`、资料标题和纯文本 `content`，不返回临时 CDM、标题路径、字节范围、SQLite Row ID、内部 FTS Rank 或实现表名。

## 7. Embedding 与向量存储

### 7.1 数据模型

Embedding 与 Chunk 分离，避免模型升级污染正文和 FTS：

```sql
CREATE TABLE embedding_models (
  embedding_model_id   TEXT PRIMARY KEY,
  provider             TEXT NOT NULL,
  model_name           TEXT NOT NULL,
  revision             TEXT NOT NULL,
  dimensions           INTEGER NOT NULL,
  element_type         TEXT NOT NULL,
  distance_metric      TEXT NOT NULL,
  normalization        TEXT NOT NULL,
  model_content_hash   TEXT NOT NULL,
  created_at           TEXT NOT NULL
);

CREATE TABLE chunk_embeddings (
  chunk_rowid          INTEGER NOT NULL,
  embedding_model_id   TEXT NOT NULL,
  content_hash         TEXT NOT NULL,
  embedding            BLOB NOT NULL,
  created_at           TEXT NOT NULL,
  PRIMARY KEY (chunk_rowid, embedding_model_id)
);
```

`embedding_model_id` 标识包含具体 Revision 的一次模型配置；同名模型升级后创建新标识，不覆盖旧向量。向量由 `@huggingface/transformers` 在 Worker 中运行本地 ONNX 模型生成，以紧凑 `Float32Array` BLOB 保存，不使用 JSON 数组。原始空间约为 `Chunk 数量 × 维度 × 4 字节`，尚未包含 SQLite 页、索引和元数据开销。

### 7.2 v0.1 查询方式

v0.1 采用可解释、容易验证的精确搜索：

1. SQLite 按当前项目、资料类型、访问范围和 Source 状态过滤候选。
2. 只读取候选 Chunk 对应模型的向量 BLOB。
3. Worker 计算精确余弦距离并返回 Top-K。
4. 与 FTS 结果融合后再读取需要展示和发送给模型的正文。

该方案没有 ANN 训练、索引参数和原生扩展打包问题，适合先验证一部作品约数万 Chunk 的真实延迟和召回。超过当前架构定义的项目级软上限时记录指标，而不是预先引入复杂索引。

### 7.3 可替换接口

```ts
interface VectorIndex {
  upsert(records: VectorRecord[]): Promise<void>;
  remove(chunkIds: string[]): Promise<void>;
  search(
    query: Float32Array,
    filter: VectorFilter,
    limit: number,
  ): Promise<VectorHit[]>;
  rebuild(model: EmbeddingModelInfo): Promise<void>;
}
```

`VectorIndex` 的公共类型只表达向量、过滤、距离和结果，不出现 `vec0`、`vec1`、`nprobe`、`nbucket`、`codesize` 等扩展专属参数。

## 8. sqlite-vec 与 SQLite vec1 的选择

截至 2026-08-07，两者都是 SQLite 扩展，不是独立向量数据库服务。

| 维度 | sqlite-vec | SQLite vec1 |
|---|---|---|
| 维护方 | Alex Garcia 社区项目 | SQLite 官方项目 |
| 当前定位 | pre-v1 alpha；提供 `vec0`、距离函数和多种语言绑定 | 0.7；提供精确 NN 与基于 IVFADC/OPQ 的 ANN |
| Node.js 集成 | 有 NPM 绑定和 Node.js 文档 | 官方文档以编译 C 扩展为主，需要自行完成 Node/Electron 集成与分发 |
| 平台目标 | 桌面、移动端、WASM 和嵌入式平台已有明确支持路径 | C 实现可移植，x86/ARM 有 SIMD；官方仍说明测试不足，WASM SIMD 等能力尚在路线图中 |
| 向量类型 | Float32、Int8、Bit | 当前以 Float32 为主 |
| ANN | 当前 `vec0` 是穷举式精确 KNN，不提供可作为基线的 ANN | IVFADC/OPQ，需要训练、参数选择和通常必需的重排 |
| CleoDoc 当前结论 | 若基准证明需要扩展，优先试验 | 保持观察，成熟后通过相同接口评测 |

最终选型：

- **现在：SQLite 普通表 + Float32 BLOB + Worker 精确余弦。** 这是 v0.1 正式设计。
- **第一候选扩展：sqlite-vec。** 原因是 Node.js、移动端和多平台分发路径更直接，但必须锁定确切版本，因为其官方仍标记为 pre-v1。
- **后续候选：SQLite vec1。** 官方维护是长期优势，但当前测试、打包和 ANN 训练复杂度不适合作为 CleoDoc 首版基础设施。
- 引入任一扩展前，必须用相同数据集比较 Top-K 召回、P50/P95 延迟、索引时间、内存、磁盘和各目标平台安装包增量。
- 某个平台无法加载扩展时必须自动使用基础精确实现；不能导致资料无法搜索。

官方参考：

- [SQLite FTS5](https://www.sqlite.org/fts5.html)
- [sqlite-vec](https://alexgarcia.xyz/sqlite-vec/)
- [sqlite-vec API Reference](https://alexgarcia.xyz/sqlite-vec/api-reference.html)
- [SQLite vec1 概览](https://sqlite.org/vec1/doc/trunk/doc/vec1.md)
- [SQLite vec1 User Manual](https://sqlite.org/vec1/doc/trunk/doc/vec1intro.md)

## 9. 混合检索

```mermaid
flowchart LR
    QUERY["用户或 Agent 查询"] --> FILTER["项目与权限过滤"]
    FILTER --> EXACT["精确名称与别名"]
    FILTER --> FTS["FTS5 召回"]
    FILTER --> VECTOR["向量召回"]
    EXACT --> RRF["去重与 RRF 融合"]
    FTS --> RRF
    VECTOR --> RRF
    RRF --> RERANK["任务相关重排"]
    RERANK --> BUDGET["上下文预算装箱"]
    BUDGET --> MANIFEST["ContextManifest"]
```

- 精确名称、FTS 和向量召回是并列能力，不用向量检索替代全文检索。
- 融合默认使用 RRF，避免直接比较 BM25 分数和余弦距离。
- 去重只合并重复展示，不删除不同来源的证据关系。
- 只有最终进入模型上下文的 Chunk 才记录为 ContextManifest 使用项。
- 检索失败不得阻止用户查看原始资料；只有显式选中的证据可以发送给远程模型。

### 9.1 RAG Tool Result

RAG Tool 向 LLM 返回纯文本证据和允许公开的身份：

```json
{
  "source": "src_triton_guide",
  "chunk_id": "chk_8r2v5x9m",
  "source_title": "Triton 编程指南",
  "content": "Triton 是一个用于编写高性能 GPU 内核的语言和编译器。"
}
```

默认不向 LLM 返回 Source Hash、原文字节范围、SQLite Row ID、FTS Rank、绝对路径、临时 CDM 或 Node ID。LLM 只需要复制 Tool 明确返回的 `source` 与 `chunk_id`，但模型仍可能填写不存在或不匹配的值，因此写入正式文档时必须重新验证。

### 9.2 Reference 与原文回溯

正式 CDM 支持三种引用：

- LLM Chunk 引用：同时存在 `source` 和 `chunk_id`。
- LLM 文献引用：只有 `source`。
- 用户文献引用：只有 `source`，用户不接触 Chunk 信息。

Chunk 引用的回溯链路为：

```text
<reference source + chunk_id>
→ knowledge_chunks
→ sources
→ 校验当前原始文件 SHA-256
→ [start_offset, end_offset)
→ 原始 TXT / Markdown
```

CleoDoc 自动检查 Source、Chunk、归属关系、项目范围和原始文件 Hash。不存在、归属错误或来源已经变化的引用保留为无效或过期状态，不能静默删除或改指其他 Chunk。

数据库关系正确不代表 Chunk 在语义上支持 LLM 写出的陈述。语义检查由用户主动发起；未来 GUI 的“引用修复”会让 LLM根据当前文字重新检索并提出修改建议，用户也可以直接修改文献、删除 `chunk_id` 将其降级为文献引用，或删除整个引用。完整标签语义见 [CDM 设计](./CDM_DOCUMENT_FORMAT_DESIGN.md)。

## 10. 生命周期与故障恢复

### 10.1 新增或修改资料

1. 安全保存或读取项目内原始资料。
2. 计算原始文件 SHA-256，并与 Source 当前 `content_hash` 比较。
3. 在数据库事务外解析临时 CDM 并生成纯文本 Chunk。
4. 校验每个 Chunk 的连续字节范围。
5. 以短事务切换 Source Hash、Chunk 集合和 FTS。
6. 在 Worker 中生成缺失或过期的 Embedding。
7. 校验 Source 与 Chunk 状态后写回向量并切换可用索引代次。

检测到原始 Hash 变化后，新 Chunk 全部成功前不能覆盖 Source 的旧 `content_hash`。资料更新后的 Chunk ID 继承和已有引用迁移暂不实现。

### 10.2 删除资料

删除资料时，同一个受控流程必须删除当前来源的 Chunk、FTS 项、Embedding 和其他派生缓存，并列出依赖该来源的设定、章节或任务。不得只删除原始文件而留下仍可检索的孤立内容。

### 10.3 中断和损坏

- 解析、切片或 Embedding 在数据库写事务外运行。
- 应用退出后，未完成任务恢复为 pending 或 failed，不写入半成品索引。
- FTS 或向量表损坏时从已有纯文本 Chunk 重建。
- Chunk 表损坏时从原始资料重新解析和切片；开发期临时 CDM不是重建前提。
- 导入资料的临时 CDM 损坏或删除不影响现有检索和引用回溯。
- 原始资料损坏或缺失时停止重建并向用户报告，不用派生 Chunk 冒充原件。

## 11. 版本范围

### v0.1

- 将 TXT、Markdown 解析为可删除的临时 CDM，固定丢弃纯展示样式。
- 实现基于块级段落结构的确定性 Baseline Chunk：超长块向前寻找自然边界递归拆分，同一标题区域内的小块按最大长度贪心向前合并，并保留连续原文字节范围。
- 实现 `knowledge_chunks`、FTS5、Embedding BLOB 和精确余弦检索。
- 实现 FTS 与向量的混合召回、RAG Tool 和 ContextManifest。
- 实现 `source + chunk_id` 引用校验及 TXT/Markdown 原文回溯。
- 不要求 sqlite-vec 或 vec1，不实现 ANN。

### 后续版本

- 实现 CleoDoc 自有 DOCX、带文本层 PDF 和网页快照适配器。
- 评估表格、脚注、图片说明和复杂阅读顺序。
- 在固定基准证明必要后试验 sqlite-vec。
- vec1 达到可接受的稳定性和跨平台分发条件后再参与同一基准。
- 扫描 PDF OCR、模型驱动语义切块和复杂版面恢复继续保持在首版范围之外。

## 12. 验证标准

### 解析

- 固定 TXT/Markdown 样本的标题、段落、列表、引用、代码和表格边界输出可重复。
- 纯展示样式不会进入临时 CDM 或 Chunk 文本。
- 每个可检索文本都能通过 Source Hash 与字节范围定位回原始文件。
- 不支持或无法可靠解析的结构产生 warning 或 partial，不静默丢失。
- 同一原件和相同解析器版本生成相同的规范化 CDM。

### Chunk

- 不跨章节错误拼接，不在普通情况下截断句子或连续对话。
- 同一输入和同一配置生成相同 Chunk。
- `content` 只包含纯文本，不保存 CDM、Markdown、Node ID 或标题路径。
- 每个 Chunk 对应项目内规范化 UTF-8 资料副本中的一个连续字节范围。
- Chunk 可以从原始资料重新解析和切片，不需要 Chunk 文件或持久化 CDM。

### 检索

- 精确名称、两字人物名、近义描述和正文片段都能命中相应证据。
- 关键设定测试集 Top-10 召回率不低于 90%。
- 10–15 万字正文加常规资料库保持交互级响应。
- 项目检索不返回未显式链接的其他项目资料。
- Embedding 不可用时 FTS5 仍可工作。
- 删除资料后无法再从 FTS 或向量结果中检索到该资料。
- RAG Tool 只向 LLM 返回公开的 Source、Chunk ID、资料标题和纯文本证据。
- Chunk 引用能够回到原件；Source Hash 变化时引用被标记为过期。

### 向量后端评测

- 使用同一 Chunk、模型、查询和金标准比较所有后端。
- 同时记录 Recall@10、MRR、P50/P95 延迟、索引时间、峰值内存、磁盘空间和安装包增量。
- 桌面和未来移动端分别测量，不能用服务器成绩替代终端设备成绩。
- 新后端必须能够全量重建并随时回退到基础精确实现。
