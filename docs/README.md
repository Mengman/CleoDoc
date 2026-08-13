# CleoDoc 文档索引

本目录以已经完成的 **v0.1 CLI 基线** 为共同起点，记录 v0.2 现有能力桌面 UI 化目标、顺延到 v0.3 的创作工作室方向以及仍未确定的问题。开发过程中的临时方案、已经完成的重构清单和废弃接口不再作为设计文档保留。

## 阅读顺序

1. [产品需求](./PRD.md)：产品定位、版本边界和验收目标。
2. [技术架构](./TECHNICAL_ARCHITECTURE.md)：v0.1 系统基线与 v0.2 目标架构。
3. [开发计划](./DEVELOPMENT_PLAN.md)：唯一的实施状态、任务顺序和发布门来源。
4. 按工作领域阅读下方专题设计。

## 文档职责

| 文档 | 唯一职责 | 不负责 |
| --- | --- | --- |
| [PRD](./PRD.md) | 产品行为、用户价值、版本范围和验收口径 | 代码结构、表字段和实施日志 |
| [技术架构](./TECHNICAL_ARCHITECTURE.md) | 模块边界、数据所有权、运行时和 v0.2 演进方向 | 逐项开发状态、完整字段字典 |
| [开发计划](./DEVELOPMENT_PLAN.md) | v0.1 基线状态、v0.2 顺序、依赖和验收门 | 重复领域设计 |
| [数据库设计](./DATABASE_DESIGN.md) | 当前 Schema v10、表字段、索引、事务和受支持升级 | RAG 算法与产品流程 |
| [会话压缩设计](./SESSION_COMPACTION_DESIGN.md) | Session 预算、压缩、切换、恢复和历史回查 | 通用 Tool 规范 |
| [Tool Call 设计](./TOOL_CALL_DESIGN.md) | Tool 契约、Catalog、Runtime、审批及所有现有 Tool | 文档编辑模型和 RAG 排序算法 |
| [CDM 设计](./CDM_DOCUMENT_FORMAT_DESIGN.md) | CleoDoc 统一文档协议、标签、Node ID 和开放 Schema 问题 | 导入流水线和数据库存储 |
| [文档处理设计](./文档处理设计.md) | v0.3 节点编辑、Draft 写入和文本统计 | CDM 标签白名单 |
| [资料解析与切片](./DOCUMENT_PARSING_AND_CHUNKING_DESIGN.md) | TXT/Markdown 到临时 CDM、ChunkDraft 和原文定位 | Embedding、检索排序和表字段 |
| [本地 RAG 与索引](./LOCAL_RAG_INGESTION_DESIGN.md) | Chunk 入库、FTS、Embedding、向量与混合检索 | 解析器细节和 Tool 通用协议 |
| [软件配置设计](./SOFTWARE_CONFIGURATION_DESIGN.md) | 默认 YAML、用户覆盖和配置生效规则 | Provider 协议实现 |
| [桌面 UI 结构设计](./DESKTOP_UI_STRUCTURE_DESIGN.md) | Windows-titlebar、全局导航、功能区，以及作品/资料共享文档工作区和聊天窗口的结构关系 | 视觉样式、尺寸、具体控件和未授权的 UI 元素 |
| [Embedding 基准](./EMBEDDING_BENCHMARK_BASELINE.md) | 可复现的 CPU/GPU 测量记录 | 产品要求和路线图 |

## 当前基线

- 产品版本：v0.1 CLI MVP。
- 数据库：完整 Schema v10；支持完整 v8、v9 项目顺序前向升级。
- 文档事实源：当前作品使用 Markdown/JSON，资料保留原 TXT/Markdown 文件；CDM 是已实现最小 Core、尚未完成作品迁移的目标协议。
- 本地知识：TXT/Markdown 解析、Tokenizer 切片、FTS5、GGUF Embedding、sqlite-vec 精确向量检索和混合 RAG 已完成。
- Agent：OpenAI-compatible/Ollama、多轮 Tool Loop、Conversation 级 Runtime、Session 压缩、Reasoning 展示、ModelCall 审计和本地 RAG Tool 已完成。
- 发布：跨平台 CLI 打包和 v0.1 人工垂直闭环验收均已完成；当前进入 v0.2 Desktop UI 规划与实施。

## 未决事项的维护规则

未决问题保留在最接近其语义的专题文档中，不复制到多个文件：

- CDM 正式 v1 Schema、扩展标签和作品迁移：CDM 与文档处理设计。
- Chunk ID 在资料更新后的继承、混合语言多模型向量：资料解析与本地 RAG 设计。
- Generation 与 Message 的长期关系：数据库设计。
- 跨 Conversation 历史查询：PRD 与会话压缩设计。
- v0.2 Desktop UI 阶段、检查点和发布门：开发计划。
- v0.3 Draft、版本、Diff、知识图和阶段 Agent 的顺延范围：开发计划；正式实施顺序尚未冻结。

任何问题一旦确定，应直接更新对应专题文档并从“待确认”清单移除，不保留决策前后的过程记录。
