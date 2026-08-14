# CleoDoc 软件配置设计

> v0.1 基线：默认 YAML、用户字段覆盖、进程内只读快照
>
> 配置格式：YAML

## 1. 配置边界

CleoDoc 把“配置”和“运行状态”分开保存：

- 软件默认配置：随 CleoDoc 一起发行，作为唯一的代码外默认值来源。
- 用户软件配置：位于操作系统的 CleoDoc 配置目录，按字段覆盖默认配置。
- 应用状态：单独保存在 `state.yaml`，当前只记录最近打开的项目，不属于用户配置。
- 项目配置：未来保存在项目目录的 `.cleo/config.yaml`，只承载项目体验和个性化设置；当前尚未实现。

软件默认配置位于仓库的 `resources/config/software-default.yaml`。用户配置路径为：

- Windows：`%APPDATA%/CleoDoc/config.yaml`
- macOS：`~/Library/Application Support/CleoDoc/config.yaml`
- Linux：`$XDG_CONFIG_HOME/cleodoc/config.yaml`，未设置时为 `~/.config/cleodoc/config.yaml`
- 开发和测试可用 `CLEODOC_HOME` 覆盖配置目录。

发行和打包流程必须把 `resources/config/software-default.yaml` 一并包含在应用资源中。开发环境可用 `CLEODOC_DEFAULT_CONFIG` 临时指定默认配置文件。

## 2. 合并与错误处理

加载顺序固定为：

```text
发行默认 YAML → 用户 YAML 的有效字段覆盖 → 完整 Schema 校验 → 初始化进程级只读配置快照
```

- 默认 YAML 缺失或无效属于软件安装错误，启动相关命令时返回 `CONFIG_ERROR`。
- 用户 YAML 不存在时创建只含 Schema 版本的最小文件，并使用默认配置；不复制全部默认值，避免阻止后续软件默认值正常升级。
- 用户 YAML 整体无法解析时使用全部默认配置，并显示警告。
- 用户配置按叶子字段校验；单项类型或取值错误只回退该项，不影响其他有效项。
- 未支持的配置项被忽略并显示警告，防止拼写错误静默生效。
- `softCompactionRatio < hardCompactionRatio` 等跨字段关系不成立时，相关字段一起回退到默认值。

应用启动层只加载一次 YAML，并通过 `initializeSoftwareConfig()` 发布进程级配置快照。CLI 命令和 CleoDoc 组合模块在需要配置时直接调用 `getSoftwareConfig()`，不再把完整 `SoftwareConfig` 作为参数逐层传递。配置不会自动热更新；只有再次显式初始化才会替换当前快照。

这个全局入口只属于 CleoDoc 应用配置，不应成为所有领域包的隐式依赖。Project、Database、RAG、Document Ingestion、Agent 和具体 Provider 适配器不自行读取 YAML。`packages/model-providers` 中的 `ProviderService` 作为 Provider 配置和运行时的统一应用服务，可以消费进程级配置快照；它向 CLI、Desktop 暴露当前 Provider/模型信息和配置修改，向 `ChatService` 暴露当前执行快照及其 `send` 边界，不暴露具体 Provider 实例和密钥。

## 3. 当前默认配置

```yaml
schemaVersion: 1
gpuAcceleration: true

llm:
  selectedProvider: openai-compatible
  selectedModel: deepseek-v4-flash
  modelParameters:
    reasoningEnabled: true
    reasoningEffort: medium
  providers:
    openai-compatible:
      displayName: OpenAI-compatible
      baseUrl: https://api.deepseek.com
      models:
        deepseek-v4-flash:
          displayName: DeepSeek V4 Flash
          contextWindowTokens: 1000000
          maxOutputTokens: 384000
          reasoningSupported: true
          reasoningEfforts: [low, medium, high]
  timeouts:
    connectionMs: 60000
    streamIdleMs: 120000
    overallMs: 1200000

context:
  nextUserInputReserveTokens: 32768
  nextUserInputReserveRatio: 0.05
  safetyMarginRatio: 0.05
  softCompactionRatio: 0.75
  hardCompactionRatio: 0.9

agent:
  maxToolRounds: 8
  compaction:
    summaryTargetRatio: 0.01
    summaryTargetMinTokens: 512
    summaryTargetMaxTokens: 8000
    segmentSummaryMaxTokens: 2000
    segmentPayloadTargetRatio: 0.8
    splitSearchWindowRatio: 0.6
    resultMinLimitTokens: 2048
    resultMaxLimitTokens: 32000
    resultTargetMultiplier: 4

rag:
  retrieval:
    candidateLimit: 20
    rrfK: 60
    contextMaxCharacters: 12000
    maxSourceRatio: 0.6
  languageDetection:
    minBlockUnits: 50
  embedding:
    worker:
      # Chunk 任务投递/回传批次，不是 llama.cpp Token Batch
      chunkBatchSize: 16
    models:
      zh:
        modelId: bge-small-zh-v1.5-q8_0
        modelName: BAAI/bge-small-zh-v1.5
        revision: v1.5-q8_0
        modelFile: models/embedding/bge-small-zh-v1.5-q8_0.gguf
        maxInputTokens: 512
        queryPrefix: "为这个句子生成表示以用于检索相关文章："
      en:
        modelId: bge-small-en-v1.5-q8_0
        modelName: BAAI/bge-small-en-v1.5
        revision: v1.5-q8_0
        modelFile: models/embedding/bge-small-en-v1.5-q8_0.gguf
        maxInputTokens: 512
        queryPrefix: "Represent this sentence for searching relevant passages: "
  chunking:
    splitSearchWindowRatio: 0.75

materials:
  maxImportBytes: 10485760

database:
  busyTimeoutMs: 5000

debug:
  enabled: false
```

