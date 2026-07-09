const DB_NAME = "douyin_toolkit";
const DB_VERSION = 1;

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("config")) db.createObjectStore("config", { keyPath: "key" });
      if (!db.objectStoreNames.contains("items")) {
        const store = db.createObjectStore("items", { keyPath: "awemeId" });
        store.createIndex("status", "status");
        store.createIndex("source", "source");
        store.createIndex("index", "index");
        store.createIndex("updatedAt", "updatedAt");
      }
      if (!db.objectStoreNames.contains("logs")) {
        const store = db.createObjectStore("logs", { keyPath: "id", autoIncrement: true });
        store.createIndex("createdAt", "createdAt");
      }
      if (!db.objectStoreNames.contains("runs")) db.createObjectStore("runs", { keyPath: "id", autoIncrement: true });
      if (!db.objectStoreNames.contains("downloadJobs")) db.createObjectStore("downloadJobs", { keyPath: "awemeId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function txDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("transaction aborted"));
  });
}

export async function getAll(storeName) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName).objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

export async function getConfig(key, fallback = null) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction("config").objectStore("config").get(key);
    request.onsuccess = () => resolve(request.result?.value ?? fallback);
    request.onerror = () => reject(request.error);
  });
}

export async function setConfig(key, value) {
  const db = await openDb();
  const tx = db.transaction("config", "readwrite");
  tx.objectStore("config").put({ key, value, updatedAt: new Date().toISOString() });
  await txDone(tx);
}

export async function putItems(items) {
  const db = await openDb();
  const tx = db.transaction("items", "readwrite");
  const store = tx.objectStore("items");
  for (const item of items) store.put(item);
  await txDone(tx);
}

export async function clearItems() {
  const db = await openDb();
  const tx = db.transaction("items", "readwrite");
  tx.objectStore("items").clear();
  await txDone(tx);
}

export async function addLog(text, level = "info", meta = null) {
  const db = await openDb();
  const tx = db.transaction("logs", "readwrite");
  tx.objectStore("logs").add({
    text,
    level,
    meta,
    createdAt: new Date().toISOString(),
  });
  await txDone(tx);
}

export async function recentLogs(limit = 120) {
  const logs = await getAll("logs");
  return logs.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).slice(-limit);
}
