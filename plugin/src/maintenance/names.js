import { reserveWorkName, validNaming } from "../archive/naming.js";
import { readReportMetadata } from "../archive/report.js";
import { checkAbort } from "../core/model.js";
export async function prepareReadableNames(
  repo,
  { signal, onProgress = () => {} } = {},
) {
  const metadata = await readReportMetadata(repo.io);
  const old = new Map(
    (metadata.record?.items || []).map((item) => [String(item.awemeId), item]),
  );
  let batch = [],
    prepared = 0;
  const flush = async () => {
    if (batch.length) {
      await repo.commit({ works: batch });
      batch = [];
      onProgress({ prepared, message: "正在准备可读文件名" });
    }
  };
  for (const original of Object.values(repo.state.works)) {
    checkAbort(signal);
    if (validNaming(original.naming)) continue;
    const historical = {
      ...(metadata.videos?.[original.id] || {}),
      ...(old.get(original.id) || {}),
    };
    const uid = original.authorUid || historical.authorUid || "";
    const work = {
      ...original,
      desc:
        original.desc || historical.desc || metadata.texts?.[original.id] || "",
      authorUid: uid,
      authorName:
        original.authorName ||
        historical.authorName ||
        metadata.authors?.[uid]?.nickname ||
        "",
    };
    work.naming = reserveWorkName(repo, work);
    batch.push(work);
    prepared++;
    if (batch.length >= 500) await flush();
  }
  await flush();
  if (repo.state.namingVersion !== 1) await repo.commit({ namingVersion: 1 });
  return { prepared, warnings: metadata.warnings };
}
