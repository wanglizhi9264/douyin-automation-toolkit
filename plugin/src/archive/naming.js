const segmenter = globalThis.Intl?.Segmenter
  ? new Intl.Segmenter("zh", { granularity: "grapheme" })
  : null;
const encoder = new TextEncoder();
const caches = new WeakMap();
function graphemes(value) {
  return segmenter
    ? [...segmenter.segment(value)].map((part) => part.segment)
    : Array.from(value);
}
function clean(value) {
  return String(typeof value === "string" ? value : "")
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^\.+/g, "")
    .replace(/[.\s]+$/g, "")
    .trim();
}
function clip(value, chars, bytes) {
  let result = "",
    count = 0;
  for (const part of graphemes(value)) {
    if (count >= chars || encoder.encode(result + part).length > bytes) break;
    result += part;
    count++;
  }
  return result.trim();
}
export function readableTitle(value) {
  const raw = typeof value === "string" ? value.normalize("NFC") : "";
  const withoutLinks = raw
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/@[^\s@#，。！？,!?]+/g, " ");
  const body = withoutLinks.replace(/#[^\s#]+/g, " ");
  let title = body
    .split(/[\r\n。！？!?]/)
    .map(clean)
    .find((line) => /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(line));
  if (!title)
    title = [...withoutLinks.matchAll(/#([^\s#]+)/g)]
      .map((match) => clean(match[1]))
      .filter(Boolean)
      .join(" ");
  return clean(clip(clean(title), 30, 128)) || "未命名作品";
}
export function validNaming(value) {
  return (
    value?.version === 1 &&
    typeof value.title === "string" &&
    value.title.length > 0 &&
    typeof value.author === "string" &&
    value.author.length > 0 &&
    clean(value.title) === value.title &&
    clean(value.author) === value.author &&
    /^[0-9a-f]+$/i.test(value.token || "")
  );
}
function sourceToken(id) {
  const value = String(id ?? "");
  if (!value) throw new Error("作品 ID 为空，无法命名");
  return /^\d+$/.test(value)
    ? value
    : [...encoder.encode(value)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}
export function readableBase(work, scope) {
  const naming = work.naming;
  if (!validNaming(naming))
    return clip(clean(String(work.id)), 64, 192) || "未知作品";
  const suffix = ` [${naming.token}]`;
  const prefix =
    scope === "following" ? naming.title : `${naming.author} - ${naming.title}`;
  return (
    clip(prefix, 80, Math.max(1, 220 - encoder.encode(suffix).length)).replace(
      /[.\s]+$/g,
      "",
    ) + suffix
  );
}
const fold = (value) => value.normalize("NFKC").toLowerCase();
function keys(work, naming) {
  const model = { ...work, naming };
  return [
    fold("common/" + readableBase(model, "liked")),
    fold(
      "following/" +
        String(work.authorUid || naming.author) +
        "/" +
        readableBase(model, "following"),
    ),
  ];
}
function registry(repo) {
  const old = caches.get(repo);
  if (old?.state === repo.state) return old;
  const result = { state: repo.state, names: new Map(), byId: new Map() };
  for (const work of Object.values(repo.state.works || {}))
    if (validNaming(work.naming)) {
      for (const key of keys(work, work.naming)) {
        const owner = result.names.get(key);
        if (owner && owner !== work.id)
          throw new Error("历史文件名存在冲突，需要核对命名记录");
        result.names.set(key, work.id);
      }
      result.byId.set(work.id, work.naming);
    }
  caches.set(repo, result);
  return result;
}
export function reserveWorkName(repo, work) {
  const cache = registry(repo),
    id = String(work.id);
  if (validNaming(work.naming)) return work.naming;
  if (cache.byId.has(id)) return cache.byId.get(id);
  const token = sourceToken(id);
  const base = {
    version: 1,
    title: readableTitle(work.desc),
    author: clean(clip(clean(work.authorName), 14, 56)) || "未知作者",
  };
  for (
    let length = Math.min(8, token.length);
    ;
    length = Math.min(token.length, length + 4)
  ) {
    const naming = { ...base, token: token.slice(-length) };
    const reserved = keys(work, naming);
    if (
      reserved.every(
        (key) => !cache.names.has(key) || cache.names.get(key) === id,
      )
    ) {
      for (const key of reserved) cache.names.set(key, id);
      cache.byId.set(id, naming);
      return naming;
    }
    if (length === token.length) throw new Error("作品命名冲突，已保留原文件");
  }
}
