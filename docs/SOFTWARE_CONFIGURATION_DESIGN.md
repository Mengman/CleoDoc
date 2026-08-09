# CleoDoc 软件配置设计

> 状态：v0.1 已实现首版  
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
发行默认 YAML → 用户 YAML 的有效字段覆盖 → 完整 Schema 校验 → 业务服务参数注入
```

- 默认 YAML 缺失或无效属于软件安装错误，启动相关命令时返回 `CONFIG_ERROR`。
- 用户 YAML 不存在时创建只含 Schema 版本的最小文件，并使用默认配置；不复制全部默认值，避免阻止后续软件默认值正常升级。
- 用户 YAML 整体无法解析时使用全部默认配置，并显示警告。
- 用户配置按叶子字段校验；单项类型或取值错误只回退该项，不影响其他有效项。
- 未支持的配置项被忽略并显示警告，防止拼写错误静默生效。
- `softCompactionRatio < hardCompactionRatio` 等跨字段关系不成立时，相关字段一起回退到默认值。

底层 Project、Database、Material、Agent 和 Provider 服务不自行读取 YAML。CLI（未来是桌面应用的组合层）加载一次配置，再通过构造参数注入服务。

## 3. 当前默认配置

```yaml
schemaVersion: 1

llm:
  selectedProvider: openai-compatible
  selectedModel: null
  providers:
    openai-compatible:
      displayName: OpenAI-compatible
      baseUrl: https://api.openai.com/v1
      models:
        deepseek-v4-flash:
          displayName: DeepSeek V4 Flash
          contextWindowTokens: 1000000
          maxOutputTokens: 384000
    ollama:
      displayName: Ollama
      baseUrl: http://127.0.0.1:11434
      models: {}
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

`llm.providers`、LLM 模型能力表和 `rag.embedding.models` 由 CleoDoc 适配和发行，不要求普通用户维护。Embedding 模型条目保存模型身份、发行资源相对路径、最大输入 Token 和 Query 指令；不保存线程、llama.cpp Token Batch 或推理设备等模型运行参数。`rag.embedding.worker.chunkBatchSize` 只控制主线程与 Worker 之间每次投递和回传的 Chunk 数，默认 `16`，不表示多输入模型 Batch。资料切片硬上限直接使用主语言模型的 `maxInputTokens`，用户只可调整 `rag.chunking.splitSearchWindowRatio`。`rag.languageDetection.minBlockUnits` 是可由用户覆盖的资料语言检测下限，按“汉字字符数 + 英文单词数”计算，默认 `50`。用户配置首版允许选择 `selectedProvider`、`selectedModel`，以及覆盖超时、上下文策略、Agent、语言检测、Worker 任务批次、切片比例、资料大小、数据库等待和 Debug 等公开参数；不允许用用户 YAML 改写 Provider/模型能力目录或 Embedding 模型目录。

## 4. Provider、模型与密钥

- `contextWindowTokens` 和 `maxOutputTokens` 属于准确的 Provider + Model 能力条目，不是公共模型参数。
- CLI 的 `--context-window-tokens`、`--max-output-tokens` 及对应环境变量只用于未知模型调试和临时覆盖，不是普通用户的常规配置方式。
- Provider API Key 统一从 `CLEODOC_API_KEY` 读取，不把环境变量名称或密钥写入 YAML。
- OpenAI-compatible 与 Ollama 的 Base URL 可以由 CLI 或现有环境变量临时覆盖；默认地址来自发行配置。
- Thinking、Reasoning Effort、Temperature、单次生成 `maxTokens` 等参数暂不进入软件 YAML，因为不同 Provider 的接口语义尚未统一。
- Provider 适配层不得根据模型名称猜测上下文窗口，也不得静默切换 Provider 或模型。

## 5. 暂不配置的内容

- 当前字符 Token Estimator 是兼容兜底，将在接入 Provider/模型 Tokenizer 后废弃，因此不进入配置文件。
- `nextUserInputReserveTokens` 当前仍保留固定上限，并与 `nextUserInputReserveRatio` 共同计算。后续改为完全按照 `contextWindowTokens` 比例计算时，应删除固定值并同步更新 Session 压缩设计。
- 项目级配置尚未实现。资料切片属于 CleoDoc 的系统级 Baseline，不放进项目配置；有效切片配置仍必须参与索引版本判断。
