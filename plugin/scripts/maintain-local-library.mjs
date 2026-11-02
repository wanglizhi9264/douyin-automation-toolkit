// Offline maintenance. Close Douyin tabs first. Every run is bounded and can
// resume from its plan; mutations use the same sealed journal as the extension.
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash, webcrypto } from "node:crypto";
import { Repository } from "../src/archive/repository.js";
import { prepareReadableNames } from "../src/maintenance/names.js";
import {
  relocateFollowing,
  replaceMediaPath,
  authorIndex,
} from "../src/maintenance/author-folders.js";
import {
  pathScope,
  authorFolder,
  sourceRoot,
  sourceTargetPath,
  layoutWork,
} from "../src/archive/layout.js";
globalThis.crypto ||= webcrypto;
const root = path.resolve(process.argv[2] || "");
if (!process.argv[2])
  throw new Error(
    "Usage: node scripts/maintain-local-library.mjs BACKUP_ROOT [--apply] [--plan FILE] [--seconds 20]",
  );
const arg = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? fallback : process.argv[at + 1];
};
const planPath = path.resolve(
  arg("--plan", "/tmp/douyin-library-maintenance-plan.json"),
);
const apply = process.argv.includes("--apply");
const seconds = Math.max(1, Math.min(25, Number(arg("--seconds", 20))));
const controller = new AbortController(),
  { signal } = controller;
