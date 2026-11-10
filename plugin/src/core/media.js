import { normalizeAweme } from "../shared/api.js";
import { downloadVerifiedMedia } from "../shared/download.js";
import { httpStatus } from "../shared/http.js";
import { RetryCoordinator } from "./retry.js";
import { checkAbort } from "./model.js";
import {
  authorFolder,
  layoutMetadata,
  sourceTargetPath,
  ensureSourceLayout,
  sourceRoot as mediaRootForScope,
} from "../archive/layout.js";
import { ROOT } from "../archive/fs.js";
import { reserveWorkName } from "../archive/naming.js";
const safe = (value) => String(value).replace(/[^\w-]/g, "_");
export function representationKey(url) {
  const value = new URL(url);
  for (const key of [...value.searchParams.keys()])
    if (
      /^(expires?|signature|sign|token|auth_key|x-expires|x-signature)$/i.test(
        key,
      )
    )
      value.searchParams.delete(key);
  value.searchParams.sort();
  return value.href;
}
export function quality(candidate = {}) {
  return Object.fromEntries(
    ["width", "height", "bitrate", "fps", "size", "codec", "source"].map(
      (key) => [
        key,
        candidate[key] ?? (["codec", "source"].includes(key) ? "" : 0),
      ],
    ),
  );
}
export function rankedCandidates(part) {
  const list =
    part.kind === "image"
      ? [{ url: part.url, width: part.width, height: part.height }]
      : [...(part.candidates || []), part.fallbackCandidate].filter(
          (c) => c?.url,
        );
  if (!list.length && part.url) list.push({ url: part.url });
  const seen = new Set();
  return list
    .sort(
      (a, b) =>
        Number(b.width || 0) * Number(b.height || 0) -
          Number(a.width || 0) * Number(a.height || 0) ||
        Number(b.bitrate || 0) - Number(a.bitrate || 0) ||
        Number(b.fps || 0) - Number(a.fps || 0) ||
        Number(b.size || 0) - Number(a.size || 0),
    )
    .filter((c) => {
      if (!c.url || seen.has(c.url)) return false;
      seen.add(c.url);
      return true;
    });
}
export function isBetterQuality(candidate = {}, current = {}) {
  const area = (q) => Number(q.width || 0) * Number(q.height || 0);
  if (!area(candidate) || !area(current)) return false;
  if (area(candidate) !== area(current)) return area(candidate) > area(current);
  if (candidate.fps > 0 && current.fps > 0 && candidate.fps !== current.fps)
    return candidate.fps > current.fps;
  return (
    candidate.codec &&
    candidate.codec !== "unknown" &&
    candidate.codec === current.codec &&
    candidate.bitrate > 0 &&
    current.bitrate > 0 &&
    candidate.bitrate > current.bitrate
  );
}
function upgradeableFiles(work, files) {
  const records = (work.files || [])
    .map((path) => files[path])
    .filter((file) => file?.complete && file.kind === "video");
  const bestParts = new Set(
    records
      .filter((file) => file.qualityOutcome === "best")
      .map((file) => file.partId),
  );
  return records.filter(
    (file) =>
      !bestParts.has(file.partId) &&
      ["degraded", "fallback"].includes(file.qualityOutcome),
  );
}
export function qualityUpgradeParts(work, raw, files = {}) {
  if (!work?.complete) return [];
  // Saved outcome is the eligibility gate. A previously confirmed best copy
  // remains final even when a later list response advertises a larger variant.
  const eligible = upgradeableFiles(work, files);
  if (!eligible.length) return [];
  const parts =
    raw?.mediaParts ||
    (raw ? normalizeAweme(raw, 0, "liked").mediaParts || [] : []);
  return eligible
    .filter((file) => {
      const part = parts.find(
        (p) => p.partId === file.partId && p.kind === "video",
      );
      const best = part ? rankedCandidates(part)[0] : file.highest;
      return best && isBetterQuality(best, file.quality);
    })
    .map((file) => file.partId);
}
export function createMediaDownloader(
  repo,
  sources,
  { transfer = downloadVerifiedMedia } = {},
) {
  const retry = sources.retry || new RetryCoordinator();
  return async function download(
    item,
    raw,
    signal,
    progress,
  ) {
    const original = repo.state.works[item.id];
    const upgrading = Boolean(item.upgrade && original?.complete);
    if (upgrading && !upgradeableFiles(original, repo.state.files).length)
      return { upgraded: false, unchanged: true };
    const staged = [];
    const retired = [];
    let addressRefreshed = false;
    let firstRequestDeadline = Infinity;
    let normalized = raw ? normalizeAweme(raw, 0, item.scope) : null;
    if (!normalized?.mediaParts?.length) {
      firstRequestDeadline = retry.now() + 2000;
      const controller = new AbortController();
      const stop = () => controller.abort();
      signal?.addEventListener("abort", stop, { once: true });
      const timer = setTimeout(stop, 2000);
      try {
        checkAbort(signal);
        const detail = await sources.detail(item.id, controller.signal);
        normalized = normalizeAweme(detail.aweme, 0, item.scope);
        addressRefreshed = true;
      } catch (error) {
        checkAbort(signal);
        if (controller.signal.aborted)
          throw Object.assign(new Error("读取作品详情超过 2 秒"), {
            retryable: true, retryUntil: retry.info?.until,
          });
        if (httpStatus(error) === 429) error.mediaFailure = true;
        throw error;
      } finally { clearTimeout(timer); signal?.removeEventListener("abort", stop); }
    }
    if (!normalized?.mediaParts?.length) {
      const error = new Error("此作品暂无可下载媒体，可能已失效或无访问权限");
      error.unsupported = true;
      throw error;
    }
    const cover = normalized.coverUrl
      ? {
          partId: "cover",
          kind: "image",
          role: "cover",
          url: normalized.coverUrl,
        }
      : null;
    let work = {
      ...(repo.state.works[item.id] || {}),
      id: item.id,
      complete: upgrading,
      legacy: false,
      desc: normalized.desc || item.desc,
      authorName:
        normalized.authorName || item.authorName || original?.authorName,
      authorUid: normalized.authorUid || item.authorUid || original?.authorUid,
      mediaType: normalized.mediaType,
      sources: [
        ...new Set([...(repo.state.works[item.id]?.sources || []), item.scope]),
      ],
      files: [...(repo.state.works[item.id]?.files || [])],
      diagnostics: { ...(repo.state.works[item.id]?.diagnostics || {}) },
      ...layoutMetadata(
        [...normalized.mediaParts, ...(cover ? [cover] : [])],
        { mediaType: normalized.mediaType },
      ),
    };
    if (work.sources.includes("following"))
      work.authorFolder = authorFolder(work);
    work.naming = reserveWorkName(repo, work);
    for (const type of ["封面", "视频", "图片"])
      await repo.io.mkdir?.(`${mediaRootForScope(item.scope, work)}/${type}`);
    const parts = normalized.mediaParts;
    for (let i = 0; i < parts.length; i++) {
      checkAbort(signal);
      const part = parts[i];
      const previous = work.files
        .map((path) => repo.state.files[path])
        .find((f) => f?.partId === part.partId && f.complete);
      if (previous) {
        try {
          const file = await repo.io.file(previous.path),
            partial = await repo.io.read(previous.path + ".resume.json");
          if (
            file.size === previous.size &&
            !partial &&
            (!upgrading ||
              !qualityUpgradeParts(
                original,
                { mediaParts: parts },
                repo.state.files,
              ).includes(part.partId))
          )
            continue;
        } catch (e) {
          if (e.name !== "NotFoundError") throw e;
        }
      }
      const candidates = rankedCandidates(part).filter(
          (candidate) =>
            !upgrading ||
            (previous && isBetterQuality(candidate, previous.quality)),
        ),
        highest = quality(candidates[0]);
      if (upgrading && !candidates.length) continue;
      let result, last, path, selected, rank;
      let requests = 0;
      const requestLimit = item.idleRetryCount ? 1 : 2;
      const deadline = Math.min(firstRequestDeadline, retry.now() + 2000);
      firstRequestDeadline = Infinity;
      const attempts = [...(work.diagnostics[part.partId]?.attempts || [])];
      const saveDiagnostic = async (error) => {
        work.diagnostics[part.partId] = {
          highest,
          attempts: attempts.slice(-24),
          error: error.message,
          kind: part.kind,
        };
        await repo.commit({
          works: [
            upgrading
              ? {
                  ...original,
                  diagnostics: work.diagnostics,
                  upgradeError: error.message,
                }
              : work,
          ],
          ...(upgrading
            ? {
                files: original.files
                  .map((path) => repo.state.files[path])
                  .filter(
                    (file) =>
                      file?.partId === part.partId &&
                      isBetterQuality(highest, file.quality),
                  )
                  .map((file) => ({
                    ...file,
                    highest,
                    qualityOutcome: "degraded",
                    fallbackReason: "升级未成功，原文件保留：" + error.message,
                  })),
              }
            : {}),
        });
      };
      for (const [index, candidate] of candidates.entries()) {
        if (requests >= requestLimit || retry.now() >= deadline) break;
        checkAbort(signal);
        rank = index + 1;
        const variant = safe(
          [
            candidate.codec || part.kind,
            candidate.width || 0,
            candidate.height || 0,
            candidate.size || 0,
            candidate.bitrate || 0,
          ].join("-"),
        );
        path = upgrading
          ? `${ROOT}/staging/${safe(item.id)}/${variant}-fps${candidate.fps || 0}/${safe(part.partId)}.${part.kind === "image" ? "jpg" : "mp4"}`
          : sourceTargetPath(work, { ...part, url: candidate.url }, item.scope);
        let identity;
        try {
          identity = [
            item.id,
            part.partId,
            variant,
            representationKey(candidate.url),
          ].join("|");
        } catch {
          continue;
        }
        try {
          result = await retry.run(
            async () => {
              try {
                requests++;
                await progress({ retry: null, part: i + 1, parts: parts.length });
                const remaining = Math.max(1, deadline - retry.now());
                return await transfer(repo.target, path, candidate.url, {
                  headerTimeoutMs: remaining, firstByteTimeoutMs: remaining, totalTimeoutMs: 2000,
                  expected: part.kind,
                  signal,
                  resumeIdentity: identity,
                  onProgress: (bytes) =>
                    progress({ ...bytes, part: i + 1, parts: parts.length }),
                });
              } catch (error) {
                attempts.push({
                  at: new Date().toISOString(),
                  rank,
                  status: httpStatus(error),
                  error: error.message,
                });
                throw error;
              }
            },
            {
              signal,
              label: "媒体下载",
              maxRetries: 0,
              deadline,
              rateKey: new URL(candidate.url).origin,
              onRetry: async (info) => {
                if (attempts.length)
                  Object.assign(attempts[attempts.length - 1], {
                    retryUntil: info.until,
                    retryAttempt: info.attempt,
                  });
                await progress({
                  retry: info,
                  part: i + 1,
                  parts: parts.length,
                });
              },
            },
          );
          selected = quality(candidate);
          break;
        } catch (error) {
          if (signal?.aborted) throw error;
          if (repo.poisoned) throw error;
          if (
            [
              "QuotaExceededError",
              "NotAllowedError",
              "NotReadableError",
              "SecurityError",
              "NoModificationAllowedError",
            ].includes(error.name)
          )
            throw error;
          last = error;
          // An expired/denied address or a cooled origin should release the
          // slot. A missing representation may have a usable next candidate.
          if (![404, 410].includes(httpStatus(error)) || error.retryExhausted) {
            error.mediaFailure = true;
            await saveDiagnostic(error);
            throw error;
          }
        }
      }
      if (!result) {
        last ||= new Error("本项已达到 2 秒处理预算");
        last.mediaFailure = true;
        await saveDiagnostic(last);
        throw last;
      }

      checkAbort(signal);
      const area = (q) => Number(q?.width || 0) * Number(q?.height || 0);
      const outcome =
        part.kind === "image"
          ? "image"
          : !area(highest) || !area(selected)
            ? "unknown"
            : area(selected) < area(highest)
              ? "degraded"
              : rank > 1
                ? "fallback"
                : "best";
      const record = {
        path,
        workId: item.id,
        partId: part.partId,
        kind: part.kind,
        order: part.order,
        role: part.role,
        complete: true,
        size: result.size,
        contentType: result.contentType,
        quality: selected,
        highest,
        candidateRank: rank,
        candidateCount: candidates.length,
        qualityOutcome: outcome,
        fallbackReason:
          rank > 1
            ? attempts.map((a) => `候选 ${a.rank}: ${a.error}`).join("；")
            : "",
        attempts: attempts.slice(-24),
        refreshedAddress: addressRefreshed,
        updatedAt: new Date().toISOString(),
      };
      work = {
        ...work,
        files: [
          ...new Set([
            ...work.files.filter(
              (p) => repo.state.files[p]?.partId !== part.partId,
            ),
            path,
          ]),
        ],
        diagnostics: {
          ...work.diagnostics,
          [part.partId]: {
            highest,
            actual: selected,
            outcome,
            attempts: attempts.slice(-24),
            error: "",
          },
        },
      };
      if (upgrading) {
        staged.push(record);
        for (const oldPath of original.files || []) {
          const old = repo.state.files[oldPath];
          if (
            old?.partId === part.partId &&
            old.path !== record.path &&
            old.workId === item.id &&
            !Object.values(repo.state.works).some(
              (other) =>
                other.id !== item.id && other.files?.includes(old.path),
            )
          )
            retired.push({
              ...old,
              pendingDelete: true,
              supersededBy: record.path,
            });
        }
      } else await repo.commit({ files: [record], works: [work] });
    }
    checkAbort(signal);
    await repo.commit({
      ...(upgrading ? { files: [...staged, ...retired] } : {}),
      works: [
        {
          ...work,
          complete: true,
          lastTask: item.taskId,
          completedAt: new Date().toISOString(),
          ...(upgrading
            ? {
                qualityUpgradedAt: staged.length
                  ? new Date().toISOString()
                  : original.qualityUpgradedAt,
                upgradeError: "",
              }
            : {}),
        },
      ],
    });
    for (const scope of repo.state.works[item.id]?.sources || [])
      await ensureSourceLayout(repo, item.id, scope, { signal });
    // The new reference is durable before old media is removed. Failed cleanup
    // remains pending for idle organize; failed upgrades never touch old media.
    if (upgrading && typeof repo.io.remove === "function") {
      for (const previous of retired) {
        if (
          repo.state.files[previous.path]?.complete &&
          !repo.state.files[previous.path].pendingDelete
        )
          continue;
        try {
          await repo.io.remove(previous.path);
        } catch (error) {
          if (repo.poisoned) throw error;
          if (error.name !== "NotFoundError") continue;
        }
        await repo.commit({ files: [{ path: previous.path, removed: true }] });
      }
    }
    if (
      cover &&
      !repo.state.works[item.id].files.some(
        (path) =>
          repo.state.files[path]?.partId === "cover" &&
          repo.state.files[path]?.complete,
      )
    ) {
      const coverPath = sourceTargetPath(
        repo.state.works[item.id],
        cover,
        item.scope,
      );
      try {
        const coverDeadline = retry.now() + 2000;
        const matching = parts.find(
          (part) => part.kind === "image" && part.url === cover.url,
        );
        const local =
          matching &&
          repo.state.works[item.id].files
            .map((path) => repo.state.files[path])
            .find((file) => file?.complete && file.partId === matching.partId);
        let result;
        if (local && repo.io.copy) {
          await repo.io.copy(local.path, coverPath, { signal });
          result = {
            size: (await repo.io.file(coverPath)).size,
            contentType: local.contentType,
          };
        } else
          result = await retry.run(
            () =>
              transfer(repo.target, coverPath, cover.url, {
                expected: "image",
                headerTimeoutMs: Math.max(1, coverDeadline - retry.now()), firstByteTimeoutMs: Math.max(1, coverDeadline - retry.now()), totalTimeoutMs: 2000,
                signal,
                resumeIdentity: `${item.id}|cover|${representationKey(cover.url)}`,
              }),
            { signal, label: "封面下载", maxRetries: 1, deadline: coverDeadline, rateKey: new URL(cover.url).origin },
          );
        const current = repo.state.works[item.id];
        await repo.commit({
          files: [
            {
              path: coverPath,
              workId: item.id,
              partId: "cover",
              role: "cover",
              kind: "image",
              complete: true,
              size: result.size,
              contentType: result.contentType,
              qualityOutcome: "image",
              updatedAt: new Date().toISOString(),
            },
          ],
          works: [
            { ...current, files: [...new Set([...current.files, coverPath])] },
          ],
        });
      } catch (error) {
        if (
          signal?.aborted ||
          repo.poisoned ||
          [
            "QuotaExceededError",
            "NotAllowedError",
            "NotReadableError",
            "SecurityError",
            "NoModificationAllowedError",
          ].includes(error.name)
        )
          throw error;
        const current = repo.state.works[item.id];
        await repo.commit({
          works: [
            {
              ...current,
              diagnostics: {
                ...current.diagnostics,
                cover: {
                  kind: "image",
                  error: "封面暂未保存：" + error.message,
                },
              },
            },
          ],
        });
      }
    }
    for (const scope of repo.state.works[item.id]?.sources || [])
      await ensureSourceLayout(repo, item.id, scope, { signal });
    return {
      upgraded: upgrading && staged.length > 0,
      unchanged: upgrading && !staged.length,
    };
  };
}
