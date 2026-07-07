import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = resolve(root, "dist");
const outputPath = resolve(outputDir, "douyin-toolkit-extension.zip");

await mkdir(outputDir, { recursive: true });
await rm(outputPath, { force: true });

await execFileAsync("zip", [
  "-r",
  outputPath,
  "manifest.json",
  "src",
  "package.json",
  "-x",
  "*.DS_Store",
], { cwd: root });

console.log(outputPath);
