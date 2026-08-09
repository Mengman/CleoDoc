# Embedding 开发模型

该目录保存 CleoDoc 本地 Embedding 功能开发和测试所使用的 GGUF 模型：

- `bge-small-zh-v1.5-q8_0.gguf`：中文资料。
- `bge-small-en-v1.5-q8_0.gguf`：英文资料。

两个文件均使用 Q8_0 量化，由 Git LFS 管理。它们目前只是仓库内的开发资源；正式产品是否随安装包分发、首次使用时下载，或保存到应用模型缓存，将在发布设计阶段决定。
