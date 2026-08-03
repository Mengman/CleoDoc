# Draft 写入与文本统计技术设计

状态：设计已确认，尚未实现  
适用范围：v0.2 作品工作室；Core 能力必须独立于 Electron/React 实现  
最后更新：2026-08-03

本设计中的专用 Tool 必须遵循 [CleoDoc Tool Call 技术设计](./TOOL_CALL_DESIGN.md) 的通用原则。

## 1. 背景与问题

LLM 很难仅凭自身生成过程准确估计中文文稿的实际字数。在长篇创作测试中，模型给出的估算可能与实际结果相差一千字以上。CleoDoc 需要提供确定性的本地统计，让主笔知道“刚刚实际写了多少”，再由主笔判断是否继续写作、补充内容、修订或向用户询问。

这项能力不是字数约束器：

- 系统不根据目标字数截断、拒绝或自动重写模型输出。
- 普通对话不统计字数，也不向上下文持续注入无意义的计数信息。
- 统计结果只反馈已经成功写入 Draft 的内容，不能以流式片段或模型自报数字代替。

最初考虑过让模型先在聊天中输出文稿，再由系统识别并写入 Draft。该方式会让同一正文同时出现在聊天窗口和 Draft 页面，形成重复展示、重复存储语义和不清晰的事实来源。也考虑过自定义 `agent` 消息角色用于主动状态报告，但 Provider 协议并不普遍支持该角色，且标准 `tool` 结果已经能承担机器反馈。

最终采用直接 Tool Call：当主笔决定产出文稿时，不在 Assistant Content 中输出正文，而是直接调用 `write_draft`。正文只进入 Draft，Tool 返回精确统计，模型据此决定下一步。

## 2. 目标与非目标

### 2.1 目标

- 正文只在 Draft 工作区展示一次，不复制到聊天消息中。
- 对每次成功写入提供确定性的字符数、字数和标点符号数。
- 用紧凑 Tool Result 将统计反馈给模型，尽量少占用上下文。
- 允许模型在得到统计后自然地继续写、停止或向用户说明判断。
- 保持 Draft 写入可恢复、可审计、可重试，并保护已批准正文。
- 统计器和 Draft Application Service 可由 CLI 测试，并由未来 GUI 复用。

### 2.2 非目标

- 不要求模型在写作前严格满足指定字数。
- 不为普通聊天内容计算或展示文稿统计。
- 不通过 `finish_draft` 声明“写完”。模型停止调用 `write_draft` 即表示本轮不再写入。
- 不在本设计中确定最终自定义排版格式、章节总字数展示或数据库表结构。
- 不允许 `write_draft` 直接覆盖用户已经批准的正式正文。

## 3. 核心交互协议

### 3.1 单轮输出模式

每个 Assistant 轮次必须在以下模式中选择一种：

1. **沟通模式**：输出普通 Assistant Content，用于解释、评审、提问和交付说明；不调用 `write_draft`。
2. **文稿模式**：Assistant Content 为空，直接调用 `write_draft`，正文放在 Tool 参数的 `content` 中。

同一轮不得同时输出面向用户的正文和调用 `write_draft`。这能保证正文只出现在 Draft 页面，聊天区域只显示紧凑的写入状态卡片。

### 3.2 Tool Loop 结束条件

`write_draft` 成功后，标准 `tool` 角色把写入结果和统计返回给模型，Tool Loop 再给模型一个决策轮次：

- 需要继续写：再次调用 `write_draft`。
- 需要查询资料或正文：调用相应读取或 RAG Tool。
- 已完成当前工作：不再调用 Tool，输出简洁的交付说明。
- 需要用户判断：不再调用 Tool，说明实际结果和建议并提问。

不设计 `finish_draft`。如果模型认为文稿已经完成，它只需停止发起 `write_draft`。Draft 始终是当前可编辑的工作状态，不需要额外的“完成/重新打开”状态机。

Agent 回合遵循统一结束规则：

- 存在 Tool Call：继续 Tool Loop。
- 没有 Tool Call 且存在有效 Assistant Content：结束本轮并交还用户。
- Tool Call 和有效 Assistant Content 都不存在：视为无效模型输出。
- 达到最大轮数、总时限、费用上限或收到取消信号：中止本轮，不继续自动写入。

### 3.3 用户可见反馈

聊天窗口不展示 `write_draft.content`，只展示例如“已向第一章追加 1,684 字”的状态卡片。该卡片是本地 UI 投影，不创建自定义 LLM 消息角色。

模型不应把 Tool Result 当成用户发言，不要以“好的，你刚刚告诉我……”等对话格式复述机器状态。需要用户决策时，应直接给出创作判断，例如：

> 当前章节已经写到约 3,200 字，但人物冲突还没有充分展开。我建议继续补充两人的正面交锋，你希望我继续吗？

如果不需要用户决策，模型可以直接继续调用 `write_draft`，无需发送过渡性致谢或确认。

## 4. `write_draft` Tool 设计

### 4.1 输入契约

目标契约如下：

