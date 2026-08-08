# CleoDoc

CleoDoc 是本地优先的中文小说 AI 主笔。v0.1 先以 CLI 验证 LLM 创作、资料管理和本地 RAG 核心闭环。

当前 v0.1 已完成 CLI 与项目基础、OpenAI-compatible/Ollama Provider、多轮对话与生成内容保存、资料管理、Session 上下文压缩与历史回查、Reasoning 流式展示与 ModelCall 审计、数据库原生项目指令，以及受控的本地文档 Tool Loop。统一知识索引、Embedding、混合 RAG、`ContextManifest` 和 RAG Tool 尚未实现；唯一的详细进度来源是[开发计划](./docs/DEVELOPMENT_PLAN.md)。

## 环境要求

- Node.js 22.13–26（推荐 Node.js 24 LTS）
- npm 10 或更高版本
- OpenAI-compatible API Key，或者本机 Ollama

## 安装与验证

```powershell
npm install
npm run typecheck
npm test
npm run build
```

查看 CLI 帮助：

```powershell
npm run cleo -- help
```

## 创建项目

```powershell
npm run cleo -- init .\my-novel.cleo --name "我的小说"
npm run cleo -- status
```

`init` 会创建：

```text
my-novel.cleo/
├─ cleo.project.json
├─ manuscript/
├─ materials/
└─ .cleo/
   ├─ project.sqlite
   ├─ blobs/
   └─ models/
```

当前 CLI 以 Markdown/JSON 保存作品事实；目标统一文档格式为 CDM，过渡方案尚未实施。`.cleo/project.sqlite` 保存对话和可重建运行状态。

## 使用 OpenAI-compatible Provider

PowerShell 当前窗口中设置 Key（CLI 不会保存它）：

```powershell
$env:OPENAI_API_KEY="你的 API Key"
$env:CLEODOC_MODEL="你要使用的模型 ID"
```

如果使用其他兼容服务：

```powershell
$env:OPENAI_BASE_URL="https://your-provider.example/v1"
```

例如 DeepSeek：

```powershell
$env:OPENAI_BASE_URL="https://api.deepseek.com"
$env:OPENAI_API_KEY="你的 DeepSeek API Key"
$env:CLEODOC_MODEL="deepseek-chat"
```

流式请求采用三个独立超时：连接或首响应默认 60 秒、连续无流数据默认 120 秒、单轮生成总时限默认 20 分钟。收到响应后不会继续使用连接超时；每收到一个原始流数据块都会重置空闲超时。可以按网络和模型速度覆盖：

```powershell
$env:CLEODOC_LLM_CONNECT_TIMEOUT_MS="90000"
$env:CLEODOC_LLM_STREAM_IDLE_TIMEOUT_MS="180000"
$env:CLEODOC_LLM_OVERALL_TIMEOUT_MS="1800000"
```

也可以仅对一次命令指定：

```powershell
npm run cleo -- chat --connect-timeout-ms 90000 --stream-idle-timeout-ms 180000 --generation-timeout-ms 1800000
```

测试连接并开始交互：

```powershell
npm run cleo -- provider test openai-compatible
npm run cleo -- chat
```

对话完成后输入：

```text
/save manuscript/chapter-001.md
```

也可以直接委托主笔整理并保存，例如：

```text
请总结我们刚才确定的人物设定，并保存到 manuscript/character-notes.md
```

模型会调用项目工具；读取当前项目文档不额外询问，任何创建或覆盖写入都会显示目标路径、内容长度和预览，并要求输入 `y` 明确批准。拒绝后不会写入。该能力应在 `npm run cleo -- chat` 交互模式中使用；`--prompt` 单轮模式默认不批准模型发起的本地写入。

进入交互式聊天时会显示最近 5 条记录。输入 `/resume 1` 可以恢复列表中的第 1 条；输入 `/history` 会打开更多历史记录，在真实终端中使用上下键选择、按 Enter 恢复、按 `q` 返回聊天。使用 `/new` 开始新对话。

长对话达到默认 75% 上下文预算后会在完整回复保存完毕后自动压缩。压缩期间可以继续编辑输入，但 Enter 不会提交，草稿也不会自动发送。可使用 `/context` 查看预算，`/compact` 手动压缩，`/retry-compact` 重试失败任务，`/sessions` 和 `/session <序号>` 审计内部 Session。模型上下文窗口默认 1,000,000 Token，并预留 384,000 Token 模型输出、32,768 Token 下一次用户输入和 5% 安全余量；因此约在当前 Payload 392K Token 时自动压缩，在 477K Token 时阻止继续提交。可通过 `--context-window-tokens` 或 `CLEODOC_MODEL_CONTEXT_TOKENS` 明确覆盖上下文窗口，小窗口下固定预留会按比例缩放。

