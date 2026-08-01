import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: { reporter: ["text", "html"] },
    environment: "node",
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
  },
});