顶层 `gpuAcceleration` 是用户可覆盖的 CleoDoc 全局 GPU 加速开关。启用后，所有支持 GPU 的功能都应消费这个统一开关，不能在 RAG、Embedding 或其他子系统中再定义同义配置。当前完整 Embedding Runtime 与 `vocabOnly` Tokenizer 会向 `node-llama-cpp` 传入 `gpu: "auto"` 和 `gpuLayers: "auto"`，由运行库按当前平台、可用预编译绑定和硬件自动选择。关闭时保持 CPU Baseline；Apple Silicon 仍加载发行包可用的 Metal 绑定，但以 `gpuLayers: 0` 禁止模型层卸载。

`llm.providers`、LLM 模型能力表和 `rag.embedding.models` 由 CleoDoc 适配和发行，不要求普通用户维护。Provider 正式适配模块完成前，Desktop 只允许覆盖 `llm.providers.openai-compatible.baseUrl`，并固定选择发行目录中的 `deepseek-v4-flash`，不得通过用户 YAML 改写其他 Provider 字段或模型能力。Embedding 模型条目保存模型身份、发行资源相对路径、最大输入 Token 和 Query 指令；不保存线程或 llama.cpp Token Batch 等模型运行参数。`rag.embedding.worker.chunkBatchSize` 只控制主线程与 Worker 之间每次投递和回传的 Chunk 数，默认 `16`，不表示多输入模型 Batch。资料切片硬上限直接使用主语言模型的 `maxInputTokens`，用户只可调整 `rag.chunking.splitSearchWindowRatio`。`rag.languageDetection.minBlockUnits` 是可由用户覆盖的资料语言检测下限，按“汉字字符数 + 英文单词数”计算，默认 `50`。`rag.retrieval` 保存召回候选数、RRF 常数、证据字符预算和单一来源占比。其他公开用户配置继续允许覆盖全局 GPU 加速、超时、上下文策略、Agent、检索、语言检测、Worker 任务批次、切片比例、资料大小、数据库等待和 Debug 等参数。

## 4. Provider、模型与密钥

- `ProviderService` 是 CLI 和 Desktop 的统一 Provider 入口：读取和修改当前 Provider、模型及模型参数，并通过一次操作内不可变的执行快照向 `ChatService` 提供流式模型调用。Conversation 和压缩任务不保存当前选择。
- 具体 Provider 和 API Key 仅在 `ProviderService` 内部组合；同一有效配置复用同一 Provider 实例，配置或密钥修改后使缓存失效。
- `contextWindowTokens` 和 `maxOutputTokens` 属于准确的 Provider + Model 能力条目，不是公共模型参数。
- CLI 的 `--context-window-tokens`、`--max-output-tokens` 及对应环境变量只用于未知模型调试和临时覆盖，不是普通用户的常规配置方式。
- CLI 继续从 `CLEODOC_API_KEY` 读取 API Key；Desktop 将 API Key 交给 Electron Main，通过 `safeStorage` 使用 Windows DPAPI、macOS Keychain 或 Linux 系统密钥服务保护后持久化。
- 加密结果保存在 CleoDoc 用户配置目录的独立凭据文件中，不进入软件 YAML、项目、数据库、日志或 Git。Renderer 只能读取“已配置”状态和密钥字符长度，用等长掩码表达保存状态，不能读取密钥内容。
- Linux 选中 `basic_text` 或系统安全凭据能力不可用时，Desktop 必须拒绝持久化 API Key，不得自动退化为明文保护。
- 当前 Desktop 调试入口固定为 `openai-compatible` 和 `deepseek-v4-flash`；Base URL 由用户填写并写入用户 YAML。CLI 的 Base URL 仍可由参数或现有环境变量临时覆盖。
- 当前统一模型参数包括 `reasoningEnabled` 和 `reasoningEffort`；`ProviderService` 在切换模型或修改参数时依据模型能力表校验。Temperature、单次生成 `maxTokens` 等业务请求参数暂不进入用户模型配置。
- Provider 适配层不得根据模型名称猜测上下文窗口，也不得静默切换 Provider 或模型。

## 5. 暂不配置的内容

- 当前字符 Token Estimator 是兼容兜底，将在接入 Provider/模型 Tokenizer 后废弃，因此不进入配置文件。
- `nextUserInputReserveTokens` 当前仍保留固定上限，并与 `nextUserInputReserveRatio` 共同计算。后续改为完全按照 `contextWindowTokens` 比例计算时，应删除固定值并同步更新 Session 压缩设计。
- 项目级配置尚未实现。资料切片属于 CleoDoc 的系统级 Baseline，不放进项目配置；有效切片配置仍必须参与索引版本判断。
