export function safePath(path) {
  const parts = String(path).split("/");
  if (parts.some((p) => !p || p === "." || p === ".." || /[\\\0]/.test(p)))
    throw new Error("无效的备份文件路径");
  return parts;
}
export function filesystem(target) {
  const handle = target.handle || target;
  const created = new Set();
  async function directory(parts, create = false) {
    let dir = handle;
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
    return dir;
  }
  async function file(path, create = false) {
    const parts = safePath(path),
      name = parts.pop();
    return (await directory(parts, create)).getFileHandle(name, { create });
  }
  return {
    async mkdir(path) {
      if (created.has(path)) return;
      await directory(safePath(path), true);
      created.add(path);
    },
    async read(path) {
      try {
        return await (await (await file(path)).getFile()).text();
      } catch (e) {
        if (e.name === "NotFoundError") return null;
        throw e;
      }
    },
    async json(path) {
      const text = await this.read(path);
      return text === null ? null : JSON.parse(text);
    },
    async write(path, value) {
      const stream = await (await file(path, true)).createWritable();
      try {
        await stream.write(
          typeof value === "string" ? value : JSON.stringify(value),
        );
        await stream.close();
      } catch (error) {
        await stream.abort?.().catch(() => {});
        throw error;
      }
    },
    async file(path) {
      return (await file(path)).getFile();
    },
    async copy(from, to, { signal } = {}) {
      const source = await this.file(from);
      const writable = await (await file(to, true)).createWritable();
      const reader = source.stream().getReader();
      try {
        while (true) {
          signal?.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          await writable.write(value);
        }
        signal?.throwIfAborted();
        await writable.close();
      } catch (error) {
        await writable.abort?.().catch(() => {});
        throw error;
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    },
    async remove(path) {
      const parts = safePath(path),
        name = parts.pop();
      await (await directory(parts)).removeEntry(name);
    },
    async list(path = "") {
      try {
        const dir = path ? await directory(safePath(path)) : handle;
        const entries = [];
        for await (const entry of dir.values()) entries.push(entry);
        return entries;
      } catch (e) {
        if (e.name === "NotFoundError") return [];
        throw e;
      }
    },
  };
}
export const now = () => new Date().toISOString();
export const uuid = () => crypto.randomUUID();
export async function seal(value) {
  const body = JSON.stringify(value);
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body),
  );
  return {
    body,
    sha256: [...new Uint8Array(hash)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
  };
}
export async function unseal(value) {
  if (
    !value?.body ||
    (await seal(JSON.parse(value.body))).sha256 !== value.sha256
  )
    throw new Error("备份记录校验失败，需要核对备份库");
  return JSON.parse(value.body);
}
export const ROOT = "data/.appdata";
export async function inspectFolder(handle) {
  const io = filesystem(handle);
  const archive = await io.json(`${ROOT}/archive.json`);
  if (archive) {
    if (archive.schemaVersion !== 2) throw new Error("备份库格式版本不受支持");
    return { kind: "modern", archive };
  }
  const index = await io.json(`${ROOT}/download-index.json`);
  if (index?.schemaVersion === 1) {
    const old = await io.json(`${ROOT}/download-state.json`);
    return { kind: "legacy", index, old };
  }
  const old = await io.json(`${ROOT}/download-state.json`);
  if (old?.items) return { kind: "legacy-state", old };
  const entries = (await io.list()).filter((e) => e.name !== ".DS_Store");
  if (entries.length)
    throw new Error(
      "此文件夹有文件，但没有可识别的备份记录。请核对历史库或选择一个空文件夹。",
    );
  return { kind: "empty" };
}
