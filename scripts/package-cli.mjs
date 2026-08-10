import {
  access,
  chmod,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootPackage = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
const target = `${process.platform}-${process.arch}`;
const supportedTargets = new Set([
  "win32-x64",
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
]);
const nativeDependencies = {
  "win32-x64": [
    "@node-llama-cpp/win-x64",
    "@node-llama-cpp/win-x64-vulkan",
    "sqlite-vec-windows-x64",
  ],
  "darwin-x64": ["@node-llama-cpp/mac-x64", "sqlite-vec-darwin-x64"],
  "darwin-arm64": ["@node-llama-cpp/mac-arm64-metal", "sqlite-vec-darwin-arm64"],
  "linux-x64": [
    "@node-llama-cpp/linux-x64",
    "@node-llama-cpp/linux-x64-vulkan",
    "sqlite-vec-linux-x64",
  ],
  "linux-arm64": ["@node-llama-cpp/linux-arm64", "sqlite-vec-linux-arm64"],
};

if (!supportedTargets.has(target)) {
  throw new Error(`当前平台 ${target} 没有 sqlite-vec 发行依赖，不能生成可运行的 CLI 包。`);
}

const releaseRoot = path.join(repositoryRoot, "release");
const packageName = `cleodoc-cli-${rootPackage.version}-${target}`;
const packageDirectory = path.join(releaseRoot, packageName);
const temporaryDirectory = `${packageDirectory}.tmp-${process.pid}`;

await assertBuildExists();
await assertEmbeddingModelsExist();
await mkdir(releaseRoot, { recursive: true });
await removeStaleTemporaryDirectories();
await rm(temporaryDirectory, { recursive: true, force: true });
await mkdir(temporaryDirectory, { recursive: true });

try {
  await copyDistributionFiles();
  await writeDistributionManifest();
  await writeLaunchers();
  installRuntimeDependencies();
  await installWorkspacePackages();
  await smokeTestPackage();
  await rm(packageDirectory, { recursive: true, force: true });
  await rename(temporaryDirectory, packageDirectory);
  process.stdout.write(`CLI 发行包已生成：${packageDirectory}\n`);
} catch (error) {
  await rm(temporaryDirectory, { recursive: true, force: true });
  throw error;
}

async function assertBuildExists() {
  await access(path.join(repositoryRoot, "dist", "apps", "cli", "src", "main.js")).catch(() => {
    throw new Error("找不到 CLI 编译产物，请先运行 npm run build。");
  });
}

async function assertEmbeddingModelsExist() {
  const modelDirectory = path.join(repositoryRoot, "resources", "models", "embedding");
  const modelNames = ["bge-small-zh-v1.5-q8_0.gguf", "bge-small-en-v1.5-q8_0.gguf"];
  for (const modelName of modelNames) {
    const modelPath = path.join(modelDirectory, modelName);
    const modelStat = await stat(modelPath).catch(() => null);
    if (modelStat === null || modelStat.size < 1024 * 1024) {
      throw new Error(`Embedding 模型 ${modelName} 不完整；请确认 Git LFS 文件已经下载。`);
    }
    const magic = await readFile(modelPath).then((content) =>
      content.subarray(0, 4).toString("ascii"),
    );
    if (magic !== "GGUF") throw new Error(`Embedding 模型 ${modelName} 不是有效的 GGUF 文件。`);
  }
}

async function copyDistributionFiles() {
  await cp(path.join(repositoryRoot, "dist"), path.join(temporaryDirectory, "dist"), {
    recursive: true,
  });
  await cp(path.join(repositoryRoot, "resources"), path.join(temporaryDirectory, "resources"), {
    recursive: true,
  });
  await cp(path.join(repositoryRoot, "README.md"), path.join(temporaryDirectory, "README.md"));
}

async function removeStaleTemporaryDirectories() {
  const prefix = `${packageName}.tmp-`;
  const entries = await readdir(releaseRoot, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => rm(path.join(releaseRoot, entry.name), { recursive: true, force: true })),
  );
}

