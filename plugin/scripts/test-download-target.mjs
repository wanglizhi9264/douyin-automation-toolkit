import assert from "node:assert/strict";
import fs from "node:fs";

import { resolveDownloadTargetRecord } from "../src/shared/download.js";

let requests = 0;
const handle = {
  async queryPermission() {
    return "prompt";
  },
  async requestPermission() {
    requests += 1;
    return "granted";
  },
};

const passive = await resolveDownloadTargetRecord({ handle, label: "backup" });
assert.equal(passive.permission, "prompt");
assert.equal(requests, 0);

const granted = await resolveDownloadTargetRecord(
  { handle, label: "backup" },
  { requestPermission: true },
);
assert.equal(granted.permission, "granted");
assert.equal(granted.label, "backup");
assert.equal(requests, 1);
assert.equal(await resolveDownloadTargetRecord(null), null);

const pickerSource = fs.readFileSync(new URL("../src/folder-picker/app.js", import.meta.url), "utf8");
const backgroundSource = fs.readFileSync(new URL("../src/background.js", import.meta.url), "utf8");
assert.match(pickerSource, /startIn: stored\?\.handle \|\| "videos"/);
assert.match(pickerSource, /getDirectoryHandle\("data", \{ create: true \}\)/);
assert.match(pickerSource, /getDirectoryHandle\("\.appdata", \{ create: true \}\)/);
assert.match(backgroundSource, /pickerUrl\.searchParams\.set\("returnTabId"/);

console.log("OK: folder permission reuse and archive initialization tests passed");
