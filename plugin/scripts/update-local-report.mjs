import fs from "node:fs/promises";
import path from "node:path";
import { Repository } from "../src/archive/repository.js";
import {
  readReportMetadata,
  buildReportModel,
  renderLibraryReport,
} from "../src/archive/report.js";
const root = path.resolve(process.argv[2] || "");
if (!process.argv[2])
  throw new Error(
    "Usage: node scripts/update-local-report.mjs BACKUP_ROOT [--output HTML_PATH]",
  );
const archive = JSON.parse(
  await fs.readFile(path.join(root, "data/.appdata/archive.json"), "utf8"),
);
if (archive.schemaVersion !== 2)
  throw new Error("需要 v2 备份目录，未修改任何文件");
const io = {
  async read(relative) {
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep))
      throw new Error("Invalid metadata path");
    try {
      return await fs.readFile(file, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  },
  async json(relative) {
    const value = await this.read(relative);
    return value === null ? null : JSON.parse(value);
  },
};
const repo = new Repository(io);
await repo.load();
const model = buildReportModel(repo.state, {
    folderLabel: root,
    metadata: await readReportMetadata(io),
  }),
  html = renderLibraryReport(model);
const outputArg = process.argv.indexOf("--output"),
  output =
    outputArg >= 0
      ? path.resolve(process.argv[outputArg + 1])
      : path.join(root, "本地库.html");
if (output === path.join(root, "本地库.html")) {
  const old = await io.read("本地库.html");
  if (old && !old.includes('data-report-version="0.8.9"')) {
    const backup = path.join(
      root,
      "data/.appdata/backups",
      `report-before-0.8.9-${Date.now()}.html`,
    );
    await fs.mkdir(path.dirname(backup), { recursive: true });
    await fs.copyFile(output, backup, fs.constants.COPYFILE_EXCL);
  }
}
const temporary = output + `.${process.pid}.tmp`;
await fs.writeFile(temporary, html, "utf8");
await fs.rename(temporary, output);
console.log(
  JSON.stringify(
    {
      output,
      version: model.version,
      unique: model.stats.unique,
      failed: model.stats.failed,
      pending: model.stats.pending,
      quality: model.outcomes,
      sources: model.sources.map((s) => ({
        scope: s.scope,
        total: s.total,
        saved: s.saved,
      })),
      bytes: Buffer.byteLength(html),
    },
    null,
    2,
  ),
);
