# CleoDoc 编码 Agent 指南

本文件适用于整个仓库。它用于约束参与 CleoDoc 开发的 AI 编码 Agent。详细需求和设计以以下文档为准：

- [产品需求](./docs/PRD.md)
- [技术架构](./docs/TECHNICAL_ARCHITECTURE.md)
- [数据库设计与当前实现](./docs/DATABASE_DESIGN.md)
- [开发计划](./docs/DEVELOPMENT_PLAN.md)
- [CleoDoc Document Model（CDM）设计](./docs/CDM_DOCUMENT_FORMAT_DESIGN.md)
- [资料解析与切片设计](./docs/DOCUMENT_PARSING_AND_CHUNKING_DESIGN.md)
- [本地 RAG 与索引设计](./docs/LOCAL_RAG_INGESTION_DESIGN.md)
- [软件配置设计](./docs/SOFTWARE_CONFIGURATION_DESIGN.md)

修改架构、版本范围或数据语义时，必须同步更新相关文档，不能只修改代码或本文件。发现文档冲突时，不要自行扩大范围；先遵循已经明确的版本边界，并向用户说明冲突。

## 1. 产品定位

CleoDoc 是 AGPLv3、免费、本地优先的中文小说 AI 主笔，不是通用型 Agent，也不是传统的“AI 辅助编辑器”。用户是在委托一位专业主笔完成作品，并在构思、评审和最终阅读阶段参与决策。

产品的两个长期核心是：

1. 作品 Agent：研究、策划、创作、检查和修订。
2. 本地知识系统：管理资料、正文、设定、人物、事件、时间线、伏笔和证据。

正文和知识资产是产品主体；聊天只是委托、解释、决策和评审入口。不得把产品退化为套壳聊天应用或单纯资料问答工具。

## 2. 当前版本边界

### v0.1：CLI 核心 MVP

当前优先实现 v0.1。在 CLI 验收通过前，不主动开发 Electron、React、TipTap 或其他 GUI 能力。

v0.1 按重要性排序只有三个核心目标：

1. 调用 LLM API，与模型沟通，并将生成结果安全保存为项目文档。
2. 资料管理：添加、删除、查看、编辑创作资料。
3. LLM 通过受控的本地 RAG Tool 检索资料和正文，再继续创作。

核心闭环必须能够通过 CLI 完整演示：

```text
创建项目 → 添加资料 → 建立索引 → 与 LLM 对话
→ LLM 调用本地检索 → 查看引用证据 → 保存生成文档
→ 重启 CLI → 基于已保存内容继续创作
```

v0.1 明确不做：Electron、React、TipTap、Git 版本界面、语义 Diff、关系图、自动事实抽取、完整阶段审批、多人协作、云同步、OCR、ANN 向量索引和自动长篇生成。接口可以为后续能力预留，但不得因此阻塞核心闭环。

### v0.2：Electron 桌面产品

v0.2 在同一套 Core 上增加 Electron + React 工作室、TipTap 编辑器、Git 版本管理、文档语义 Diff、知识图、设定审批和可恢复的 Agent 工作流。

GUI 必须消费 v0.1 已验证的 Application Service；不得在 Renderer 中复制项目、数据库、RAG 或模型调用逻辑。

## 3. 架构不变量

- 使用 TypeScript 和 Node.js 构建模块化单体；Core 不依赖 Electron、React、DOM 或浏览器存储。
- CLI 和未来桌面端调用相同的 Application Service。
- CDM、领域 JSON 和导入的原始资料是目标可移植事实源。当前 CLI 已有的 Markdown/TXT 文档在 CDM 过渡方案实施前仍按现状保存，不能静默改写。
- SQLite 保存全文索引、向量、知识投影、任务状态和可重建缓存，但不是作品的唯一事实源。
- 索引损坏、Embedding 失败或应用中断不得损坏原始作品；缓存必须可以重建。
- 项目知识库完全隔离。禁止跨项目检索；个人资料必须经过显式链接才能被项目使用。
- 所有文件路径必须解析并校验在当前项目根目录内，防止路径穿越。
- 所有外部输入边界使用 Zod 或等价的显式 Schema 校验，包括 CLI 参数、项目文件、模型输出和后续 IPC。
- Provider 不得静默切换模型或供应商。
- 远程模型只接收当前任务选出的证据，不得默认上传整个项目。