async function writeDistributionManifest() {
  const dependencies = await collectRuntimeDependencies();
  const manifest = {
    name: "cleodoc-cli",
    version: rootPackage.version,
    private: true,
    description: rootPackage.description,
    license: rootPackage.license,
    type: "module",
    bin: { cleo: "./dist/apps/cli/src/main.js" },
    engines: rootPackage.engines,
    dependencies,
  };
  await writeFile(
    path.join(temporaryDirectory, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

async function collectRuntimeDependencies() {
  const dependencyNames = new Set(Object.keys(rootPackage.dependencies ?? {}));
  for (const dependencyName of nativeDependencies[target]) dependencyNames.add(dependencyName);
  for (const workspaceRoot of ["apps", "packages"]) {
    const entries = await readdir(path.join(repositoryRoot, workspaceRoot), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(repositoryRoot, workspaceRoot, entry.name, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      for (const dependencyName of Object.keys(manifest.dependencies ?? {})) {
        if (!dependencyName.startsWith("@cleodoc/")) dependencyNames.add(dependencyName);
      }
    }
  }

  return Object.fromEntries(
    await Promise.all(
      [...dependencyNames].sort().map(async (dependencyName) => {
        const installedManifest = path.join(
          repositoryRoot,
          "node_modules",
          dependencyName,
          "package.json",
        );
        const installed = JSON.parse(await readFile(installedManifest, "utf8"));
        return [dependencyName, installed.version];
      }),
    ),
  );
}

async function writeLaunchers() {
  const windowsLauncher = '@echo off\r\nnode "%~dp0dist\\apps\\cli\\src\\main.js" %*\r\n';
  const posixLauncher =
    '#!/bin/sh\nSCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec node "$SCRIPT_DIR/dist/apps/cli/src/main.js" "$@"\n';
  await writeFile(path.join(temporaryDirectory, "cleo.cmd"), windowsLauncher, "utf8");
  const posixPath = path.join(temporaryDirectory, "cleo");
  await writeFile(posixPath, posixLauncher, "utf8");
  await chmod(posixPath, 0o755);
}

async function installWorkspacePackages() {
  const entries = await readdir(path.join(repositoryRoot, "packages"), { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sourceManifest = JSON.parse(
      await readFile(path.join(repositoryRoot, "packages", entry.name, "package.json"), "utf8"),
    );
    if (!sourceManifest.name.startsWith("@cleodoc/")) continue;
    const packageDirectory = path.join(
      temporaryDirectory,
      "node_modules",
      ...sourceManifest.name.split("/"),
    );
    await mkdir(packageDirectory, { recursive: true });
    await cp(
      path.join(repositoryRoot, "dist", "packages", entry.name, "src"),
      path.join(packageDirectory, "src"),
      { recursive: true },
    );
    await writeFile(
      path.join(packageDirectory, "package.json"),
      `${JSON.stringify(
        {
          name: sourceManifest.name,
          version: sourceManifest.version,
          private: true,
          type: "module",
          exports: { ".": "./src/index.js" },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
}

function installRuntimeDependencies() {
  const argumentsList = [
    "install",
    "--omit=dev",
    "--omit=optional",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    "--prefer-offline",
    "--cache",
    path.join(repositoryRoot, ".npm-cache"),
  ];
  const npmEntry = process.env.npm_execpath;
  if (npmEntry !== undefined) {
    run(process.execPath, [npmEntry, ...argumentsList]);
    return;
  }
  run("npm", argumentsList);
}

async function smokeTestPackage() {
  const entry = path.join(temporaryDirectory, "dist", "apps", "cli", "src", "main.js");
  const smokeRoot = path.join(temporaryDirectory, ".package-smoke");
  const smokeEnvironment = { CLEODOC_HOME: path.join(smokeRoot, "home") };
  const projectPath = path.join(smokeRoot, "project.cleo");
  try {
    run(process.execPath, [entry, "version"], smokeEnvironment);
    run(process.execPath, [entry, "help"], smokeEnvironment);
    run(
      process.execPath,
      [entry, "init", projectPath, "--name", "Package Smoke"],
      smokeEnvironment,
    );
    run(process.execPath, [entry, "status", "--project", projectPath], smokeEnvironment);
    run(
      process.execPath,
      [entry, "search", "打包验证", "--semantic", "--project", projectPath],
      smokeEnvironment,
    );
  } finally {
    await rm(smokeRoot, { recursive: true, force: true });
  }
}

function run(command, argumentsList, environment = {}) {
  const result = spawnSync(command, argumentsList, {
    cwd: temporaryDirectory,
    env: { ...process.env, npm_config_update_notifier: "false", ...environment },
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${argumentsList.join(" ")} 执行失败，退出码 ${result.status ?? "unknown"}。`,
    );
  }
}