const timer = setTimeout(() => controller.abort(), seconds * 1000);
const resolve = (relative) => {
  const result = path.resolve(root, relative);
  if (!result.startsWith(root + path.sep))
    throw new Error("Path outside backup root");
  return result;
};
const io = {
  maintenanceMode: true,
  async mkdir(p) {
    await fs.mkdir(resolve(p), { recursive: true });
  },
  async read(p) {
    try {
      return await fs.readFile(resolve(p), "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  },
  async json(p) {
    const value = await this.read(p);
    return value === null ? null : JSON.parse(value);
  },
  async write(p, value) {
    const file = resolve(p);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + ".maintenance-tmp";
    const handle = await fs.open(tmp, "w");
    try {
      await handle.writeFile(
        typeof value === "string" ? value : JSON.stringify(value),
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, file);
  },
  async file(p) {
    try {
      const stat = await fs.stat(resolve(p));
      return { size: stat.size, path: resolve(p), name: path.basename(p) };
    } catch (e) {
      if (e.code === "ENOENT")
        throw new DOMException("missing", "NotFoundError");
      throw e;
    }
  },
  async copy(from, to) {
    await fs.mkdir(path.dirname(resolve(to)), { recursive: true });
    await fs.copyFile(
      resolve(from),
      resolve(to),
      fs.constants.COPYFILE_FICLONE,
    );
  },
  async remove(p) {
    try {
      await fs.unlink(resolve(p));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  },
};
async function replayMoves(repo, intent) {
  const receipt = "data/.appdata/maintenance-move.json";
  if (intent.phase) {
    if (intent.phase === "stage") {
      for (const move of intent.moves) {
        let staged = false;
        try {
          await fs.access(resolve(move.stage));
          staged = true;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (!staged) {
          await fs.mkdir(path.dirname(resolve(move.stage)), {
            recursive: true,
          });
          await fs.rename(resolve(move.from), resolve(move.stage));
        }
      }
      intent.phase = "promote";
      await io.write(receipt, intent);
    }
    for (const move of intent.moves) {
      let staged = false;
      try {
        await fs.access(resolve(move.stage));
        staged = true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (staged) {
        try {
          await fs.access(resolve(move.to));
          throw new Error("Move target was not vacated: " + move.to);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        await fs.mkdir(path.dirname(resolve(move.to)), { recursive: true });
        await fs.rename(resolve(move.stage), resolve(move.to));
      }
      if ((await io.file(move.to)).size !== move.size)
        throw new Error("Moved file needs verification: " + move.to);
    }
  } else {
    // Compatibility with receipts created by 0.8.2 maintenance.
    for (const move of intent.moves || [intent]) {
      let sourceExists = true;
      try {
        await fs.access(resolve(move.from));
      } catch (error) {
        if (error.code === "ENOENT") sourceExists = false;
        else throw error;
      }
      if (sourceExists) {
        try {
          await fs.access(resolve(move.to));
          throw new Error("Move target already exists: " + move.to);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        await fs.mkdir(path.dirname(resolve(move.to)), { recursive: true });
        await fs.rename(resolve(move.from), resolve(move.to));
      }
      if ((await io.file(move.to)).size !== move.size)
        throw new Error("Interrupted move needs verification: " + move.to);
    }
  }
  await repo.commit(intent.patch);
  await io.remove(receipt);
}
async function fastRelocate(repo) {
  const index = authorIndex(repo.state),
    authors = [];
  for (const original of Object.values(repo.state.works)) {
    if (!original.sources?.includes("following")) continue;
    const names = index.names.get(original.authorName);
    const uid =
      original.authorUid ||
      index.items.get(original.id) ||
      (names?.size === 1 ? [...names][0] : "");
    const work = layoutWork(repo, {
      ...original,
      ...(uid ? { authorUid: String(uid) } : {}),
    });
    const folder = authorFolder(work);
    if (
      work.authorUid !== original.authorUid ||
      folder !== original.authorFolder
    )
      authors.push({ ...work, authorFolder: folder });
  }
  if (authors.length) await repo.commit({ works: authors });
  const pending = new Map(),
    targets = new Set();
  for (const original of Object.values(repo.state.works)) {
    const work = layoutWork(repo, original);
    for (const from of work.files || []) {
      signal.throwIfAborted();
      const record = repo.state.files[from],
        scope = pathScope(from);
      if (pending.has(from) || !record?.complete || record.pendingDelete)
        continue;
      const targetScope =
        scope === "shared"
          ? work.sources.find((source) =>
              ["liked", "bookmarked", "following"].includes(source),
            )
          : scope;
      const to = sourceTargetPath(work, record, targetScope);
      if (from === to || targets.has(to)) continue;
      const source = await io.file(from);
      if (source.size !== record.size || (await io.read(from + ".resume.json")))
        continue;
      pending.set(from, { from, to, size: source.size });
      targets.add(to);
    }
  }
  // A numbered gallery can move 03→02, 04→03. Keep dependencies in one
  // transaction and stage all originals before assigning their new names.
  const blocked = new Set();
  for (const move of pending.values()) {
    try {
      await fs.access(resolve(move.to));
      if (!pending.has(move.to)) blocked.add(move.from);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const move of pending.values())
      if (blocked.has(move.to) && !blocked.has(move.from)) {
        blocked.add(move.from);
        changed = true;
      }
  }
  for (const from of blocked) pending.delete(from);
  let batch = [],
    scheduled = new Set();
  const flush = async () => {
    if (!batch.length) return;
    const mapping = new Map(batch.map((move) => [move.from, move.to]));
    const tx = crypto.randomUUID();
    const moves = batch.map((move, i) => ({
      ...move,
      stage: `data/.appdata/layout-staging/${tx}/${i}`,
    }));
    const patch = {
      files: [
        ...moves.map((move) => ({ path: move.from, removed: true })),
        ...moves.map((move) => ({
          ...repo.state.files[move.from],
          path: move.to,
        })),
      ],
      works: Object.values(repo.state.works)
        .filter((work) => work.files?.some((path) => mapping.has(path)))
        .map((work) => ({
          ...work,
          files: [
            ...new Set(work.files.map((path) => mapping.get(path) || path)),
          ],
        })),
      aliases: moves.map((move) => ({ from: move.from, to: move.to })),
    };
    const intent = { phase: "stage", moves, patch };
    await io.write("data/.appdata/maintenance-move.json", intent);
    await replayMoves(repo, intent);
    plan.moved += moves.length;
    console.log(`moved ${plan.moved} media files`);
    batch = [];
  };
  for (const move of pending.values()) {
    signal.throwIfAborted();
    if (scheduled.has(move.from)) continue;
    const group = [],
      seen = new Set();
    let current = move;
    while (current && !scheduled.has(current.from) && !seen.has(current.from)) {
      seen.add(current.from);
      group.push(current);
      current = pending.get(current.to);
    }
    if (batch.length + group.length > 100) await flush();
    for (const item of group) {
      batch.push(item);
      scheduled.add(item.from);
    }
  }
  await flush();
}
async function digest(file) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file.path, {
    highWaterMark: 1024 * 1024,
    signal,
  }))
    hash.update(bytes);
  return hash.digest("hex");
}
function referenceKey(relative) {
  const type = relative.match(/(?:^|\/)(封面|视频|图片)\//);
  if (!type) return null;
  const marked = [...relative.matchAll(/\[([0-9a-f]{1,128})\]/gi)].at(-1)?.[1];
  const token = marked || relative.match(/(?:^|\/)(\d{15,20})(?:\/|\.|$)/)?.[1];
  if (!token) return null;
  const leaf = path.posix.basename(relative),
    ext = path.posix.extname(leaf).toLowerCase();
  const number = leaf.match(/^(\d+)\.[^.]+$/)?.[1];
  const scope = pathScope(relative);
  const uid =
    scope === "following"
      ? relative.slice(0, type.index).match(/_(\d+)$/)?.[1] || "unknown"
      : "";
  return [
    scope,
    uid,
    type[1],
    token.toLowerCase(),
    number && number !== token ? number : "",
    ext,
  ].join("|");
}
function referenceIndex(repo) {
  const exact = new Map(),
    keys = new Map();
  for (const work of Object.values(repo.state.works))
    for (const relative of work.files || []) {
      exact.set(relative.normalize("NFC"), relative);
      const key = referenceKey(relative);
      if (key) {
        const values = keys.get(key) || new Set();
        values.add(relative);
        keys.set(key, values);
      }
    }
  return {
    exact,
    keys,
    candidates(relative, size) {
      const direct = exact.get(relative.normalize("NFC"));
      if (direct) return [direct];
      return [...(keys.get(referenceKey(relative)) || [])].filter(
        (p) => size === undefined || repo.state.files[p]?.size === size,
      );
    },
  };
}
async function restoreReferencedQuarantine(repo) {
  if (!plan.backup) return;
  const prefix = `${plan.backup}/隔离`;
  const refs = referenceIndex(repo);
  async function walk(relative = "") {
    signal.throwIfAborted();
    let entries;
    try {
      entries = await fs.readdir(
        resolve(prefix + (relative ? "/" + relative : "")),
        { withFileTypes: true },
      );
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      signal.throwIfAborted();
      const p = relative ? relative + "/" + entry.name : entry.name;
      if (entry.isDirectory()) await walk(p);
      else if (entry.isFile()) {
        const from = prefix + "/" + p;
        const candidate = await io.file(from);
        const matches = refs.candidates(p, candidate.size);
        if (matches.length !== 1) continue;
        const to = matches[0],
          record = repo.state.files[to];
        let existing;
        try {
          existing = await io.file(to);
        } catch (error) {
          if (error.name !== "NotFoundError") throw error;
        }
        if (existing) continue;
        if (candidate.size !== record.size)
          throw new Error("隔离文件大小不符，原文件已保留：" + p);
        await fs.mkdir(path.dirname(resolve(to)), { recursive: true });
        await fs.rename(resolve(from), resolve(to));
        plan.restored = (plan.restored || 0) + 1;
        plan.quarantined = Math.max(0, plan.quarantined - 1);
      }
    }
  }
  await walk();
}
async function inventory() {
  const rows = [];
  async function walk(relative = "") {
    signal.throwIfAborted();
    for (const entry of await fs.readdir(relative ? resolve(relative) : root, {
      withFileTypes: true,
    })) {
      signal.throwIfAborted();
      if (entry.name.startsWith(".")) continue;
      const p = relative ? relative + "/" + entry.name : entry.name;
      if (entry.isDirectory()) await walk(p);
      else if (entry.isFile()) {
        const stat = await fs.stat(resolve(p));
        rows.push({ path: p, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  }
  await walk();
  return rows;
}
const repo = new Repository(io);
let plan,
  lock,
  failed = false,
  mutableStarted = false;
const lockPath = "data/.appdata/maintenance.json";
const checkHeads = async () =>
  JSON.stringify(
    await Promise.all([
      io.read("data/.appdata/v2/heads/a.json"),
      io.read("data/.appdata/v2/heads/b.json"),
    ]),
  );
try {
  await repo.load();
  try {
    plan = JSON.parse(await fs.readFile(planPath, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (plan && (plan.archiveId !== repo.state.id || plan.root !== root))
    throw new Error("Plan belongs to another library");
  if (!plan) {
    const layoutOnly = process.argv.includes("--layout-only");
    const rows = layoutOnly ? [] : await inventory();
    const groups = new Map();
    for (const row of rows.filter(
      (row) => /\.(mp4|jpe?g|png|webp)$/i.test(row.path) && row.size > 0,
    )) {
      const record = repo.state.files[row.path];
      const key = [
        pathScope(row.path),
        record?.workId || row.path.match(/\d{17,20}/)?.[0] || "unindexed",
        record?.partId || path.basename(row.path),
        row.size,
      ].join("|");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    plan = {
      root,
      archiveId: repo.state.id,
      revision: repo.head.revision,
      createdAt: new Date().toISOString(),
      readableNames: process.argv.includes("--readable-names"),
      phase: layoutOnly ? "authors" : "hash",
      groups: [...groups.values()].filter((group) => group.length > 1),
      groupIndex: 0,
      duplicates: [],
      removed: 0,
      reclaimed: 0,
      moved: 0,
      quarantined: 0,
      issues: [],
    };
  }
  if (!apply && plan.phase !== "hash") {
    console.log(
      JSON.stringify({
        phase: plan.phase,
        duplicates: plan.duplicates.length,
        duplicateBytes: plan.duplicates.reduce((sum, row) => sum + row.size, 0),
        planPath,
      }),
    );
  } else if (plan.phase === "hash") {
    const refs = new Set(
      Object.values(repo.state.works).flatMap((work) => work.files || []),
    );
    for (; plan.groupIndex < plan.groups.length; plan.groupIndex++) {
      signal.throwIfAborted();
      const group = plan.groups[plan.groupIndex];
      group.sort(
        (a, b) =>
          Number(refs.has(b.path)) - Number(refs.has(a.path)) ||
          a.path.length - b.path.length ||
          a.path.localeCompare(b.path),
      );
      const kept = new Map(),
        duplicates = [];
      for (const row of group) {
        signal.throwIfAborted();
        const file = await io.file(row.path);
        const stat = await fs.stat(file.path);
        if (
          stat.size !== row.size ||
          stat.mtimeMs !== row.mtimeMs ||
          (await io.read(row.path + ".resume.json"))
        )
          continue;
        const hash = await digest(file);
        const match = kept.get(hash);
        if (match)
          duplicates.push({
            from: row.path,
            to: match.path,
            size: row.size,
            hash,
          });
        else kept.set(hash, row);
      }
      plan.duplicates.push(...duplicates);
      if (plan.groupIndex % 100 === 0)
        console.log(
          `hash ${plan.groupIndex}/${plan.groups.length}, duplicates ${plan.duplicates.length}`,
        );
    }
    delete plan.groups;
    plan.phase = "deduplicate";
  }
  if (apply && plan.phase !== "hash") {
    const stale = await io.json(lockPath);
    if (stale) {
      let alive = true;
      try {
        process.kill(stale.pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") alive = false;
      }
      if (
        !alive &&
        stale.planPath === planPath &&
        stale.archiveId === repo.state.id
      ) {
        plan.revision = repo.head.revision;
        await io.remove(lockPath);
      }
    }
    if (repo.head.revision !== plan.revision)
      throw new Error(
        "Backup changed since audit; create a fresh plan before maintenance",
      );
    const initialHeads = await checkHeads();
    lock = await fs.open(resolve(lockPath), "wx");
    await lock.writeFile(
      JSON.stringify({
        startedAt: new Date().toISOString(),
        pid: process.pid,
        planPath,
        archiveId: repo.state.id,
      }),
    );
    if ((await checkHeads()) !== initialHeads)
      throw new Error("Browser is still writing to this backup");
    mutableStarted = true;
    const interruptedMove = await io.json(
      "data/.appdata/maintenance-move.json",
    );
    if (interruptedMove) {
      await replayMoves(repo, interruptedMove);
    }
    if (!plan.backup) {
      plan.backup = `data/.appdata/backups/maintenance-${Date.now()}`;
      await io.write(plan.backup + "/state.json", repo.state);
      await io.write(plan.backup + "/heads.json", JSON.parse(initialHeads));
    }
    await restoreReferencedQuarantine(repo);
    // Remove a pending old copy only after its current target is rechecked.
    for (const record of Object.values(repo.state.files).filter(
      (file) => file.pendingDelete && file.supersededBy,
    )) {
      signal.throwIfAborted();
      try {
        const old = await io.file(record.path),
          current = await io.file(record.supersededBy);
        if (
          old.size === current.size &&
          (await digest(old)) === (await digest(current))
        ) {
          await io.remove(record.path);
          await repo.commit({ files: [{ path: record.path, removed: true }] });
        }
      } catch (e) {
        if (e.name !== "NotFoundError") throw e;
      }
    }
    if (plan.phase === "deduplicate") {
      for (
        let index = plan.duplicateIndex || 0;
        index < plan.duplicates.length;
        index++
      ) {
        signal.throwIfAborted();
        const row = plan.duplicates[index];
        let from;
        const to = await io.file(row.to);
        try {
          from = await io.file(row.from);
        } catch (error) {
          if (error.name !== "NotFoundError" || (await digest(to)) !== row.hash)
            throw error;
          plan.removed++;
          plan.reclaimed += row.size;
          plan.duplicateIndex = index + 1;
          continue;
        }
        if (
          from.size !== row.size ||
          to.size !== row.size ||
          (await digest(from)) !== row.hash ||
          (await digest(to)) !== row.hash
        )
          throw new Error(`Duplicate changed: ${row.from}`);
        const record = repo.state.files[row.to];
        if (
          Object.values(repo.state.works).some((work) =>
            work.files?.includes(row.from),
          )
        ) {
          if (!record?.complete)
            throw new Error(`Canonical file is not indexed: ${row.to}`);
          await replaceMediaPath(repo, row.from, record);
        } else await io.remove(row.from);
        plan.removed++;
        plan.reclaimed += row.size;
        plan.duplicateIndex = index + 1;
      }
      plan.phase = "authors";
    }
    if (plan.phase === "authors") {
      // Rename the old whole likes directory on the same volume, rather than
      // copying ~100 GB. A durable intent allows replay after interruption.
      const intentPath = "data/.appdata/maintenance-rename.json";
      let intent = await io.json(intentPath);
      if (!intent) {
        let oldExists = false,
          newExists = false;
        try {
          await fs.access(resolve("data/点赞"));
          oldExists = true;
        } catch {}
        try {
          await fs.access(resolve("data/喜欢"));
          newExists = true;
        } catch {}
        if (oldExists && !newExists) {
          const map = (p) =>
            p.startsWith("data/点赞/")
              ? p.replace("data/点赞/", "data/喜欢/")
              : p;
          const changed = Object.values(repo.state.files).filter(
            (file) => map(file.path) !== file.path,
          );
          intent = {
            from: "data/点赞",
            to: "data/喜欢",
            patch: {
              files: changed.flatMap((file) => [
                { ...file, path: map(file.path) },
                { path: file.path, removed: true },
              ]),
              works: Object.values(repo.state.works)
                .filter((work) => work.files?.some((p) => map(p) !== p))
                .map((work) => ({ ...work, files: work.files.map(map) })),
              aliases: changed.map((file) => ({
                from: file.path,
                to: map(file.path),
              })),
            },
          };
          await io.write(intentPath, intent);
        }
      }
      if (intent) {
        try {
          await fs.access(resolve(intent.from));
          await fs.rename(resolve(intent.from), resolve(intent.to));
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
          await fs.access(resolve(intent.to));
        }
        await repo.commit(intent.patch);
        await io.remove(intentPath);
      }
      if (plan.readableNames && !plan.namesPrepared) {
        const names = await prepareReadableNames(repo, { signal });
        plan.namesPrepared = true;
        console.log(`prepared ${names.prepared} readable work names`);
      }
      await fastRelocate(repo);
      const result = await relocateFollowing(repo, {
        signal,
        hashFile: digest,
        onProgress: (progress) => {
          if (progress.moved > (plan.batchMoved || 0)) {
            plan.batchMoved = progress.moved;
            plan.moved++;
          }
          if (progress.checked && progress.checked % 2000 === 0)
            console.log(
              `layout checked ${progress.checked}, moved ${plan.moved}`,
            );
        },
      });
      plan.issues.push(...result.issues);
      plan.phase = "quarantine";
    }
    if (plan.phase === "quarantine") {
      const refs = referenceIndex(repo);
      for (const row of await inventory()) {
        signal.throwIfAborted();
        if (
          refs.candidates(row.path, row.size).length ||
          (row.path.endsWith(".resume.json") &&
            refs.candidates(row.path.replace(/\.resume\.json$/, "")).length) ||
          ["本地库.html", "说明.txt"].includes(row.path)
        )
          continue;
        // Preserve all unindexed leftovers, including interrupted downloads and
        // old nested folder selections, out of the normal media directories.
        const to = `${plan.backup}/隔离/${row.path}`;
        await fs.mkdir(path.dirname(resolve(to)), { recursive: true });
        await fs.rename(resolve(row.path), resolve(to));
        const recordPath = row.path.normalize("NFC");
        if (repo.state.files[recordPath])
          await repo.commit({ files: [{ path: recordPath, removed: true }] });
        plan.quarantined++;
      }
      // Preserve nested metadata from accidental folder selections as well.
      const nested = "data/data/.appdata";
      try {
        await fs.access(resolve(nested));
        await fs.rename(
          resolve(nested),
          resolve(plan.backup + "/nested-appdata"),
        );
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      async function prune(relative = "") {
        signal.throwIfAborted();
        for (const entry of await fs.readdir(
          relative ? resolve(relative) : root,
          { withFileTypes: true },
        )) {
          if (entry.isFile() && entry.name.startsWith("._")) {
            const p = relative ? relative + "/" + entry.name : entry.name;
            const counterpart = relative
              ? relative + "/" + entry.name.slice(2)
              : entry.name.slice(2);
            let exists = true;
            try {
              await fs.access(resolve(counterpart));
            } catch (e) {
              if (e.code === "ENOENT") exists = false;
              else throw e;
            }
            if (!exists) {
              const file = await fs.open(resolve(p), "r"),
                header = Buffer.alloc(4);
              try {
                await file.read(header, 0, 4, 0);
              } finally {
                await file.close();
              }
              if (header.readUInt32BE(0) === 0x00051607) {
                const to = resolve(`${plan.backup}/隔离/${p}`);
                await fs.mkdir(path.dirname(to), { recursive: true });
                await fs.rename(resolve(p), to);
              }
            }
            continue;
          }
          if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
          const p = relative ? relative + "/" + entry.name : entry.name;
          await prune(p);
          try {
            await fs.rmdir(resolve(p));
          } catch (e) {
            if (!["ENOTEMPTY", "EEXIST", "ENOENT"].includes(e.code)) throw e;
          }
        }
      }
      await prune();
      const roots = new Set(["data/喜欢", "data/收藏", "data/我的关注"]);
      for (const work of Object.values(repo.state.works))
        if (work.sources?.includes("following")) roots.add(authorFolder(work));
      for (const folder of roots) {
        await io.mkdir(folder);
        if (folder !== "data/我的关注")
          for (const type of ["封面", "视频", "图片"])
            await io.mkdir(`${folder}/${type}`);
      }
      const pausedAt = new Date().toISOString();
      const activeTasks = Object.values(repo.state.tasks).filter((task) =>
        ["running", "starting", "pausing"].includes(task.status),
      );
      if (activeTasks.length)
        await repo.commit({
          tasks: activeTasks.map((task) => ({
            ...task,
            status: "paused",
            pausedAt,
          })),
        });
      await repo.compact();
      plan.phase = "complete";
    }
  }
} catch (error) {
  if (!signal.aborted) {
    failed = true;
    throw error;
  }
  console.log("Reached time budget; saved checkpoint for next batch");
} finally {
  clearTimeout(timer);
  if (plan && (!failed || mutableStarted)) {
    plan.revision = repo.head.revision;
    delete plan.batchMoved;
    const tmp = planPath + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(plan));
    await fs.rename(tmp, planPath);
    console.log(
      JSON.stringify({
        phase: plan.phase,
        groupsChecked: plan.groupIndex,
        removed: plan.removed,
        reclaimed: plan.reclaimed,
        moved: plan.moved,
        quarantined: plan.quarantined,
        issues: plan.issues,
        backup: plan.backup,
        planPath,
      }),
    );
  }
  if (lock) {
    await lock.close();
    // Retain the guard when recovery of a directory rename is still needed.
    if (
      !(await io.read("data/.appdata/maintenance-rename.json")) &&
      !(await io.read("data/.appdata/maintenance-move.json"))
    )
      await fs.unlink(resolve(lockPath));
  }
}
