import { checkAbort } from "../core/model.js";
import {
  authorFolder,
  ensureSourceLayout,
  pathScope,
  sourceRoot,
  sourceTargetPath,
  layoutWork,
} from "../archive/layout.js";

export function authorIndex(state) {
  const names = new Map(),
    items = new Map();
  const add = (uid, nickname) => {
    if (!uid || !nickname) return;
    const set = names.get(nickname) || new Set();
    set.add(String(uid));
    names.set(nickname, set);
  };
  for (const work of Object.values(state.works))
    add(work.authorUid, work.authorName);
  for (const task of Object.values(state.tasks || {})) {
    for (const author of task.authors || []) add(author.uid, author.nickname);
    if (task.scope !== "following") continue;
    for (const item of Object.values(task.items || {})) {
      if (item.authorUid) items.set(item.id, item.authorUid);
      add(item.authorUid, item.authorName);
    }
  }
  return { names, items };
}

// Metadata switches before removal; a crash can leave an extra copy, never
// a completed record pointing only to a deleted file.
export async function replaceMediaPath(repo, from, record) {
  const works = Object.values(repo.state.works)
    .filter((work) => work.files?.includes(from))
    .map((work) => ({
      ...work,
      files: [
        ...new Set(
          work.files.map((path) => (path === from ? record.path : path)),
        ),
      ],
    }));
  const previous = repo.state.files[from];
  await repo.commit({
    works,
    aliases: [{ from, to: record.path }],
    files: [
      record,
      ...(previous
        ? [{ ...previous, pendingDelete: true, supersededBy: record.path }]
        : []),
    ],
  });
  try {
    await repo.io.remove(from);
    if (previous) await repo.commit({ files: [{ path: from, removed: true }] });
  } catch (error) {
    if (error.name !== "NotFoundError") throw error;
    if (previous) await repo.commit({ files: [{ path: from, removed: true }] });
  }
}

export async function relocateFollowing(
  repo,
  { signal, hashFile, onProgress = () => {} } = {},
) {
  const index = authorIndex(repo.state);
  let moved = 0,
    checked = 0;
  const issues = [];
  for (const initial of Object.values(repo.state.works)) {
    checkAbort(signal);
    if (!initial.files?.length) continue;
    let work = repo.state.works[initial.id];
    const matches = index.names.get(work.authorName);
    const following = work.sources?.includes("following");
    const uid =
      work.authorUid ||
      (following
        ? index.items.get(work.id) ||
          (matches?.size === 1 ? [...matches][0] : "")
        : "");
    if (!uid && following)
      issues.push(`${work.id} 的作者身份待核对，暂按历史作者名归档`);
    work = layoutWork(repo, {
      ...work,
      ...(uid ? { authorUid: String(uid) } : {}),
    });
    const folder = authorFolder(work);
    if (
      (uid && repo.state.works[work.id].authorUid !== String(uid)) ||
      (following && work.authorFolder !== folder)
    )
      await repo.commit({
        works: [{ ...work, ...(following ? { authorFolder: folder } : {}) }],
      });
    const before = new Set(work.files);
    for (const scope of work.sources.filter((source) =>
      ["liked", "bookmarked", "following"].includes(source),
    ))
      await ensureSourceLayout(repo, work.id, scope, { signal, hashFile });
    moved += [...before].filter(
      (path) => !repo.state.works[work.id].files.includes(path),
    ).length;
    onProgress({ checked: ++checked, moved, message: "正在整理媒体分类" });
  }
  return { moved, checked, issues };
}
