# CleoDoc 资料解析与切片设计

状态：TXT/Markdown 解析及资料导入连接已实现；结构切片、Chunk 入库和索引尚未实现

更新日期：2026-08-08

本文定义导入资料从原始文件到纯文本 Chunk 的处理规则。CDM 的正式文档协议见 [CDM 设计](./CDM_DOCUMENT_FORMAT_DESIGN.md)，Chunk 的数据库结构见[数据库设计](./DATABASE_DESIGN.md)，FTS、Embedding、混合检索和引用使用见[本地 RAG 设计](./LOCAL_RAG_INGESTION_DESIGN.md)。

## 1. 当前范围

v0.1 只解析：

- UTF-8、GB2312、GBK 或 GB18030 编码的 TXT 纯文本。
- 上述编码的 Markdown 文档。

PDF、DOCX、网页、图片、OCR、音频和视频不进入当前实现范围。对应格式需要页码、文档节点、DOM、坐标或时间范围等不同的来源定位模型，等真实需求进入版本范围后再设计。

当前处理闭环为：

```text
外部 TXT/Markdown 字节
→ BOM / 严格 UTF-8 / GB18030 顺序检测并解码
→ 统一写为项目内 UTF-8 资料副本并计算 Hash
→ 解析为临时 CDM
→ 依据 CDM 结构选择切片边界
→ 提取纯文本与原文字节范围
→ Chunk 写入 SQLite
→ 可选保留临时 CDM 用于开发期 Debug
```

当前 `packages/document-ingestion` 已完成从项目内 UTF-8 TXT/Markdown 到临时 CDM、解析警告和 Node 原文字节范围的部分。解析器本身只返回内存结果，不读取项目目录、不访问 SQLite，也不处理外部编码。CleoDoc `MaterialService` 在导入边界检测并解码 UTF-8、GB2312、GBK 或 GB18030，将内容统一为 UTF-8 后调用解析器，并把临时 CDM XML 写入 `.cleo/derived/documents/<source-id>.cdm.xml` 供开发期检查；Chunker 后续消费内存解析结果。

## 2. 数据职责

### 2.1 原始资料

导入后位于 `materials/` 的 UTF-8 TXT/Markdown 副本是项目事实源。用户选择的外部文件不会被修改，但 CleoDoc 不依赖其原路径继续存在：

- 解析、切片或索引失败不能修改原件。
- 数据库和索引损坏后可以重新读取原件生成。
- 项目副本是否发生变化，以其 UTF-8 字节的 SHA-256 为准。
- 修改时间和文件大小只能用于快速检查，不能代替内容 Hash。

### 2.2 临时 CDM

解析器使用 CDM 作为结构化中间格式，以表达标题、段落、列表、引用、代码和表格等边界。临时 CDM 用于：

- 让不同格式的解析器向 Chunker 提供相同结构。
- 帮助 Chunker 选择自然边界。
- 传递当前解析任务中的来源位置。
- 保存开发期可视化和 Debug 样本。

临时 CDM 不是导入资料的长期引用目标。完成 Chunk 入库后可以删除；FTS、Embedding、RAG 和引用回溯都不能依赖该文件或其 Node ID。开发阶段可以暂存于：

```text
.cleo/derived/documents/<source-id>.cdm.xml
```

当前实现使用该路径。删除资料时同步删除对应临时 CDM；它仍保持“可删除、可重建、非运行必需”的语义。

### 2.3 Chunk

Chunk 是 SQLite 中的纯文本检索投影，不是 CDM 文档，也不是新的事实源：

- `content` 只保存规范化纯文本。
- 结构、来源和顺序进入独立数据库字段。
- 不保存 XML、CDM Node ID、Markdown 标记或 CDM 片段。
- 不为每个 Chunk 创建文件。
- Chunk 直接通过 `source_id`、`start_offset` 和 `end_offset` 回到原始资料。

## 3. Source Hash 与更新检测

现有 `sources.content_hash` 保存项目内规范化 UTF-8 资料副本的 SHA-256，`sources.index_status` 表示当前 Chunk 是否仍对应这份项目副本。不同输入编码解码为完全相同的 Unicode 内容时视为重复资料。

检查资料时：

1. 读取当前原始文件并计算 SHA-256。
2. 与数据库中的 `content_hash` 比较。
3. 相同表示当前 Chunk 仍对应原件。
4. 不同则将 Source 标记为需要重新解析，现有位置和引用视为过期。
5. 文件不存在时将 Source 标记为失效。

检测到变化后不能立即覆盖数据库中的旧 `content_hash`。只有新的解析与 Chunk 集合全部成功写入后，才在同一受控提交过程中切换 Source Hash。否则会出现“新 Hash 配旧位置”的错误状态。

当前不区分格式变化和语义变化：即使用户只修改 Markdown 加粗符号，原始文件 Hash 也会变化。资料更新后的重新切片、新旧 Chunk 对齐和引用迁移暂缓设计。

## 4. 解析器边界

解析器负责：