建议保持以下代码边界：

```text
apps/cli             v0.1 命令入口
apps/desktop         v0.2 Electron 应用
packages/contracts   公共类型、Schema、错误码
packages/config      软件 YAML、用户覆盖、应用状态和配置路径
packages/cdm         CDM 协议、严格 XML、Schema、Node ID 和遍历
packages/document-ingestion TXT/Markdown、临时 CDM、结构切片和 ChunkDraft
packages/project     项目格式和安全文件读写
packages/database    SQLite、当前 Schema 基线和 Repository
packages/knowledge   资料与知识模型
packages/rag         Chunk/Source、FTS、Embedding、检索、融合和上下文组装
packages/agent       LLM Tool Loop；v0.2 扩展持久化工作流
packages/model-providers
packages/versioning  v0.2
packages/diff        v0.2
```

底层 package 不得反向依赖 `apps/cli`、`apps/desktop` 或 UI。

## 4. SQLite 与本地数据规则

- 优先使用 Node.js 内置 `node:sqlite` 和 SQLite FTS5。
- 写入采用单写入队列、短事务；模型调用、文档解析、Embedding 和 Diff 不得放在数据库写事务中。
- 使用 WAL、`busy_timeout`、外键约束和显式 Schema 版本标记；当前开发期数据库以技术架构文档规定的基线版本为准。
- 正文和资料先安全写入事实源，再更新 SQLite 投影。文件写入应采用临时文件、同步和原子替换等防损坏策略。
- Chunk、Embedding 和抽取结果必须绑定内容校验值与模型/算法版本。
- 修改文档时只更新发生变化的 Chunk。异步结果写回前必须再次校验来源版本，过期结果直接丢弃或重排队。
- 删除资料后，同步删除当前 SQLite 中的 FTS、向量和关联缓存；不得留下仍可被检索的孤立数据。
- 不把 SQLite BLOB、索引缓存或模型文件提交为项目的可移植事实源。

## 5. RAG 实现规则

采用自研的薄 RAG 编排层，不让 LangChain.js 或 LlamaIndex.TS 的内部对象成为领域模型或存储格式。

- `packages/cdm` 是不依赖 Project、Database、RAG、Agent、Electron、DOM 或 TipTap 的叶子协议包。
- Document Ingestion 依赖 CDM 和 RAG Contracts，输出纯文本 `ChunkDraft`，但不访问 SQLite。
- RAG Core 从 `ChunkDraft` 开始工作，不解析或持久化 CDM；CleoDoc 业务代码通过 `RagService` 使用 RAG，不直接访问其内部 Repository。

v0.1 检索路径为：

1. 按项目、资料类型和访问范围过滤。
2. 并行执行 FTS5 全文检索与向量语义检索。
3. 使用可测试的融合策略（默认 RRF）排序、去重。
4. 在上下文预算内组装证据包。
5. 在内存中组装只包含最终采用证据的 `RetrievalContext`。

本地 Embedding 使用 `node-llama-cpp` 加载 GGUF 模型，同一模型负责 Tokenize 与向量推理。v0.1 将 `Float32Array` 存为 SQLite BLOB，对过滤后的候选做精确余弦检索；不要提前引入独立向量数据库或 ANN 基础设施。向量索引必须放在可替换接口后面。

每条检索结果至少能解释：来源、原文范围、相关度和命中通道。测试必须覆盖精确名称、近义描述、正文召回、跨项目隔离和 `RetrievalContext` 组装。

## 6. LLM 与 Agent 规则

