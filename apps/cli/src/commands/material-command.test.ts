import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { MaterialService } from "../../../../packages/knowledge/src/index.js";
import { ProjectService } from "../../../../packages/project/src/index.js";
import { TEST_DATABASE_OPTIONS, TEST_MATERIAL_OPTIONS } from "../../../../test/runtime-options.js";
import { parseArguments } from "../arguments.js";
import type { CliCommandContext } from "./command-context.js";
import { executeMaterialCommand } from "./material-command.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("material CLI title addressing", () => {
  it("uses titles for display, lookup, rename and removal without printing source IDs", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cleodoc-material-command-test-"));
    temporaryDirectories.push(directory);
    const project = await new ProjectService(TEST_DATABASE_OPTIONS).create(
      path.join(directory, "novel.cleo"),
    );
    const inputPath = path.join(directory, "railway-notes.md");
    await writeFile(inputPath, "# Railway\n\nThe night train uses an oil lamp.\n", "utf8");
    const materials = await MaterialService.open(project.root, TEST_MATERIAL_OPTIONS);
    const output = createOutput();
    const context = {
      input: Readable.from([]),
      output,
    } as unknown as CliCommandContext;

    try {
      await executeMaterialCommand(
        parseArguments(["material", "add", inputPath, "--title", "Railway Notes"]),
        context,
        materials,
        TEST_MATERIAL_OPTIONS.maxImportBytes,
      );
      const [source] = await materials.list();
      expect(source).toBeDefined();
      expect(output.content).toContain("已添加资料：Railway Notes");
      expect(output.content).not.toContain(source!.id);
      expect(output.content).not.toContain("资料 ID");
      expect(output.content).not.toContain("内容哈希");

      output.clear();
      await executeMaterialCommand(
        parseArguments(["material", "list"]),
        context,
        materials,
        TEST_MATERIAL_OPTIONS.maxImportBytes,
      );
      expect(output.content).toContain("Railway Notes\tmarkdown\t");
      expect(output.content).not.toContain(source!.id);

      output.clear();
      await executeMaterialCommand(
        parseArguments(["material", "show", "Railway Notes"]),
        context,
        materials,
        TEST_MATERIAL_OPTIONS.maxImportBytes,
      );
      expect(output.content).toContain("资料：Railway Notes");
      expect(output.content).toContain("night train");
      expect(output.content).not.toContain(source!.id);

      output.clear();
      await executeMaterialCommand(
        parseArguments(["material", "rename", "Railway Notes", "Railway Archive"]),
        context,
        materials,
        TEST_MATERIAL_OPTIONS.maxImportBytes,
      );
      expect(output.content).toBe("已重命名资料：Railway Archive\n");
      await expect(
        executeMaterialCommand(
          parseArguments(["material", "show", "Railway Notes"]),
          context,
          materials,
          TEST_MATERIAL_OPTIONS.maxImportBytes,
        ),
      ).rejects.toMatchObject({ code: "MATERIAL_NOT_FOUND" });

      output.clear();
      await executeMaterialCommand(
        parseArguments(["material", "remove", "Railway Archive"]),
        context,
        materials,
        TEST_MATERIAL_OPTIONS.maxImportBytes,
      );
      expect(output.content).toBe("已删除资料：Railway Archive\n");
      expect(await materials.list()).toEqual([]);
    } finally {
      await materials.close();
    }
  });
});

function createOutput(): { readonly content: string; write(value: string): void; clear(): void } {
  let content = "";
  return {
    get content() {
      return content;
    },
    write(value: string) {
      content += value;
    },
    clear() {
      content = "";
    },
  };
}
