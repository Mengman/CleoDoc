# CleoDoc 开发计划

> 本文件是实施状态、任务顺序和发布门的唯一来源。
>
> 产品范围见 [PRD](./PRD.md)，系统边界见 [技术架构](./TECHNICAL_ARCHITECTURE.md)，桌面结构和组件技术方案见 [桌面 UI 结构设计](./DESKTOP_UI_STRUCTURE_DESIGN.md)。

## 1. 版本策略

- **v0.1：CLI 核心 MVP，已完成。** 已通过 LLM 创作、资料管理、本地 RAG、持久化恢复和跨平台 CLI 发行闭环验收。
- **v0.2：Electron 桌面产品收尾，已完成。** 已以现有 Electron + React 界面完成稳定性、安全性与 Windows 安装包验证；不再用当前手写 UI 体系新增复杂页面或交互。
- **v0.3：桌面 UI 基础与能力迁移。** 接入 Tailwind CSS、shadcn/ui 和 Radix UI，迁移现有 v0.2 页面，并完成原 v0.2 尚未实现的长任务、上下文、Tool 状态、索引与检索界面。
- **v0.4：创作工作室。** 接入 TipTap 与 CDM 编辑适配，并引入 Git 版本控制、版本历史、恢复与语义 Diff。

v0.2 至 v0.4 都复用同一套 Core/Application Service。Renderer 不复制项目、数据库、RAG、Provider 或模型调用逻辑。

## 2. 已完成基线

| 能力 | 当前状态 | 后续安排 |
| --- | --- | --- |
| CLI、项目与安全文件读写 | 完成 | Desktop 与 CLI 继续复用同一 Application Service。 |
| SQLite、资料解析、Chunk、FTS、Embedding、RAG | 完成 | v0.3 补索引状态、检索和恢复界面。 |
| OpenAI-compatible Provider 与安全密钥保存 | 完成 | v0.3 迁移设置界面；新 Provider 另行规划。 |
| Conversation、Session、Reasoning 与流式输出 | 基础桌面界面完成 | v0.3 补压缩、Session、重试与上下文状态界面。 |
| Tool Runtime 与 `ask` 授权 | 基础桌面交互完成 | v0.3 补 Tool 执行状态展示。 |
| Markdown/TXT 作品与资料阅读 | 完成 | v0.4 与编辑器一起重新规划写入与编辑。 |
| 资料导入、重命名、删除与自动索引 | 完成 | v0.3 补任务状态、重建、检索和失败恢复界面。 |
| 当前 Electron + React 桌面外壳 | v0.2 完成 | Windows 安装包已完成构建、安装和实际使用验证；v0.3 迁移至统一 UI 框架。 |

## 3. v0.2：Electron 桌面产品收尾（已完成）

### 3.1 版本目标与边界

v0.2 已完成以下可稳定使用的 Windows 桌面闭环：

```text
创建或打开项目
→ 查看 Markdown/TXT 作品
→ 导入并查看 Markdown/TXT 资料
→ 配置 OpenAI-compatible Provider
→ 与主笔对话并使用现有 Tool 授权
→ 重启应用并恢复项目与 Conversation
```

v0.2 不再新增需要复杂交互或新视觉组件的界面，包括长任务详情、取消与重试界面、Session 与压缩界面、Tool 执行状态、索引状态、手动检索和检索结果浏览。这些内容统一迁移至 v0.3，在 UI 框架稳定后开发。

正文编辑、TipTap、CDM 正式迁移、Draft、文本统计、Git、版本历史和语义 Diff 不属于 v0.2。

### 3.2 Electron 兼容性、隔离与安装包

**状态：已完成。** 已完成 Electron + React 工程、开发版启动、桌面构建、Renderer/Preload/Main 分层、sandbox、context isolation、Typed IPC、单活动项目生命周期和项目级资源释放。

已完成的发行与验证：