```ts
interface WriteDraftInput {
  documentId: string;
  operation: 'append' | 'replace' | 'patch';
  baseRevision: number;
  format: 'markdown-v1' | 'cleodoc-richtext-v1';
  content: string;
}
```

- `documentId` 是当前 Project 内经过授权的文档 ID，不接受任意文件路径。
- `operation` 的首个实现可以只支持 `append`，后续再增加 `replace` 和 `patch`。
- `baseRevision` 用于乐观并发检查，防止覆盖用户或其他任务的新修改。
- `format` 明确选择对应的格式解析器和文本提取器，格式版本不能靠内容猜测。
- `content` 是本次待写入的完整文稿内容；正文不再同时出现在 Assistant Content 中。

Tool 参数可能由 Provider 以多个流式增量返回。模型适配器必须先完整拼接同一个 Tool Call 的参数 JSON，再进行 Schema 校验和写入；未完成或无法解析的参数不得产生部分文档。

### 4.2 输出契约

首个版本至少返回本次写入的三项统计：

```ts
interface WriteDraftResult {
  status: 'written';
  documentId: string;
  revision: number;
  written: TextStatistics;
}
```

示例：

```json
{
  "status": "written",
  "documentId": "chapter-01",
  "revision": 4,
  "written": {
    "characters": 2017,
    "words": 1684,
    "punctuation": 225,
    "algorithmVersion": "cleodoc-text-statistics-v1"
  }
}
```

后续可以在确有产品需要时增加 `document` 字段，返回写入后整篇文档的总统计。首个版本不把章节总字数作为必需条件。

Tool Result 必须紧凑，不重复正文、Prompt 或长篇解释。结果使用标准 `tool` 角色进入当前 Tool Loop；聊天 UI 可将其渲染为状态卡片，但不得伪装成用户消息。

### 4.3 写入语义

- `write_draft` 只修改可恢复的工作 Draft，不直接覆盖已批准正文或作品 Canon。
- 一次成功调用同时产生新 Draft Revision 和该次写入统计；不能出现“文档已写入但结果仍报告失败”的不确定状态。
- 文件或 Draft 事实源使用安全写入；相关运行状态在事实源成功后再更新。
- 同一个 Tool Call 必须具有稳定的幂等键。网络重试、Provider 重放或进程恢复不能造成重复追加。
- `baseRevision` 不匹配、格式不支持、内容为空、Schema 无效或项目作用域不符时，不进行部分写入，返回结构化 Tool 错误。
- Draft 到正式正文仍通过后续交付、ChangeSet 和用户审批完成。

现有 CLI `write_project_document` 是通用的逐次用户审批文件写入 Tool；未来 `write_draft` 是主笔创作循环中的专用工作草稿 Tool。二者不能复用相互矛盾的审批和展示语义。

## 5. 文本统计规范

### 5.1 公共类型

```ts
interface TextStatistics {
  characters: number;
  words: number;
  punctuation: number;
  algorithmVersion: 'cleodoc-text-statistics-v1';
}
```

`algorithmVersion` 必须随结果保存或返回。未来规则变化时可以重新计算和解释历史差异，不能在同一版本下静默改变算法。

### 5.2 字符数

字符数是 `write_draft.content` 原始字符串中的字符数量：

- 包含正文、格式标记、标点、空白和换行。
- 不对原始内容做 Unicode 规范化后再计数。
- 使用 Unicode Code Point 数量，而不是 JavaScript UTF-16 Code Unit 数量；建议实现为 `Array.from(content).length`。

该定义统计模型实际提交给 Tool 的内容。换行风格如果在保存阶段发生平台转换，不应反向改变“本次写入字符数”。

### 5.3 可见文本提取

字数和标点符号数都先排除格式相关字符，再对可见文本统计。实现必须按 `format` 使用解析器或 AST 提取器，不能用一组正则表达式猜测格式。

以 Markdown 为例：

- 标题符号、强调符号、代码围栏和链接语法不计入字数或标点。
- 标题文字、强调文字和链接显示文字属于可见文本，应保留。
- 链接目标、属性和结构性标记不属于可见文稿，应排除。

未来 `cleodoc-richtext-v1` 必须提供独立的纯文本提取器，但沿用相同的统计接口。

### 5.4 字数

字数在可见文本上计算：

- 每个汉字字符计为一个字。
- 每个连续的英文单词计为一个字。
- 格式字符、空白和标点符号不计入字数。
- 英文缩写中的内部撇号允许保持为一个英文单词，例如 `don't` 和 `writer's` 各计一个字；撇号本身仍按标点规范计数。

数字、其他语言文字和特殊符号如何纳入“字数”仍是开放规则，见第 10 节；首个实现前必须用固定测试样例确认。

### 5.5 标点符号数

标点符号数在可见文本上计算：

- 排除所有格式相关字符。
- 使用 Unicode Punctuation 类别 `\p{P}` 逐字符统计中英文标点。
- 空白、Emoji 和一般数学/货币符号不自动视为标点。

