# CleoDoc

CleoDoc 是本地优先的中文小说 AI 主笔。v0.1 先以 CLI 验证 LLM 创作、资料管理和本地 RAG 核心闭环。

当前实现已覆盖开发计划的步骤 1–5，并提前交付了受控的本地文档 Tool Loop：CLI 工程、项目与 SQLite、OpenAI-compatible/Ollama Provider、对话记录、生成内容保存、资料管理，以及由 LLM 列出、读取和经用户确认后写入项目文档。全文与向量 RAG 检索将在后续步骤实现。

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

Markdown/JSON 是作品事实源，`.cleo/project.sqlite` 保存对话和可重建运行状态。

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

步骤 5 支持粘贴文本以及 UTF-8 编码的 TXT、Markdown 文件：

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
- [开发计划](./docs/DEVELOPMENT_PLAN.md)
- [编码 Agent 指南](./AGENTS.md)