- 已接入 `electron-builder`，并提供 `npm run package:desktop` 与 `npm run package:desktop:dir`。
- 已配置 Windows NSIS、macOS DMG 和 Linux AppImage 目标，以及 `release/desktop` 输出目录。
- 已将默认配置与两个 GGUF Embedding 模型作为 `extraResources` 放入安装版 `resources` 目录。
- 已将 `node-llama-cpp`、sqlite-vec 及其平台原生依赖纳入生产依赖和 ASAR unpack 规则。
- Windows x64 目录包已验证包含默认配置、模型和解包后的原生依赖，并成功完成一次隐藏窗口启动检查。
- Windows x64 NSIS 安装器已成功生成，启用确认安装与安装目录选择；当前安装器约 438 MB，未签名。
- 已新增跨平台桌面制品 CI 工作流，在 Windows、macOS 和 Linux 原生 Runner 上构建并归档各自的默认制品。
- 已由用户在 Windows 上完成安装包构建、安装和实际使用验证。

macOS DMG、Linux AppImage、应用签名、公证与自定义应用图标不属于本次 v0.2 完成依据；进入相应平台的正式发行时再单独验证。

### 3.3 现有界面稳定性与发布验证

**状态：已完成。** 已完成项目创建、打开、最近项目、独立项目首页、作品/资料阅读、资料管理、Provider 配置、Conversation、流式 Reasoning、Tool 授权和底部状态栏布局，并完成 Windows 安装版实际使用验证。

已验证的行为：

- 现有 v0.1 项目可原样打开，不静默迁移或改写作品与资料。
- `.md`、`.txt` 作品与资料正确显示中文、英文、Emoji 和原始换行，不执行 Markdown 中的危险内容。
- 资料导入、重命名、删除、自动切片和 Embedding 保持现有业务语义。
- Conversation、草稿、Reasoning 与 Tool 审批在重启、切换项目和失败时保持既有隔离与恢复规则。

### 3.4 v0.2 完成确认

已使用真实 Windows 桌面发行物完成：

1. 创建或打开现有项目，并查看 Markdown/TXT 作品。
2. 导入、查看、重命名和删除中英文 Markdown/TXT 资料。
3. 配置 OpenAI-compatible Provider，与真实模型对话并恢复 Conversation。
4. 让模型调用既有 RAG/文档 Tool，并完成一次需要授权的写入 Tool 决策。
5. Windows 安装包完成构建、安装和实际使用验证。

完成确认：没有跨项目泄漏；未经授权的操作不会写入；失败、取消和退出不会损坏事实源；Desktop 不复制 v0.1 Core 逻辑；CLI 行为不回退。

## 4. v0.3：UI 框架接入与能力迁移

### 4.1 UI 框架基线

**状态：阶段一至阶段三已完成。** Renderer 已接入 Tailwind CSS 构建插件、shadcn CLI 配置、主题 token、启动初始化和最小基础组件集；页面迁移尚未开始。

技术方案固定为 **Tailwind CSS + shadcn/ui + Radix UI**：

- Tailwind CSS 提供构建期样式生成、响应式布局与 token 消费。
- shadcn/ui 将实际组件源码纳入仓库，作为 CleoDoc 可维护的基础组件层；按需添加，不批量引入页面模板。
- Radix UI 提供菜单、弹窗、Popover、Tabs、ScrollArea、Select、Tooltip 等无障碍交互原语；不另行维护与 shadcn 重复的通用组件体系。
- 使用语义 CSS token 建立 Light、Dark 和 System 三种主题选择；所有页面使用语义 token，不直接绑定具体颜色。
- “毛玻璃感”使用不透明渐变 surface、边框和阴影实现；不以真实透明或 `backdrop-filter` 作为产品基础视觉，避免性能和跨平台渲染差异。

阶段一实现约束：

- Tailwind 的 Vite 插件只注册到 Electron Renderer；Main、Preload、CLI 和 `packages/*` 不引入 UI 运行时依赖。
- `components.json` 与 `apps/desktop/src/renderer/src/components/ui/` 作为后续 shadcn 源码的唯一配置和目录位置；尚未按需引入任何可见组件。
- Renderer 使用 `@` 指向 `apps/desktop/src/renderer/src` 的构建与 TypeScript 别名；`cn()` 位于 `lib/utils.ts`。
- Tailwind 样式继续由 `index.html` 外链加载，以保持严格 CSP；仅导入 theme 与 utilities，暂不导入 Preflight，避免全局重置改变尚未迁移的手写页面。

