import { describe, expect, it } from "vitest";

import { formatLlmDebugEvent } from "./debug-log.js";

describe("LLM debug log", () => {
  it("writes the complete assembled compaction output as UTF-8 text", () => {
    const summary = "# 当前目标\n\n完成中文长篇小说。\n\n# 下一步\n\n继续分卷创作。";
    const formatted = formatLlmDebugEvent({
      type: "llm-assembled-output",
      operation: "compaction",
      round: 2,
      providerId: "deepseek",
      model: "deepseek-v4-flash",
      compactionJobId: "compaction-job-1",
      content: summary,
      characterCount: summary.length,
      finishReason: "stop",
    });

    expect(formatted).toContain("上下文压缩 LLM 完整拼接结果 #2");
    expect(formatted).toContain(`characters=${summary.length}`);
    expect(formatted).toContain("job=compaction-job-1");
    expect(formatted).toContain("finish=stop");
    expect(formatted).toContain(summary);
    expect(formatted).not.toContain("\\u5f53\\u524d");
  });
});
