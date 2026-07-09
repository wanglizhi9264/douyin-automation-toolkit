import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function collectManifestPaths(manifest) {
  const paths = [];
  if (manifest.background?.service_worker) paths.push(manifest.background.service_worker);
  for (const script of manifest.content_scripts || []) {
    paths.push(...(script.js || []), ...(script.css || []));
  }
  for (const resource of manifest.web_accessible_resources || []) {
    paths.push(...(resource.resources || []));
  }
  return [...new Set(paths)];
}

async function assertExists(relativePath) {
  await access(join(root, relativePath));
}

const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

if (manifest.manifest_version !== 3) throw new Error("manifest_version must be 3");
if (!packageJson.scripts?.check) throw new Error("package.json missing check script");

const referencedPaths = collectManifestPaths(manifest);
for (const relativePath of referencedPaths) await assertExists(relativePath);

const jsPaths = referencedPaths
  .filter((relativePath) => relativePath.endsWith(".js"))
  .concat(["scripts/check-extension.mjs", "scripts/zip-extension.mjs"]);

for (const relativePath of [...new Set(jsPaths)]) {
  await execFileAsync(process.execPath, ["--check", join(root, relativePath)]);
}

console.log(`OK: checked ${referencedPaths.length} manifest resources and ${jsPaths.length} JavaScript files`);
