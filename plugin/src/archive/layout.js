// Public paths describe the collection and media type. Quality stays private.
import { readableBase } from "./naming.js";
export function pathName(value, fallback = "未命名作者") {
  const name = String(value || "")
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_")
    .replace(/[.\s]+$/g, "")
    .trim();
  return Array.from(name || fallback)
    .slice(0, 64)
    .join("");
}
export function authorFolder(work) {
  const existing = work.authorFolder;
  if (existing && !existing.includes("..")) {
    if (existing.startsWith("data/我的关注/")) return existing;
    if (existing.startsWith("data/关注/"))
      return existing.replace("data/关注/", "data/我的关注/");
  }
  return `data/我的关注/${pathName(work.authorName)}_${pathName(work.authorUid, "身份待核对")}`;
}
export function sourceRoot(scope, work) {
  return scope === "following"
    ? authorFolder(work)
    : scope === "bookmarked"
      ? "data/收藏"
      : "data/喜欢";
}
export function mediaRoot(item, work) {
  return sourceRoot(item.scope, work);
}
export function pathScope(path) {
  if (/(^|\/)(我的关注|关注)\//.test(path)) return "following";
  if (/(^|\/)(喜欢|点赞)\//.test(path)) return "liked";
  if (/(^|\/)收藏\//.test(path)) return "bookmarked";
  return "shared";
}
export function mediaBucket(part) {
  return part.role === "cover" || /^cover(?:-|$)/.test(part.partId || "")
    ? "cover"
    : part.kind === "image"
      ? "image"
      : "video";
}
export function layoutMetadata(parts = [], previous = {}) {
  const partCounts = { ...previous.partCounts },
    partOrder = { ...previous.partOrder };
  for (const bucket of ["video", "image", "cover"]) {
    const unique = [
      ...new Map(
        parts
          .filter((part) => mediaBucket(part) === bucket)
          .map((part) => [part.partId, part]),
      ).values(),
    ];
    unique.sort(
      (a, b) =>
        Number(a.order || a.kindIndex || a.partId?.match(/-(\d+)$/)?.[1] || 1) -
          Number(
            b.order || b.kindIndex || b.partId?.match(/-(\d+)$/)?.[1] || 1,
          ) || String(a.partId).localeCompare(String(b.partId)),
    );
    unique.forEach((part, index) => {
      partOrder[part.partId] ||= index + 1;
    });
    partCounts[bucket] = Math.max(
      Number(partCounts[bucket] || 0),
      unique.length,
    );
  }
  if (previous.mediaType === "multi_video")
    partCounts.video = Math.max(2, partCounts.video);
  if (previous.mediaType === "multi_image")
    partCounts.image = Math.max(2, partCounts.image);
  return { partCounts, partOrder };
}
function parts(repo, work) {
  const selected = new Map();
  for (const path of work.files || []) {
    const file = repo.state.files[path];
    if (!file?.complete || file.pendingDelete) continue;
    const key = file.partId || file.path.split("/").at(-1),
      prior = selected.get(key);
    const score = (value) =>
      (value.qualityOutcome === "best" ? 1e15 : 0) +
      (value.quality?.width || 0) * (value.quality?.height || 0);
    if (!prior || score(file) > score(prior)) selected.set(key, file);
  }
  return [...selected.values()];
}
export function layoutWork(repo, work) {
  return { ...work, ...layoutMetadata(parts(repo, work), work) };
}
function extension(part) {
  if (part.kind === "video") return "mp4";
  const mime = String(part.contentType || "")
    .split(";")[0]
    .toLowerCase();
  const types = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/avif": "avif",
    "image/gif": "gif",
  };
  if (types[mime]) return types[mime];
  const ext = String(part.path || part.url || "")
    .split(/[?#]/)[0]
    .match(/\.(jpe?g|png|webp|avif|gif)$/i)?.[1]
    ?.toLowerCase();
  return ext === "jpeg" ? "jpg" : ext || "jpg";
}
export function sourceTargetPath(work, part, scope) {
  const bucket = mediaBucket(part),
    type = { cover: "封面", video: "视频", image: "图片" }[bucket];
  const root = `${sourceRoot(scope, work)}/${type}`,
    id = readableBase(work, scope);
  const multiple = Number(work.partCounts?.[bucket] || 1) > 1;
  const index =
    work.partOrder?.[part.partId] ||
    part.kindIndex ||
    Number(part.partId?.match(/-(\d+)$/)?.[1] || 1);
  return multiple
    ? `${root}/${id}/${String(index).padStart(2, "0")}.${extension(part)}`
    : `${root}/${id}.${extension(part)}`;
}
export function hasSourceLayout(repo, work, scope) {
  const model = layoutWork(repo, work);
  return parts(repo, work).every((part) => {
    const path = sourceTargetPath(model, part, scope);
    return (
      work.files?.includes(path) &&
      sameRepresentation(part, repo.state.files[path])
    );
  });
}
function sameRepresentation(part, file) {
  return (
    file?.complete &&
    !file.pendingDelete &&
    file.partId === part.partId &&
    file.size === part.size &&
    JSON.stringify(file.quality || {}) === JSON.stringify(part.quality || {}) &&
    file.qualityOutcome === part.qualityOutcome
  );
}
export async function ensureSourceLayout(
  repo,
  id,
  scope,
  { signal, hashFile } = {},
) {
  let work = repo.state.works[id];
  if (!work || !repo.io.copy || hasSourceLayout(repo, work, scope)) return;
  const selected = parts(repo, work);
  const model = layoutWork(repo, work);
  const conflicts = selected
    .map((part) => repo.state.files[sourceTargetPath(model, part, scope)])
    .filter(
      (file) =>
        file?.complete &&
        !file.pendingDelete &&
        !selected.some(
          (part) =>
            part.path === file.path &&
            sourceTargetPath(model, part, scope) === part.path,
        ),
    );
  const renumbering = selected.some((part) => {
    const target = repo.state.files[sourceTargetPath(model, part, scope)];
    return (
      target?.complete && !target.pendingDelete && target.partId !== part.partId
    );
  });
  if (renumbering) {
    // Preserve every original before changing any numbered public filename.
    const originals = [
      ...new Map(
        [...selected, ...conflicts].map((file) => [file.path, file]),
      ).values(),
    ];
    const tx = crypto.randomUUID(),
      mapping = new Map(),
      staged = [];
    for (const [index, part] of originals.entries()) {
      signal?.throwIfAborted();
      const path = `data/.appdata/layout-staging/${tx}/${index}.${extension(part)}`;
      await repo.io.copy(part.path, path, { signal });
      if ((await repo.io.file(path)).size !== part.size)
        throw new Error("媒体编号整理未完成，原文件已保留");
      if (
        hashFile &&
        (await hashFile(await repo.io.file(path), signal)) !==
          (await hashFile(await repo.io.file(part.path), signal))
      )
        throw new Error("媒体编号内容核对不一致，原文件已保留");
      mapping.set(part.path, path);
      staged.push({ ...part, path, pendingDelete: false });
    }
    await repo.commit({
      files: [
        ...staged,
        ...originals.map((part) => ({
          ...part,
          pendingDelete: true,
          supersededBy: mapping.get(part.path),
        })),
      ],
      works: Object.values(repo.state.works)
        .filter((other) => other.files?.some((path) => mapping.has(path)))
        .map((other) => ({
          ...other,
          files: other.files.map((path) => mapping.get(path) || path),
        })),
    });
    await ensureSourceLayout(repo, id, scope, { signal, hashFile });
    for (const original of originals)
      if (repo.state.files[original.path]?.pendingDelete && repo.io.remove) {
        try {
          await repo.io.remove(original.path);
          await repo.commit({
            files: [{ path: original.path, removed: true }],
          });
        } catch (error) {
          if (
            repo.poisoned ||
            ["NotAllowedError", "QuotaExceededError"].includes(error.name)
          )
            throw error;
        }
      }
    return;
  }
  for (const part of selected) {
    signal?.throwIfAborted();
    work = layoutWork(repo, repo.state.works[id]);
    const to = sourceTargetPath(work, part, scope);
    if (
      work.files.includes(to) &&
      sameRepresentation(part, repo.state.files[to])
    )
      continue;
    if (!repo.state.files[to]) {
      let existing;
      try {
        existing = await repo.io.file(to);
      } catch (error) {
        if (error.name !== "NotFoundError") throw error;
      }
      if (existing?.size) {
        const backup = `data/.appdata/backups/layout-conflicts/${crypto.randomUUID()}/${to.split("/").at(-1)}`;
        await repo.io.copy(to, backup, { signal });
      }
    }
    await repo.io.copy(part.path, to, { signal });
    if ((await repo.io.file(to)).size !== part.size)
      throw new Error("分类文件复制未完成，原文件已保留");
    if (
      hashFile &&
      (await hashFile(await repo.io.file(to), signal)) !==
        (await hashFile(await repo.io.file(part.path), signal))
    )
      throw new Error("分类文件内容核对不一致，原文件已保留");
    const replace =
      pathScope(part.path) === "shared" || pathScope(part.path) === scope;
    const files = replace
      ? work.files.map((path) => (path === part.path ? to : path))
      : [...work.files, to];
    const newWork = { ...work, files: [...new Set(files)] };
    const shared = Object.values(repo.state.works).some(
      (other) => other.id !== id && other.files?.includes(part.path),
    );
    const retire = replace && !shared && part.path !== to;
    await repo.commit({
      files: [
        { ...part, path: to, workId: id },
        ...(retire ? [{ ...part, pendingDelete: true, supersededBy: to }] : []),
      ],
      works: [newWork],
      ...(retire ? { aliases: [{ from: part.path, to }] } : {}),
    });
    if (retire && repo.io.remove) {
      try {
        await repo.io.remove(part.path);
        await repo.commit({ files: [{ path: part.path, removed: true }] });
      } catch (error) {
        if (
          repo.poisoned ||
          ["NotAllowedError", "QuotaExceededError"].includes(error.name)
        )
          throw error;
      }
    }
  }
}