已完成的主题基础：

- `state.yaml` 保存 `light`、`dark` 或 `system` 的主题偏好，缺省为 `system`；它与当前项目、最近目录和最近项目保持同一应用状态事实源。
- Main 在创建窗口前解析主题并设置窗口背景；Preload 只暴露经过 Schema 校验的主题启动信息与系统主题变化事件。
- Renderer 在首次 React 渲染前设置 `data-theme`，避免未来消费 token 的页面出现错误主题首屏。
- Tailwind CSS 已定义 Light/Dark 语义颜色、字体、字号、行高、圆角、间距、阴影、层级与动效 token；视觉 token 不依赖透明背景或 `backdrop-filter`。

已完成的基础组件：

- 已按需生成 Button、Input、Textarea、Select、Tabs、Dialog、AlertDialog、DropdownMenu、Popover、Tooltip、ScrollArea、Progress、Badge 与 Toast（Sonner）源码，并集中放在 `components/ui/`。
- 已引入 Radix UI、`class-variance-authority`、`tailwind-merge`、`clsx`、Sonner 与 `tw-animate-css`；不导入组件库模板、页面或示例数据。
- Toast 监听 CleoDoc 已有的 `data-theme`，不使用 `next-themes` 或浏览器存储建立第二套主题状态。
- 组件尚未导入现有业务页面，因此不产生新的可见 UI；现有手写页面继续保持原状。

仍需实现：

- 在获得明确 UI 授权后，将主题选择控件放入设置界面。
- 为组件增加键盘导航、焦点管理、屏幕阅读器语义和高对比度验证。

当前手写页面将在 4.2 的页面迁移时开始消费 token；本阶段不为旧页面重复替换颜色或布局。

检查点：

- 主题偏好可持久化，System 模式在启动和操作系统主题变化时解析为 Light 或 Dark；主题选择控件在获得授权后补充。
- 组件仅从 Renderer 使用，不向 Main 或 Core 引入 DOM、Tailwind 或 UI 依赖。
- 弹窗、菜单、焦点陷阱和快捷键不破坏 Electron 窗口菜单与 TipTap 未来的编辑器焦点。
- 产物不包含未使用的整套视觉组件库或页面模板。

### 4.2 现有 v0.2 页面迁移

**状态：未开始。**

需要迁移：窗口标题栏、导航区、项目首页、项目菜单、作品/资料左栏、共享文档阅读区、聊天区、设置页、授权控件和状态栏。

迁移原则：

- 先迁移基础组件和主题，再迁移页面；不在同一页面长期混用旧手写通用控件与新组件体系。
- 保留既有 Application Service、Typed IPC、项目隔离和业务行为；迁移不引入平行状态模型。
- 不依据组件库的模板自动增加导航、按钮、空状态、数据卡或功能入口；新增可见元素仍需用户授权。
- 迁移完成后删除被替代的通用 CSS 与重复组件，避免双重主题和样式优先级冲突。

检查点：现有 v0.2 端到端闭环、项目切换、草稿保持、资料操作和 Tool 授权行为不回退。

### 4.3 长任务、上下文与 Tool 状态界面

**状态：未开始。** 该阶段承接原 v0.2 的长任务界面化。

需要实现：

- 为聊天生成、上下文压缩、Chunk/FTS 重建和 Embedding 建立统一的项目内任务状态、进度、取消与完成/失败事件。
- 状态栏显示当前简短任务状态；详情、错误和重试使用统一的组件交互，不建设独立任务中心。
- 显示上下文预算、自动/手动压缩、压缩中状态、取消、失败重试和 Conversation 下的 Session。
- 显示 Tool 的简洁执行中、成功、失败、取消和拒绝状态；不展示原始 Tool JSON。

检查点：

- 项目切换或退出时，任务、审批和 Conversation Runtime 不跨项目遗留。
- 取消、压缩失败或 Tool 拒绝不删除已保存消息、旧 Session、资料或原文。
- Tool 授权仍仅限当前 Project、Conversation 和相同 Tool 版本；退出后持续允许失效。

