export async function chooseDownloadDirectory() {
  if (!("showDirectoryPicker" in window)) {
    throw new Error("当前浏览器不支持目录写入，请使用 Chrome/Edge 新版本");
  }
  return showDirectoryPicker({ mode: "readwrite" });
}

export async function writeFile(rootHandle, relativePath, data) {
  const parts = relativePath.split("/").filter(Boolean);
  const fileName = parts.pop();
  let dir = rootHandle;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  const file = await dir.getFileHandle(fileName, { create: true });
  const writable = await file.createWritable();
  await writable.write(data);
  await writable.close();
}
