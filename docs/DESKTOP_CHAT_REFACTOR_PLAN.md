# Desktop 聊天调用链重构计划

> 适用范围：v0.2 Desktop 聊天功能
>
> 来源：对当前 Electron 聊天架构问题第 1、2、3、5、6 项的确认方案
>
> 不在本计划中：第 4 项 `ActiveProject` 封装调整，按当前决定暂不修改

## 1. 目标

本计划用于整理 Desktop 聊天从界面到 Provider 的调用边界，解决底层 Provider 被上层直接管理、每次发送都重建 Provider、发送后重新查询最近 20 条消息、IPC 重复校验，以及单窗口场景下无差别广播等问题。

重构后保持以下产品行为：

- 打开 Conversation 时首次加载最近 20 条消息，这只是首页加载数量，不是界面最大消息数。
- 当前轮的 User、Reasoning 和 Assistant 内容通过事件增量进入现有消息列表。
- 发送完成后不为了“恢复最终状态”再查询最近 20 条消息。
- Provider 和模型不得静默切换，API Key 不得进入 Renderer、项目、日志或普通配置文件。
- 不在本次重构中增加新 Provider、新建 Conversation、历史消息向上分页或多窗口能力。

## 2. 阶段一：建立统一 ProviderService

对应问题：第 2 项，并为第 1 项提供稳定的模型调用边界。

需要完成：

- 在 `packages/model-providers` 中建立 `ProviderService`，由该服务管理当前 Provider 和具体 Provider 实例。
- 向 GUI 和 CLI 暴露 Provider 配置修改、当前 Provider/模型信息以及连接校验能力。
- 向 `ChatService` 只暴露统一 `send` 接口，不暴露 `OpenAICompatibleProvider`、`OllamaProvider` 等具体实现。
- 同一有效配置下复用 Provider 实例，不再每次发送都重新创建。
- Base URL、模型或 API Key 变更后使当前缓存失效，下一次发送时使用新配置构造 Provider。
- API Key 由 `ProviderService` 内部通过凭据存储边界读写，Desktop 继续使用 Electron `safeStorage`，CLI 继续使用环境变量。
- 本阶段不实现 Provider 切换功能。

检查点：

- GUI、CLI 和 `ChatService` 不再直接构造或消费具体 Provider。
- 连续发送多条消息时，底层 Provider 只创建一次。
- 修改普通配置或 API Key 后，旧 Provider 不再被后续请求使用。
- 请求的 Provider/模型与当前配置不一致时明确拒绝，不静默切换。
- GUI 和 CLI 只能获得密钥配置状态，不能获得 API Key 内容。

当前情况：本阶段已实现。

## 3. 阶段二：收紧聊天发送职责

对应问题：第 1 项。

需要完成：

- 保留必要的 Renderer、Preload/IPC、Main 和 Core 跨进程层级，不把跨进程调用伪装成单层函数。
- `ChatComposer` 只负责输入与提交交互，`ChatPanel` 负责当前 Conversation 和界面状态，不承担 Provider 或项目领域逻辑。
- Renderer 通过一个明确的桌面聊天接口发起请求和接收流式事件。
- Main 中由 `DesktopChatService` 作为桌面聊天用例入口，负责把经校验的 Conversation ID 和文本交给当前项目的 `ChatService`。
- `DesktopProjectRuntime` 仍负责当前项目生命周期与项目隔离；本阶段不拆除 `ActiveProject`。
- `ChatService` 仅通过 `ProviderService.send` 发起模型调用，不知道 GUI、IPC、密钥或具体 Provider 细节。

检查点：

- 每层都有不可替代的职责，不存在只改名或透传全部参数的平行服务。
- Renderer 不获得项目路径、数据库对象、API Key 或 Provider 实例。
- 新建和续聊依然使用 Conversation 中已保存的 Provider/模型身份。
- 取消、Reasoning、Content、Tool Call 和错误事件的流式行为不变。

