import { cp, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = resolve(root, "dist");
await mkdir(outputDir, { recursive: true });
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(manifest.version)) throw new Error("Invalid extension version");
// Each build gets its own directory; never overwrite a previously shared build.
const buildDir = await mkdtemp(join(outputDir, "portable-"));
const folder = join(buildDir, `douyin-toolkit-extension-v${manifest.version}`);
await mkdir(folder);
// Allowlist only runtime resources and standalone instructions. Never copy the
// repository, browser profiles, diagnostics, node_modules or download archives.
await cp(join(root, "manifest.json"), join(folder, "manifest.json"));
await cp(join(root, "src"), join(folder, "src"), { recursive: true });
await cp(join(root, "INSTALL.md"), join(folder, "安装说明.md"));
const outputPath = join(buildDir, `${basename(folder)}.zip`);
if (process.platform === "win32") {
  const literal = value => `'${value.replaceAll("'", "''")}'`;
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath ${literal(folder)} -DestinationPath ${literal(outputPath)} -CompressionLevel Optimal`,
  ]);
} else {
  await execFileAsync("zip", ["-r", outputPath, basename(folder)], { cwd: buildDir });
}
console.log(JSON.stringify({ version: manifest.version, folder, zip: outputPath }, null, 2));