- 识别受支持格式。
- 接收已经统一为 UTF-8 的文本；外部编码检测和解码由导入边界负责。
- 恢复标题、段落、列表、引用、代码和表格结构。
- 生成通过 CDM Schema 校验的临时 CDM。
- 为结构节点保留其项目内 UTF-8 资料副本字节范围。
- 输出解析器版本、状态和警告。

解析器不负责：

- 生成 FTS 或 Embedding。
- 将数据库内部 ID 写进 CDM。
- 把临时 CDM 作为长期引用锚点。
- 修改或修复原始资料。
- 通过模型猜测当前范围内无法可靠识别的结构。

解析器可以使用底层文本和 Markdown 词法库，但第三方 AST 不能成为 CleoDoc 的持久化格式或 Chunker 的公共协议。

当前公共结果为：

```ts
interface ParsedDocument {
  format: "text" | "markdown";
  parserVersion: string;
  status: "ok" | "partial";
  sourceByteLength: number;
  cdm: CdmDocument;
  cdmXml: string;
  nodeRanges: CdmNodeSourceRange[];
  warnings: ParseWarning[];
}
```

`nodeRanges` 是本次解析任务的内存 Sidecar，通过临时 Node ID 连接 CDM Node 与项目内 UTF-8 资料副本的字节范围。它不是 CDM 属性，也不进入长期 Chunk 或引用协议。临时 Node ID 仍按 CDM 规则随机生成；解析确定性比较忽略这些随机 ID，只比较结构、文字、警告、Node 顺序和字节范围。Chunk 内容与边界不得依赖随机 ID。

## 5. 样式处理

导入资料解析不提供样式保留模式，也不定义 `InlineStyleMode`。纯展示样式始终被丢弃，只保留内部文字。

例如：

```markdown
这是 **非常重要的** 内容。
```

解析为：

```xml
<p id="7k3m9qx2vc">这是非常重要的内容。</p>
```

解析器丢弃加粗、斜体、高亮、颜色和其他纯展示样式，但仍需保留影响结构或语义的信息：

- 标题和段落。
- 有序、无序及嵌套列表。
- 引用块。
- 链接文字和目标。
- 行内代码和代码块。
- 表格的行列内容。
- 显式换行。
- 删除线等可能表达内容失效的语义。

丢弃样式不等于用正则删除 `*` 或 `**`。解析器必须先识别 Markdown 转义、代码范围和强调语法，再展平纯样式节点，避免破坏字面星号、公式或代码。

该限制只适用于导入资料。AI 和用户创作的正式 CDM 仍可使用 CDM Schema 允许的 Mark。

## 6. TXT 解析

外部 TXT 先按“BOM → 严格 UTF-8 → GB18030”的顺序检测；`gb2312` 和 `gbk` 显式选项统一交给 GB18030 兼容解码器。用户可以通过 `--encoding` 覆盖自动判断，项目副本始终写为 UTF-8。之后采用简单、确定的首版规则：

- 每个 `CRLF`、`LF` 或 `CR` 都是段落边界，每个非空文本行转换为独立 `<p>`。
- 每行转换前移除首尾 Unicode 空白字符，包括普通空格、Tab、不换行空格和全角空格；行内空白保持不变。
- 清理后为空的行只作为间隔，不生成空 `<p>`。
- 不根据长度、数字或标点猜测标题。
- 文件名可以成为 Source 标题，但不自动写入正文。
- 无法解释的文字原样保留，不能静默丢失。
- 相同输入、解析器版本和配置产生相同的文本结构。

换行符本身不进入段落文字。`CRLF` 视为一个边界，`LF` 和 `CR` 各自视为一个边界；每个段落的字节范围只覆盖清理后保留的该行文字，不包含被移除的首尾空白或行尾换行符。字节范围对应项目内 UTF-8 资料副本。UTF-8 BOM 不进入项目副本，因此也不进入 CDM 文字或位置计算。

## 7. Markdown 解析

当前实现以 CommonMark 为基础，只增加 GFM 表格扩展，不默认启用整套 GFM。结构映射包括：

| Markdown | 临时 CDM |
|---|---|
| 标题 | `<h1>`—`<h6>` |
| 段落 | `<p>` |
| 有序列表 | `<ol>` |
| 无序列表 | `<ul>` |
| 列表项 | `<li>` |
| 引用块 | `<blockquote>` |
| 行内代码 | `<code>` |
| 代码块 | `<pre><code>` |
| 链接 | `<a>` |
| 表格 | `<table>`、`<tr>`、`<th>`、`<td>` |

Markdown 内嵌 HTML 只能接受 CDM 白名单允许的文本语义。脚本、事件处理属性和不安全标签不能进入临时 CDM；被拒绝的内容必须转义为文字或产生明确解析警告，不能静默执行或丢失。