### 5.6 示例

原始 Markdown：

```md
**你好，world!**
```

统计结果：

- 字符数：13，包括四个 `*` 格式字符。
- 字数：3，即“你”“好”和 `world`。
- 标点符号数：2，即“，”和 `!`。

### 5.7 本次写入与整篇文档

`written` 必须对本次 `write_draft.content` 精确计算。未来如增加 `document` 总统计，应在写入成功后的最终文档上重新计算，不能简单把历史分段相加；两次写入的英文、数字或格式边界可能在拼接处形成不同的词法单元。

## 6. 上下文与消息持久化

`write_draft.content` 在当前 Tool Call 参数中已经出现一次，Tool Result 只返回 ID、Revision 和数字，不能再次携带正文。这样模型可立即依据统计决策，同时避免在下一轮上下文中重复同一内容。

用于聊天展示和检索时应遵守：

- 不把 Draft 正文复制为普通 Assistant Message Content。
- 不把 Tool 参数中的正文索引为普通对话正文，否则历史搜索会得到重复内容。
- UI 状态卡片只引用 Tool Call、文档和 Revision，不保存第二份正文。
- 活跃上下文增长后，可以将较早的 `write_draft` 参数投影为文档 ID、Revision 和写入范围，不在压缩投影中包含内部 Hash；模型需要原文时通过受控文档读取 Tool 获取。
- 压缩、历史查询和 Debug 日志的投影规则必须明确区分 Tool 元数据与文稿正文。

具体数据库字段和 Draft Revision 表结构在实现前随文档版本模型一并设计，本设计不提前固定 Schema。

## 7. Prompt 约束

主笔 System Prompt 应包含等价规则：

> 与用户沟通时输出普通 Assistant Content。需要创作文稿时，不要把文稿放在 Assistant Content 中，直接调用 `write_draft`，并把文稿放入 `content` 参数；同一轮不能混合两种模式。收到写入统计后，自行判断继续写入、结束交付或向用户询问，不要感谢、复述 Tool Result，也不要把 Tool Result 当成用户发言。

Prompt 只规定行为边界，不要求模型预先精确预测字数。精确数字始终由本地统计器产生。

## 8. 异常与协议违规

- 模型同时输出长篇正文和 `write_draft`：视为协议违规，不自动写入 Assistant Content；允许一次有针对性的纠正重试，仍失败则向用户报告。
- 预期产出文稿但模型只输出长篇普通 Content：不通过启发式规则静默转存，避免误把解释或引用写入 Draft。
- Tool 参数流中断或 JSON 无效：丢弃未提交内容，保留原 Draft Revision。
- 写入超时但本地结果未知：用幂等键查询既有执行结果，不能盲目重试追加。
- Revision 冲突：返回当前 Revision 和冲突类型，由模型重新读取或交给用户处理。
- 统计失败：本次写入事务不应返回成功；在无法提供可信统计前，不让模型基于错误数字继续决策。

## 9. 测试与验收

### 9.1 统计单元测试

- 纯中文、纯英文和中英混排。
- 中文全角标点、英文半角标点和成对引号。
- Markdown 标题、强调、链接、列表、引用和代码块。
- Emoji、代理对、组合字符、不同换行和空白。
- 英文缩写、单词边界以及分段拼接边界。
- 同一输入在 Windows、macOS 和 Linux 得到相同结果。

### 9.2 Tool 集成测试

- 流式 Tool 参数完整拼接后只写入一次。
- 相同幂等键重试不会重复追加。
- `baseRevision` 冲突和路径越权不会修改 Draft。
- Tool Result 不包含正文，只包含紧凑状态和统计。
- 写入失败不产生新 Revision，统计失败不返回虚假成功。

### 9.3 Agent 行为测试

- 普通回答不触发统计或 Draft 写入。
- 文稿模式不在聊天 Content 中重复正文。
- 模型收到不足、合适或超出预期的实际字数后，能选择继续、停止或询问，而不会把 Tool 状态当作用户话语。
- 模型完成写作后通过停止 Tool Call 正常结束，不依赖 `finish_draft`。
- 最大 Tool Loop 轮数和取消机制能够终止连续写作。

## 10. 开放决策

以下细节尚未由产品规则确定，实施前需要用样例确认：

- 连续数字是否按一个字计数，以及小数、百分比和日期的边界。
- 日文假名、韩文、拉丁字母以外文字的计数规则。
- 标题等可见结构文字是否全部计入文稿字数；当前建议计入，仅排除格式标记。
- 是否在 Tool Result 和 GUI 中展示整篇文档、当前章节或当前场景的总统计。
- `cleodoc-richtext-v1` 的最终格式、解析器和可见文本定义。
- Draft Revision 的数据库结构、保留策略以及它与 ChangeSet/Git Revision 的映射。

这些开放项不能阻塞已确认的主流程：文稿直接通过 `write_draft` 写入、正文不在聊天中重复、Tool 返回本次写入的精确统计、模型通过是否继续调用 Tool 表达继续或完成。
