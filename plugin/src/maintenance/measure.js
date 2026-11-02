import { checkAbort } from "../core/model.js";
import { ROOT } from "../archive/fs.js";
import { manifestParts } from "./organize.js";
// Idle metadata/stat pass only: never hashes, removes, or reads media contents.
export async function measureSizes(
  repo,
  { signal, onProgress = () => {}, lock = navigator.locks } = {},
) {
  return lock.request(
    "douyin-archive-" + repo.state.id,
    { ifAvailable: true },
    async (acquired) => {
      if (!acquired) return { skipped: true };
      checkAbort(signal);
      await repo.load();
      let checked = 0,
        unresolved = 0;
      const works = Object.values(repo.state.works).filter(
        (w) => w.complete && w.legacy && !w.files?.length,
      );
      for (const work of works) {
        checkAbort(signal);
        const manifest = await repo.io.json(
          `${ROOT}/manifests/${work.id}.json`,
        );
        const parts = manifest ? manifestParts(manifest) : [];
        const records = [];
        let complete = parts.length > 0;
        for (const part of parts) {
          checkAbort(signal);
          try {
            const file = await repo.io.file(part.path);
            if (
              !file.size ||
              (await repo.io.read(part.path + ".resume.json")) ||
              (part.size && part.size !== file.size)
            ) {
              complete = false;
              break;
            }
            records.push({
              ...part,
              path: part.path,
              workId: work.id,
              size: file.size,
              complete: true,
            });
          } catch (e) {
            if (e.name !== "NotFoundError") throw e;
            complete = false;
            break;
          }
        }
        checkAbort(signal);
        if (complete)
          await repo.commit({
            files: records,
            works: [
              { ...work, files: records.map((r) => r.path), legacy: false },
            ],
          });
        else unresolved++;
        onProgress({ checked: ++checked, total: works.length, unresolved });
        if (checked % 20 === 0)
          await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return { checked, unresolved };
    },
  );
}