当前实现不解释任何 Markdown 内嵌 HTML，而是将其转义为普通文字并返回 `RAW_HTML_PRESERVED_AS_TEXT` 警告。Markdown 图片不进入 CDM 资源模型，只保留替代文字并返回警告。加粗和斜体等纯样式节点直接展平；链接保留为带 `href`/`title` 的 `<a>`，行内代码和代码块保留为 `<code>` 与 `<pre><code>`。代码语言和 Meta 暂未进入 CDM，存在时返回警告但不丢失代码正文。

## 8. 切片规则

首版采用“结构优先、长度约束、确定性输出”的切片，不使用额外模型做语义切片。

处理顺序为：

1. 根据临时 CDM 识别标题、段落、列表、引用、代码块和表格边界。
2. 优先保持完整段落、列表项和连续对话。
3. 将原文中连续、较短的相邻结构合并到目标长度。
4. 超大结构按子结构、段落、句子，最后才按安全字符边界拆分。
5. 不把原文中不连续的两个范围拼成同一个 Chunk。
6. 不复制上级标题或生成原文不存在的上下文标题。
7. 对相同输入、解析器版本、Chunker 版本和配置产生相同的 Chunk 内容与边界。

现有基线建议为每个资料 Chunk 400–800 个中文字符，最终参数通过固定中文资料样本验证，不写死在数据库 Schema 中。重叠窗口、多粒度 Chunk、父子 Chunk 和模型语义切片属于后续优化。

## 9. Chunk 纯文本

`knowledge_chunks.content` 只包含可检索纯文本：

- 删除 CDM/XML 标签。
- 删除 Markdown 格式符号。
- 保留有效可见文字。
- 规范化普通空白和换行。
- 代码保留内容，不保留围栏。
- 列表转换为确定性的纯文本列表项。
- 表格转换为确定性的纯文本行列表示。
- 不拼入标题路径、Source ID、位置或数据库元数据。

Chunk 内容可以与原始字节范围在字面上不同，例如 Markdown 的 `**文字**` 在 Chunk 中变成 `文字`；两者必须仍表达同一连续原文范围的内容。

链接目标如何进入 Chunk 纯文本仍需在实现样本中确认，不能因为丢弃样式而静默丢失具有检索价值的 URL。

## 10. 原文定位

TXT 和 Markdown Chunk 使用：

```text
start_offset
end_offset
```

两者表示项目内 UTF-8 资料副本字节的左闭右开范围：

```text
[start_offset, end_offset)
```

规则为：

- `start_offset >= 0`。
- `end_offset > start_offset`。
- `end_offset` 不得超过 Source 的字节长度。
- 一个 Chunk 必须对应一个连续原文范围。
- 位置只有在磁盘文件 Hash 与 `sources.content_hash` 一致，且 Source 索引状态为可用时有效。
- 行号和列号在展示时根据原文临时计算，不作为持久化定位身份。

`start_offset` 和 `end_offset` 是 v0.1 针对 TXT、Markdown 的明确方案，不是所有资料格式的通用 Locator。未来 PDF、DOCX、网页、音频等进入范围后，再按格式增加页码、坐标、节点路径或时间范围；当前不预先加入空置的通用 Locator JSON。

## 11. 写入与失败顺序

一次导入或重建采用：

1. 校验项目路径和 Source 范围。
2. 读取原始文件并计算 SHA-256。
3. 在数据库事务外解析临时 CDM并通过 Schema 校验。
4. 在数据库事务外生成全部纯文本 Chunk。
5. 校验每个 Chunk 的内容、顺序和原文字节范围。
6. 用短事务写入 Source、Chunk 和 FTS，并切换 Source Hash。
7. 事务成功后再调度 Embedding。

解析或切片失败时保留原始资料和旧的可用 Chunk，不写入半套新结果。开发期 CDM Debug 文件的写入失败不能破坏已经完成的数据库提交。

## 12. 当前验收

- TXT 和 Markdown 可以稳定解析为无纯样式的临时 CDM。
- 相同输入和配置产生相同 Chunk 内容及边界。
- `knowledge_chunks.content` 不包含 CDM 或 Markdown 格式标记。
- 每个 Chunk 都能通过 Source 与字节范围打开原始资料对应位置。
- 删除临时 CDM 后，FTS、Embedding、RAG 和引用回溯仍可正常工作。
- Source Hash 不一致时，旧位置被识别为过期，不能继续宣称精确定位有效。
- 解析和切片失败不损坏原件，也不替换旧的可用索引。

其中 TXT/Markdown 到临时 CDM 的解析验收已经由固定单元样本覆盖，包括 UTF-8 BOM、中文与 Emoji 字节范围、CRLF、标题、段落、引用、列表、链接、代码、GFM 表格、样式展平、原始 HTML 转义、图片降级和非法 UTF-8。Chunk、数据库切换及完整索引验收仍未完成。

## 13. 暂缓问题

- 链接目标进入纯文本的规范。
- Chunk 长度、句子边界和重叠的最终参数。
- 资料更新后的新旧 Chunk 对齐。
- 重新切片时 `chunk_id` 的继承或迁移。
- 历史 Chunk 与已有引用的保留和修复。
- PDF、DOCX、网页、图片、音频和视频的来源定位模型。