- v0.1 首先支持 OpenAI-compatible 和 Ollama Provider。
- API Key 只从环境变量或当前进程的交互输入读取，默认不明文持久化，不进入日志、项目或 Git。
- 统一处理流式文本、取消、Tool Call、Token 用量，以及鉴权、限流、超时和上下文超限错误。
- Tool 参数必须经过 Schema 校验；Tool 只能读取当前任务被授权的项目范围。
- Tool Loop 必须设置最大轮数、上下文预算、超时和取消信号，避免无限循环。
- LLM 生成内容不能直接覆盖正式文档。v0.1 需要用户明确执行保存或确认覆盖；v0.2 通过 ChangeSet 和审批应用。
- RAG Tool 接入模型调用后，远程调用应能够还原所用模型、参数和实际发送的检索证据；步骤 8 的普通检索结果不写入数据库。
- 日志默认不记录正文、资料原文、完整 Prompt、模型响应或密钥。

## 7. v0.2 版本与桌面约束

以下约束在开发 v0.2 时生效：

- 使用 Electron、React、TypeScript、TipTap/ProseMirror。
- Renderer 启用 sandbox、context isolation 和严格 CSP；关闭 Node integration。
- Renderer 不直接访问文件系统、SQLite、Git、模型密钥或原始 `ipcRenderer`。
- Preload 只暴露经过 Schema 校验的白名单 Typed IPC。
- Git 使用 isomorphic-git，对用户隐藏 Git 概念；用户只看到修改历史、命名版本、比较和恢复。
- 恢复历史通过创建新的恢复记录完成，不改写既有历史。
- 文档 Diff 以稳定 CDM Node ID、CDM 结构和中文句子/字符级差异为基础，不依赖视觉行号。
- 用户直接修改的正文具有较高权威，Agent 不得静默改回。

## 8. 编码与测试要求

- 按照当前已经确认的需求选择最简单、直接的设计；不要为尚未进入范围的假设需求过度设计，也不要增加不必要的抽象和封装。
- 防御性检查应针对真实的外部输入、已知失败路径或确实可能出现的业务状态；不要为业务上不可能发生的情况增加限制、分支和恢复逻辑。
- 单个源代码文件原则上不应超过 500 行。文件过长时应按照明确的功能职责拆分；确有必要的特殊情况可以例外，但应能说明不能合理拆分的原因。
- 先阅读现有实现、测试和 package scripts，再选择修改位置；不要创建重复服务或平行数据模型。
- 保持 TypeScript 类型严格，领域对象使用明确 ID、时间、作用域和版本字段，避免无约束的 `any`。
- 错误使用稳定的应用错误类型；面向用户的信息不得泄露密钥、任意绝对路径或底层堆栈。
- 文件路径和行为必须兼容 Windows、macOS、Linux，不硬编码路径分隔符或平台专属目录。
- 当前数据库基线是完整 Schema v9；全新数据库直接创建当前结构，只保留完整 v8→v9 前向迁移，v7 及更旧或高于 v9 的数据库必须拒绝且不得自动改写或删除。正式发布后的数据库 Schema 变化必须继续提供前向 migration。
- 新增功能需要相应单元或集成测试。修复缺陷时，优先添加能复现问题的回归测试。
- RAG 排序、去重、预算和隔离必须使用固定样例做确定性测试；远程模型调用在自动测试中应使用 fake Provider。
- 不为了通过测试降低数据隔离、路径检查、Schema 校验或内容保存安全性。
- 完成修改后，运行仓库已有的 format、lint、typecheck 和相关测试；如果脚本尚不存在，应明确说明，不能声称已经验证。

## 9. 变更完成标准

编码 Agent 在交付前必须确认：

1. 修改没有越过当前版本范围。
2. 原始文档或资料在失败路径下不会损坏。
3. 项目隔离和路径边界没有被绕过。
4. 新增索引和缓存可以从事实源重建。
5. RAG Tool 接入后，LLM 使用的检索证据可以还原；普通检索不持久化为审计日志。
6. 相关测试和静态检查已经运行，或明确列出未能运行的原因。
7. 产品行为、公共类型或架构发生变化时，相关文档已同步更新。
