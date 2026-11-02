// Chunked hashing keeps the worker's memory bounded even for large videos.
self.onmessage = async (event) => {
  const { id, file } = event.data;
  try {
    const hashes = [];
    for (let offset = 0; offset < file.size; offset += 1024 * 1024)
      hashes.push(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            await file.slice(offset, offset + 1024 * 1024).arrayBuffer(),
          ),
        ),
      );
    const joined = new Uint8Array(hashes.length * 32);
    hashes.forEach((hash, index) => joined.set(hash, index * 32));
    const hash = await crypto.subtle.digest("SHA-256", joined);
    self.postMessage({
      id,
      hash: [...new Uint8Array(hash)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    });
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
};
