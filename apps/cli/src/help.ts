export const helpText = `CleoDoc v0.1 CLI

用法：
  cleo init <directory> [--name <作品名>]
  cleo open <directory>
  cleo status [--project <directory>]
  cleo config

  cleo provider list
  cleo provider test <openai-compatible|ollama> [--base-url <url>]

  cleo chat [--project <directory>] --model <model> [选项]
    --provider <id>       覆盖软件配置选择的 Provider
    --base-url <url>      覆盖 Provider 地址
    --connect-timeout-ms <ms>     临时覆盖连接/首响应超时
    --stream-idle-timeout-ms <ms> 临时覆盖流连续无数据超时
    --generation-timeout-ms <ms>  临时覆盖单轮生成总时限
    --context-window-tokens <n>    临时覆盖模型上下文窗口
    --max-output-tokens <n>        临时覆盖模型最大输出长度
    --debug               将原始 LLM 请求/响应、Token 和校验错误写入本地日志
    --conversation <id>   继续指定对话
    --new                 不恢复最近对话，开始新对话
    --prompt <text>       单轮非交互调用
    --save <path>         单轮调用成功后保存结果
    --overwrite           明确允许覆盖 --save 指定的文档

  cleo document list [--project <directory>]
  cleo document show <document-id|path> [--project <directory>]
  cleo document create <path> [--content <text>] [--project <directory>]
  cleo document save-last <path> [--overwrite] [--project <directory>]
  cleo document delete <document-id|path> [--project <directory>]

  cleo material add <file> [--title <标题>] [--source <来源>] [--tags <标签列表>]
    [--encoding <utf-8|gb2312|gbk|gb18030>]
  cleo material add --stdin [--title <标题>] [--format <text|markdown>]
  cleo material list [--project <directory>]
  cleo material show <material-id> [--project <directory>]
  cleo material rename <material-id> <title> [--project <directory>]
  cleo material remove <material-id> [--project <directory>]

  cleo index status [--project <directory>]
  cleo index rebuild [--project <directory>]
  cleo search <query> [--scope material] [--limit <数量>] [--project <directory>]

  cleo embedding model
  cleo embedding test <zh|en> <text> [--query]

  cleo conversation list [--project <directory>]
  cleo conversation show <conversation-id> [--project <directory>]

交互式 chat 命令：
  /save manuscript/chapter-001.md
  /read manuscript/chapter-001.md
  /documents
  /history
  /compact
  /retry-compact
  /sessions
  /session <序号>
  /context
  /instructions
  /instructions history
  /instructions restore <revision>
  /new
  /help
  /exit

环境变量：
  CLEODOC_API_KEY   当前 Provider 的 API Key（不会写入配置或项目）
  OPENAI_BASE_URL   OpenAI-compatible API 根地址
  OLLAMA_BASE_URL   Ollama 地址，默认 http://127.0.0.1:11434
  CLEODOC_MODEL     未提供 --model 时使用的模型
  CLEODOC_LLM_CONNECT_TIMEOUT_MS      连接/首响应超时
  CLEODOC_LLM_STREAM_IDLE_TIMEOUT_MS  流连续无数据超时
  CLEODOC_LLM_OVERALL_TIMEOUT_MS      单轮生成总时限
  CLEODOC_MODEL_CONTEXT_TOKENS        模型上下文窗口 Token 数
  CLEODOC_MODEL_MAX_OUTPUT_TOKENS     模型最大输出 Token 数
  CLEODOC_HOME      CLI 状态目录；只保存当前项目路径，不保存密钥
`;