项目指令以 SQLite Revision 为唯一事实源，不读取作品项目目录中的 `AGENTS.md`。使用 `/instructions` 查看当前指令，`/instructions history` 查看历史，`/instructions restore <revision>` 经确认后恢复旧内容。模型也可以通过受控 Tool 读取、追加、局部替换或全量替换项目指令；写入必须经过用户批准。

需要检查模型上下文占用或响应协议时可以使用 `npm run cleo -- chat --debug`。Debug 模式会把主笔和上下文压缩实际发送的 HTTP 请求 body、脱敏后的请求 Header、响应状态/响应 Header，以及 Provider 解析前收到的原始 SSE 或 NDJSON 数据块写入 UTF-8 日志；响应结束后还会记录输入 Context Token、输出 Token、结束原因、本地估算值、完整拼接的压缩摘要和最低完整性校验错误。终端只显示本次日志文件的绝对路径，不再输出原始协议内容，因此不会干扰聊天交互。

每次启动 Debug Chat 都会在 `<项目根目录>/.cleo/logs/` 下创建独立的 `cleodoc-debug-<时间>-<进程>.log`。`.cleo/` 默认不进入 Git，日志也不写入 SQLite。原始请求日志包含当前轮发送给模型的聊天、摘要和项目上下文，可能含有作品正文或资料；API Key、Authorization、Cookie 等鉴权 Header 会替换为 `<redacted>`。排查完问题后应关闭 `--debug`，分享日志前仍应检查其中的作品内容。

API 超时只会终止本轮请求，不会退出聊天；CLI 会区分连接/首响应超时、响应流空闲、总生成时限和上游 HTTP 超时。本轮用户消息和此前记录已经写入项目，可以稍后继续尝试。

也可以在聊天外查看全部历史：

```powershell
npm run cleo -- conversation list
npm run cleo -- conversation show <conversation-id>
```

也可以执行可脚本化的单轮生成和显式保存：

```powershell
npm run cleo -- chat --prompt "写一个约 800 字的悬疑小说开场" --save manuscript/chapter-001.md
```

若目标文档已经存在，单轮模式必须显式增加 `--overwrite`；交互模式会再次询问确认。

## 使用 Ollama

先在 Ollama 中准备模型，然后运行：

```powershell
npm run cleo -- provider test ollama
npm run cleo -- chat --provider ollama --model qwen3:8b
```

## 文档命令

```powershell
npm run cleo -- document list
npm run cleo -- document show manuscript/chapter-001.md
npm run cleo -- document create manuscript/notes.md --content "# 章节笔记"
npm run cleo -- document save-last manuscript/chapter-002.md
npm run cleo -- document delete manuscript/notes.md
```

交互对话中使用 `/read manuscript/chapter-001.md`，可明确把已保存文档加入后续对话。

## 资料管理

当前资料管理支持粘贴文本以及 UTF-8 编码的 TXT、Markdown 文件：

```powershell
npm run cleo -- material add .\references\railway.md --title "铁路资料" --source "地方志" --tags "历史,铁路"
Get-Content .\notes.txt | npm run cleo -- material add --stdin --title "访谈笔记"
npm run cleo -- material list
npm run cleo -- material show <material-id>
npm run cleo -- material rename <material-id> "新标题"
npm run cleo -- material remove <material-id>
```

导入内容保存在 `materials/`，可移植元数据保存在 `sources/metadata/`。SQLite 中的 `sources` 表是可重建投影；打开资料服务时会根据元数据校准。相同内容哈希只保留一份资料，即使文件名不同也不会重复导入。单份资料上限为 10 MiB。

## 安全约束

- API Key 仅从环境变量读取，不写入配置、项目、日志或 Git。
- 生成结果只有在用户执行保存命令，或在交互模式明确批准 LLM 的 `write_project_document` Tool Call 后，才写入正文。
- 所有正文路径限定在项目的 `manuscript/` 内，并拒绝路径穿越和符号链接。
- LLM 只能通过受控工具列出、分段读取和写入当前项目文档；工具参数经过 Schema 校验，循环最多执行 8 轮。
- 文档使用临时文件、同步和原子替换保存；SQLite 失败不会覆盖已保存 Markdown。
- 资料原文和元数据是事实源；SQLite 资料投影可以从项目文件重建。

## 项目文档

- [产品需求](./docs/PRD.md)
- [技术架构](./docs/TECHNICAL_ARCHITECTURE.md)
- [数据库设计与当前实现](./docs/DATABASE_DESIGN.md)
- [开发计划](./docs/DEVELOPMENT_PLAN.md)
- [会话上下文压缩设计](./docs/SESSION_COMPACTION_DESIGN.md)
- [Tool Call 技术设计](./docs/TOOL_CALL_DESIGN.md)
- [文档处理设计](./docs/文档处理设计.md)
- [本地 RAG 文档摄取与索引设计](./docs/LOCAL_RAG_INGESTION_DESIGN.md)
- [CleoDoc Document Model（CDM）设计](./docs/CDM_DOCUMENT_FORMAT_DESIGN.md)
- [编码 Agent 指南](./AGENTS.md)