## 4. 阶段三：改为消息增量更新

对应问题：第 3 项。

需要完成：

- Conversation 详情首次打开时继续查询最近 20 条用户可见消息。
- 发送开始时，Renderer 把新 User 消息追加到当前列表。
- 接收 Reasoning 和 Content 流式事件时，原位创建或更新当前 Assistant 消息。
- 发送完成后，Main 返回本轮必需的最终结果与标识，不再调用“最近 20 条”查询来覆盖当前列表。
- 将首页加载与未来向上分页的语义保留在 Conversation 查询接口中，不把 20 写成列表最大长度。
- 当发送失败或取消时，使用当前轮事件和持久化结果标记状态，不通过无条件全量重载隐藏问题。

检查点：

- 打开 Conversation 时只加载最近 20 条；连续发送后列表可以超过 20 条。
- 每次发送完成后不再执行最近 20 条消息查询。
- User、Reasoning 和 Assistant Content 按当前已确认的顺序增量显示。
- 切换 Conversation 后再返回时，已加载消息和未发送草稿保持一致。
- 向上加载旧消息仍是后续功能，本阶段不提前实现。

## 5. 阶段四：消除 DesktopProjectState 重复校验

对应问题：第 5 项。

需要完成：

- 明确 `DesktopProjectRuntime` 输出 `DesktopProjectState` 前的数据构造责任，确保返回值已符合公共契约。
- `registerDesktopIpc.getProjectState` 不再对 Runtime 已经返回的 `DesktopProjectState` 再执行一次相同 Schema 解析。
- 保留真正的外部边界校验：Renderer 输入、IPC 请求参数以及从不可信数据构造的响应仍必须经过 Schema。
- 避免同一内部可信对象在 Runtime 和 IPC Handler 中重复解析。

检查点：

- `getProjectState` 调用链中只保留一次负责归属明确的响应构造/校验。
- IPC 外部输入的 Zod 校验没有被删除或放宽。
- Renderer 获得的数据形状和错误信息保持不变。

## 6. 阶段五：按单窗口模型定向更新项目状态

对应问题：第 6 项。

需要完成：

- 以 v0.2 “一个应用实例只打开一个主窗口、只保持一个活动 Project”为实现前提。
- 项目状态变更时，只向当前主窗口发送更新，不遍历和广播给所有 `BrowserWindow`。
- 窗口引用由 Desktop 组合层显式交给 IPC/状态通知边界，窗口销毁后不再发送。
- 不为未进入 v0.2 的多窗口功能保留广播抽象、窗口路由或项目与窗口映射。

检查点：

- 打开、切换和关闭项目时，只有当前主窗口收到状态更新。
- 不再调用获取所有窗口的 API 来发送项目状态。
- 窗口未创建或已销毁时不会因状态通知导致异常。
- 项目隔离和单活动 Project 约束保持不变。

## 7. 实施顺序与总体验收

实施顺序固定为：
1. 先建立 `ProviderService`，使模型调用有稳定边界。
2. 再收紧 Desktop 聊天调用链各层职责。
3. 在发送事件边界稳定后，将消息列表改为增量更新。
4. 独立清理 `DesktopProjectState` 重复校验。
5. 最后将项目状态通知收紧为当前主窗口定向发送。

全部完成后必须确认：

- Desktop 可以打开项目、列出 Conversation、进入已有 Conversation 并继续发送消息。
- Reasoning 流式展示、完成后自动折叠以及 Content 流式展示行为不变。
- 首次只加载最近 20 条消息，本次运行中新增的消息不被 20 条限制截断。
- Provider 实例在配置不变时复用，修改配置或密钥后正确重建。
- Renderer 仍不直接访问 Node.js、文件系统、SQLite、API Key 或原始 `ipcRenderer`。
- 类型检查、lint、相关单元/集成测试、CLI 构建和 Electron 构建全部通过。
