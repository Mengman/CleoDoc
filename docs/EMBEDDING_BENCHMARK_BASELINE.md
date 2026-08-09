# Embedding CPU/GPU 基准

本文记录 CleoDoc v0.1 本地 Embedding 的可重复 Baseline。它用于发现后续模型、推理参数、SQLite Schema 或向量检索实现造成的性能回退，不作为跨设备的绝对性能承诺。

## 1. 运行方式

CPU：

```text
npm run cleo -- embedding benchmark zh
npm run cleo -- embedding benchmark en
```

GPU：

```text
npm run cleo -- embedding benchmark zh --gpu
npm run cleo -- embedding benchmark en --gpu
```

可选参数：

- `--gpu`：启用 llama.cpp 的 `gpu: "auto"` 和 `gpuLayers: "auto"`；未提供时强制使用 CPU。
- `--copies <数量>`：每篇固定文档在临时数据库中生成多少个候选 Chunk，默认 16。
- `--runs <数量>`：每条 Query 重复执行多少次 SQLite 精确向量查询，默认 20。

GPU 基准会输出 llama.cpp 实际选择的后端和实际卸载层数。如果 `--gpu` 没有卸载任何模型层，命令会失败，不会把 CPU 回退结果误记为 GPU 成绩。命令使用当前配置的模型，并输出模型 ID、名称和 Revision。所有资料、Chunk 和向量写入操作系统临时目录，完成后删除，不修改用户项目。

## 2. 测量方法

- 模型加载：创建 `node-llama-cpp`、加载 GGUF 和创建 Embedding Context 的总耗时。
- 首次 Chunk 推理：模型加载后第一次 Document Embedding 的耗时，包含 GPU Shader/Pipeline 等首次初始化成本。
- 稳态单 Chunk 延迟：先预热 6 条固定文档，再次顺序处理相同文档，记录平均值、P50 和 P95。
- 吞吐：用稳态 6 条文档的总 Chunk 数和实际 Token 数除以总推理时间。
- Query Embedding：先预热 4 条与原文措辞不同的固定查询，再记录平均值、P50 和 P95。
- SQLite 查询：每篇文档复制为指定数量的 Chunk，使用普通 `chunk_embeddings` 表和 sqlite-vec 精确余弦距离查询 Top-5。
- Query Recall：分别统计 4 条查询的 Top-1 和 Top-5 Recall；这是小型回归语料，不替代步骤 8 的正式 RAG 召回测试集。
- 可追溯性：检查所有返回项都具有公开 Source ID、Chunk ID 和有效的原文字节范围。

模型加载时间容易受到运行顺序、操作系统文件缓存和动态库冷启动影响。稳态延迟适合判断持续索引吞吐，首次推理则更接近用户首次使用的等待。两者必须同时保留。

## 3. 2026-08-10 Baseline

环境：

- Windows x64
- Node.js v26.2.0
- Intel Core i5-13600KF
- AMD GPU，llama.cpp Vulkan 后端
- sqlite-vec v0.1.9
- `--copies 16 --runs 20`，共 96 个候选 Chunk

### 3.1 中文 `bge-small-zh-v1.5-q8_0`

模型身份：`BAAI/bge-small-zh-v1.5 @ v1.5-q8_0`，512 维。GPU auto 实际使用 Vulkan，卸载 5 层。

| 指标 | CPU | AMD GPU | GPU/CPU 稳态加速 |
|---|---:|---:|---:|
| 模型加载 | 340.24 ms | 1573.43 ms | 0.22× |
| 首次 Chunk 推理 | 38.00 ms | 289.95 ms | 0.13× |
| 单 Chunk 平均 | 35.29 ms | 3.61 ms | 9.78× |
| 单 Chunk P50 | 33.97 ms | 3.44 ms | 9.88× |
| 单 Chunk P95 | 39.46 ms | 4.17 ms | 9.46× |
| 顺序吞吐 | 28.34 chunks/s | 276.84 chunks/s | 9.77× |
| Token 吞吐 | 973.0 tokens/s | 9505.0 tokens/s | 9.77× |
| Query Embedding 平均 | 35.89 ms | 3.44 ms | 10.43× |
| SQLite 查询平均 | 0.44 ms | 0.23 ms | 不适用 |
| Top-1 Query Recall | 100.0% | 100.0% | 一致 |
| Top-5 Query Recall | 100.0% | 100.0% | 一致 |
| 结果可追溯性 | 通过 | 通过 | 一致 |

### 3.2 英文 `bge-small-en-v1.5-q8_0`

模型身份：`BAAI/bge-small-en-v1.5 @ v1.5-q8_0`，384 维。GPU auto 实际使用 Vulkan，卸载 13 层。

| 指标 | CPU | AMD GPU | GPU/CPU 稳态加速 |
|---|---:|---:|---:|
| 模型加载 | 405.72 ms | 1726.76 ms | 0.23× |
| 首次 Chunk 推理 | 50.41 ms | 255.37 ms | 0.20× |
| 单 Chunk 平均 | 40.61 ms | 5.50 ms | 7.38× |
| 单 Chunk P50 | 39.86 ms | 5.50 ms | 7.25× |
| 单 Chunk P95 | 44.02 ms | 5.59 ms | 7.87× |
| 顺序吞吐 | 24.62 chunks/s | 181.84 chunks/s | 7.39× |
| Token 吞吐 | 595.1 tokens/s | 4394.6 tokens/s | 7.38× |
| Query Embedding 平均 | 34.55 ms | 5.67 ms | 6.09× |
| SQLite 查询平均 | 0.34 ms | 0.37 ms | 不适用 |
| Top-1 Query Recall | 100.0% | 100.0% | 一致 |
| Top-5 Query Recall | 100.0% | 100.0% | 一致 |
| 结果可追溯性 | 通过 | 通过 | 一致 |

## 4. 当前结论

- 这台 AMD GPU 在稳态 Embedding 上有明显收益：中文约 9.8 倍，英文约 7.4 倍。
- GPU 的模型加载和首次推理明显慢于 CPU。只处理极少量文本时，启动成本可能抵消加速收益。
- 中文约在 48 个 Chunk、英文约在 45 个 Chunk 后，按本次单次测量的模型加载、首次推理和稳态耗时估算，GPU 才开始取得总耗时优势。该交叉点只用于产品策略参考，需要多轮独立进程测量后再固化。
- SQLite 查询不使用 Embedding GPU；CPU/GPU 两组查询差异属于运行噪声。
- CPU 与 GPU 的固定语料召回和回溯结果一致，当前没有观察到量化模型在不同后端上的功能差异。
