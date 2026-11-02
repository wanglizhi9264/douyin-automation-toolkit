import { checkAbort } from "../core/model.js";
import { ROOT } from "../archive/fs.js";
import { relocateFollowing } from "./author-folders.js";
import { pathScope } from "../archive/layout.js";
import { prepareReadableNames } from "./names.js";

function hasher() {
  const worker = new Worker(new URL("./hash-worker.js", import.meta.url), {
    type: "module",
  });
  let seq = 0;
  const waiting = new Map();
  worker.onmessage = ({ data }) => {
    const entry = waiting.get(data.id);
    if (entry) {
      waiting.delete(data.id);
      data.error
        ? entry.reject(new Error(data.error))
        : entry.resolve(data.hash);
    }
  };
  worker.onerror = (error) => {
    for (const entry of waiting.values())
      entry.reject(new Error(error.message || "校验进程异常"));
    waiting.clear();
  };
  return {
    hash: (file) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        waiting.set(id, { resolve, reject });
        worker.postMessage({ id, file });
      }),
    close: () => worker.terminate(),
  };
}
export function manifestParts(manifest) {
  const cover = manifest.files?.cover
    ? [
        {
          path: manifest.files.cover,
          partId: "cover",
          kind: "image",
          optional: true,
        },
      ]
    : [];
  if (manifest.parts?.length)
    return [
      ...manifest.parts.map((part) => ({
        path: part.path,
        partId: part.partId,
        kind: part.kind,
        size: part.size,
      })),
      ...cover,
    ];
  const files = manifest.files || {};
  const records = [];
  const videos = files.videos || (files.video ? [files.video] : []),
    images = files.images || [];
  videos.forEach((path, index) =>
    records.push({ path, partId: `video-${index + 1}`, kind: "video" }),
  );
  images.forEach((path, index) =>
    records.push({ path, partId: `image-${index + 1}`, kind: "image" }),
  );
  return [...records, ...cover];
}
export async function organize(
  repo,
  { signal, onProgress = () => {}, lock = navigator.locks } = {},
) {
  if (!lock) throw new Error("当前浏览器不支持备份库锁");
  return lock.request(
    "douyin-archive-" + repo.state.id,
    { ifAvailable: true },
    async (acquired) => {
      if (!acquired) throw new Error("备份库正在下载，请先暂停任务");
      await repo.load();
      const hash = hasher();
      let checked = 0,
        reclaimed = 0,
        removed = 0;
      const issues = [];
      async function removeDuplicate(record) {
        checkAbort(signal);
        try {
          await repo.io.remove(record.path);
        } catch (error) {
          if (error.name !== "NotFoundError") {
            issues.push(`暂未删除 ${record.path}：${error.message}`);
            return;
          }
        }
        await repo.commit({ files: [{ path: record.path, removed: true }] });
        reclaimed += record.size;
        removed++;
        onProgress({
          checked,
          reclaimed,
          removed,
          message: "正在合并相同媒体",
        });
      }
      function resolveAlias(path) {
        const seen = new Set();
        while (repo.state.aliases?.[path]) {
          if (seen.has(path)) throw new Error("媒体引用记录异常");
          seen.add(path);
          path = repo.state.aliases[path];
        }
        return path;
      }
      try {
        for (const record of Object.values(repo.state.files).filter(
          (f) => f.pendingDelete,
        ))
          await removeDuplicate(record);
        // Import old manifests only on this explicitly requested idle path.
        const entries = await repo.io.list(`${ROOT}/manifests`);
        for (const entry of entries) {
          checkAbort(signal);
          if (entry.kind !== "file" || !entry.name.endsWith(".json")) continue;
          let manifest;
          try {
            manifest = JSON.parse(await (await entry.getFile()).text());
          } catch {
            issues.push(`无法读取记录 ${entry.name}`);
            continue;
          }
          const id = String(manifest.awemeId || "");
          if (!id) continue;
          if (repo.state.works[id]?.legacy === false) continue;
          const parts = manifestParts(manifest);
          if (!parts.length) continue;
          const records = [];
          let complete = true;
          for (const part of parts) {
            part.path = resolveAlias(part.path);
            try {
              const file = await repo.io.file(part.path);
              const partial = await repo.io.read(part.path + ".resume.json");
              if (
                !file.size ||
                partial ||
                (part.size && file.size !== part.size)
              ) {
                if (part.optional) continue;
                complete = false;
                break;
              }
              records.push({
                ...part,
                workId: id,
                size: file.size,
                complete: true,
              });
            } catch (error) {
              if (error.name !== "NotFoundError") throw error;
              if (part.optional) continue;
              complete = false;
              break;
            }
          }
          const previous = repo.state.works[id];
          if (!complete) {
            issues.push(`${id} 的历史媒体不完整`);
            if (previous?.legacy)
              await repo.commit({ works: [{ ...previous, complete: false }] });
            continue;
          }
          const source =
            manifest.source === "favorite_api"
              ? "liked"
              : manifest.source || "liked";
          await repo.commit({
            files: records,
            works: [
              {
                ...previous,
                id,
                complete: true,
                legacy: false,
                desc: manifest.desc,
                authorName: manifest.authorName,
                sources: [...new Set([...(previous?.sources || []), source])],
                files: [
                  ...new Set([
                    ...(previous?.files || []),
                    ...records.map((r) => r.path),
                  ]),
                ],
              },
            ],
          });
          onProgress({
            checked: ++checked,
            reclaimed,
            removed,
            message: "正在核对历史媒体",
          });
        }
        const files = Object.values(repo.state.files),
          groups = new Map();
        for (const record of files) {
          checkAbort(signal);
          if (record.pendingDelete) continue;
          try {
            const file = await repo.io.file(record.path);
            const partial = await repo.io.read(record.path + ".resume.json");
            if (file.size !== record.size || !file.size || partial)
              throw new Error("媒体大小不符或下载未完成");
            const key = [
              pathScope(record.path),
              record.workId,
              record.partId,
              record.kind,
              record.size,
            ].join("|");
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(record);
          } catch (error) {
            if (error.name === "NotAllowedError") throw error;
            issues.push(`${record.path}：${error.message}`);
            const work = repo.state.works[record.workId];
            await repo.commit({
              files: [{ ...record, complete: false }],
              works: work ? [{ ...work, complete: false }] : [],
            });
          }
          onProgress({
            checked: ++checked,
            reclaimed,
            removed,
            message: "正在核对本地文件",
          });
        }
        for (const group of groups.values()) {
          if (group.length < 2) continue;
          const kept = [];
          for (const record of group) {
            checkAbort(signal);
            const digest = await hash.hash(await repo.io.file(record.path));
            checkAbort(signal);
            const match = kept.find((k) => k.hash === digest);
            if (!match) {
              kept.push({ ...record, hash: digest });
              continue;
            }
            // Persist references first; an interrupted deletion leaves an extra file, never a dangling reference.
            const works = Object.values(repo.state.works)
              .filter((w) => w.files?.includes(record.path))
              .map((w) => ({
                ...w,
                files: [
                  ...new Set(
                    w.files.map((path) =>
                      path === record.path ? match.path : path,
                    ),
                  ),
                ],
              }));
            await repo.commit({
              works,
              aliases: [{ from: record.path, to: match.path }],
              files: [{ ...record, pendingDelete: true }],
            });
            await removeDuplicate(record);
          }
        }
        await prepareReadableNames(repo, { signal, onProgress });
        const layout = await relocateFollowing(repo, {
          signal,
          hashFile: (file) => hash.hash(file),
          onProgress,
        });
        issues.push(...layout.issues);
        await repo.commit({ verifiedAt: new Date().toISOString() });
        await repo.compact();
        return {
          checked,
          reclaimed,
          removed,
          moved: layout.moved,
          issues,
          unknown: Object.values(repo.state.works).filter((w) => w.legacy)
            .length,
        };
      } finally {
        hash.close();
      }
    },
  );
}