### 4.4 索引、Embedding 与检索界面

**状态：未开始。**

需要实现：

- 展示总体和单份资料的索引状态、Embedding 状态及必要错误信息。
- 触发现有 Chunk/FTS 重建和 Embedding 生成，显示进度、取消与重试。
- 提供当前项目范围内的普通、语义和混合检索界面，展示资料、命中范围、相关度和必要来源信息。
- 展示 Embedding 模型信息并提供现有测试能力。

检查点：

- 精确名称、资料原文和近义描述均可召回对应资料，且严格限定当前项目和 material 范围。
- 删除资料后 Chunk、FTS 和向量均不可再检索。
- 普通 UI 检索不持久化为模型证据审计；失败、取消和重建不修改原资料。

### 4.5 v0.3 发布门

1. Light、Dark 和 System 主题在安装版中正确恢复。
2. 所有既有 v0.2 页面已迁移至统一组件和 token 体系，业务行为不回退。
3. 可从 UI 观察、取消和重试聊天、压缩、索引与 Embedding 的相应任务。
4. 可完成资料导入、索引、普通/语义/混合检索闭环。
5. 可查看 Conversation 的 Session、上下文状态和简洁 Tool 执行状态。

## 5. v0.4：编辑器与 Git 版本控制

### 5.1 TipTap、CDM 与安全写入

**状态：未开始。**

需要重新评审并实现：正式 CDM v1、现有 Markdown 迁移策略、TipTap/ProseMirror 编辑器、CDM 双向适配、Draft、自动保存、文本统计、用户确认后的安全写入，以及作品创建和删除入口。

TipTap 是编辑器内核；shadcn/ui 和 Radix UI 只负责编辑器周边的工具栏、下拉菜单、浮层、标签页、确认框和状态反馈，不替代编辑器选区、命令或文档状态。

### 5.2 Git 版本、历史与语义 Diff

**状态：未开始。**

需要重新评审并实现：隐藏 Git 版本引擎、命名版本、安全恢复、版本历史、项目指令与 Revision 历史界面、CDM 语义 Diff 计算和对比/恢复界面。

Git Application Service 可独立于 UI 开发；版本列表、恢复确认和 Diff 浏览必须复用 v0.3 的 Dialog、AlertDialog、Tabs、ScrollArea、Toast 和主题 token，不再建立新的组件体系。

### 5.3 v0.4 发布门

1. 作品可以在 TipTap 中编辑并安全写回事实源，失败不损坏原文。
2. CDM、编辑器与 Markdown 过渡策略可验证、可恢复且不静默丢失内容。
3. 用户可创建、查看、比较和安全恢复版本。
4. 语义 Diff 可解释地展示 CDM 级变化，不以文本 Diff 冒充语义结果。

## 6. 版本依赖与顺序

```mermaid
flowchart LR
    A["v0.2 稳定性与发行验证"] --> B["v0.3 UI 框架与主题"]
    B --> C["v0.3 现有页面迁移"]
    C --> D["v0.3 长任务、上下文、Tool 状态"]
    D --> E["v0.3 索引与检索界面"]
    E --> F["v0.4 TipTap 与 CDM"]
    F --> G["v0.4 Git 版本与语义 Diff"]
```

- v0.2 发布后不再扩展旧手写 UI，除缺陷修复和发布阻塞问题外不新增复杂界面。
- v0.3 基础组件和主题稳定前，不开始新的复杂页面；业务层和 Typed IPC 可先行，但不得以临时页面替代正式交互。
- v0.4 的 TipTap 和 Git 领域设计可在 v0.3 期间研究，但正式产品开发必须在 v0.3 UI 基线稳定后重新确认范围。

## 7. 后续版本候选范围

以下能力不因本文件列出而自动获得版本范围，实施前必须重新规划：新 Provider 接入、跨厂商模型调用记录、统一问题诊断、知识图、事实抽取、阶段 Agent、文件夹批量导入、DOCX/PDF/EPUB、个人资料库、云同步、多人协作、OCR、插件和 ANN。
