import {
  ROOT,
  filesystem,
  inspectFolder,
  seal,
  unseal,
  now,
  uuid,
} from "./fs.js";
import { summary } from "../core/model.js";
const BASE = `${ROOT}/v2`;
const clone = (value) => structuredClone(value);
export class Repository {
  constructor(io) {
    this.io = io;
    this.state = null;
    this.head = null;
    this.chain = Promise.resolve();
    this.poisoned = false;
  }
  static async open(target) {
    const repo = new Repository(filesystem(target));
    repo.target = target;
    await repo.load();
    return repo;
  }
  async load() {
    if (
      !this.io.maintenanceMode &&
      (await this.io.read(`${ROOT}/maintenance.json`))
    )
      throw new Error("备份库正在本地整理，请完成后再打开");
    this._stats = null;
    const heads = [];
    let existed = false;
    for (const slot of ["a", "b"]) {
      try {
        const raw = await this.io.json(`${BASE}/heads/${slot}.json`);
        if (raw) {
          existed = true;
          heads.push(await unseal(raw));
        }
      } catch (error) {
        if (error.name === "NotAllowedError") throw error;
        existed = true;
      }
    }
    for (const head of heads.sort((a, b) => b.revision - a.revision)) {
      try {
        const snapshot = await unseal(await this.io.json(head.snapshot));
        const events = [];
        let path = head.tail,
          seq = head.seq;
        while (seq > snapshot.seq) {
          const event = await unseal(await this.io.json(path));
          if (event.seq !== seq) throw new Error("记录序号不一致");
          events.push(event);
          path = event.parent;
          seq--;
        }
        if (seq !== snapshot.seq) throw new Error("记录快照不一致");
        this.state = snapshot.state;
        for (const event of events.reverse()) this.apply(event.patch);
        this.head = head;
        this.poisoned = false;
        return;
      } catch (error) {
        if (error.name === "NotAllowedError") throw error;
      }
    }
    if (existed) throw new Error("备份记录损坏，已保留原文件，请先核对备份库");
    const info = await inspectFolder(this.target.handle);
    const owners = [
      info.archive?.owner,
      info.index?.user,
      info.old?.user,
    ].filter((o) => o?.uid);
    if (new Set(owners.map((o) => String(o.uid))).size > 1)
      throw new Error("历史记录的账号归属不一致，请先核对备份库");
    const owner = owners[0] || null;
    this.state = {
      schemaVersion: 2,
      id: info.archive?.id || uuid(),
      owner,
      works: {},
      files: {},
      tasks: {},
      aliases: {},
      updatedAt: null,
      verifiedAt: null,
      legacyOwnerUnknown: false,
    };
    if (info.index)
      for (const [scope, record] of Object.entries(info.index.scopes || {}))
        for (const id of record.completed || []) {
          const work = this.state.works[id] || {
            id: String(id),
            complete: true,
            legacy: true,
            sources: [],
            files: [],
          };
          if (!work.sources.includes(scope)) work.sources.push(scope);
          this.state.works[id] = work;
        }
    if (info.old?.items)
      for (const item of info.old.items)
        if (item.downloadStatus === "downloaded") {
          if (!item.awemeId) continue;
          const id = String(item.awemeId);
          const scope =
            item.source === "favorite_api" ? "liked" : item.source || "liked";
          const work = this.state.works[id] || {
            id,
            complete: true,
            legacy: true,
            sources: [],
            files: [],
          };
          if (!work.sources.includes(scope)) work.sources.push(scope);
          this.state.works[id] = work;
        }
    this.state.legacyOwnerUnknown =
      Object.keys(this.state.works).length > 0 && !owner?.uid;
  }
  get stats() {
    if (!this._stats) {
      this._stats = summary(this.state);
      this._unknownCount = Object.values(this.state.works).filter(
        (w) => w.complete && w.legacy && !w.files?.length,
      ).length;
    }
    return this._stats;
  }
  adjustWorkStats(work, direction) {
    if (!this._stats || !work?.complete) return;
    this._stats.unique += direction;
    if (work.legacy && !work.files?.length) this._unknownCount += direction;
    for (const scope of new Set(work.sources || []))
      if (scope in this._stats.sources) this._stats.sources[scope] += direction;
    this._stats.sizeKnown = this._unknownCount === 0;
    this._stats.unknownWorks = this._unknownCount;
  }
  apply(patch) {
    if (patch.namingVersion) this.state.namingVersion = patch.namingVersion;
    for (const work of patch.works || []) {
      this.adjustWorkStats(this.state.works[work.id], -1);
      this.state.works[work.id] = work;
      this.adjustWorkStats(work, 1);
    }
    for (const file of patch.files || []) {
      if (this._stats) {
        const old = this.state.files[file.path];
        if (old?.complete) this._stats.bytes -= old.size;
        if (!file.removed && file.complete) this._stats.bytes += file.size;
      }
      if (file.removed) delete this.state.files[file.path];
      else {
        this.state.files[file.path] = file;
        if (file.complete && !file.pendingDelete && this.state.aliases)
          delete this.state.aliases[file.path];
      }
    }
    for (const task of patch.tasks || []) this.state.tasks[task.id] = task;
    if (patch.aliases) {
      this.state.aliases ||= {};
      for (const alias of patch.aliases) {
        const current = this.state.files[alias.from];
        if (current?.complete && !current.pendingDelete)
          delete this.state.aliases[alias.from];
        else this.state.aliases[alias.from] = alias.to;
      }
    }
    if (patch.taskUpdate) {
      const { id, fields = {}, items = [] } = patch.taskUpdate;
      const task = this.state.tasks[id];
      if (!task) throw new Error("任务记录不存在");
      Object.assign(task, fields);
      for (const item of items) task.items[item.id] = item;
    }
    if (patch.owner) {
      this.state.owner = patch.owner;
      this.state.legacyOwnerUnknown = false;
    }
    if (patch.followingSelection)
      this.state.followingSelection = patch.followingSelection;
    if (patch.verifiedAt) this.state.verifiedAt = patch.verifiedAt;
    this.state.updatedAt = patch.at;
  }
  async initialize() {
    if (this.head) return;
    await this.io.write(`${ROOT}/archive.json`, {
      schemaVersion: 2,
      id: this.state.id,
      owner: this.state.owner,
      createdAt: now(),
    });
    const snapshot = `${BASE}/snapshots/${uuid()}.json`;
    await this.io.write(snapshot, await seal({ seq: 0, state: this.state }));
    this.head = { seq: 0, revision: 0, snapshot, tail: null };
    await this.io.write(`${BASE}/heads/a.json`, await seal(this.head));
  }
  commit(patch) {
    const operation = async () => {
      if (this.poisoned)
        throw new Error("记录保存失败，暂停下载后请重新打开备份库");
      await this.initialize();
      const event = {
        seq: this.head.seq + 1,
        txId: uuid(),
        parent: this.head.tail,
        patch: { ...clone(patch), at: now() },
      };
      const path = `${BASE}/journal/${event.seq}-${event.txId}.json`;
      try {
        await this.io.write(path, await seal(event));
        const head = {
          ...this.head,
          seq: event.seq,
          revision: this.head.revision + 1,
          tail: path,
        };
        const headPath = `${BASE}/heads/${head.revision % 2 ? "b" : "a"}.json`;
        await this.io.write(headPath, await seal(head));
        await unseal(await this.io.json(headPath));
        this.head = head;
        this.apply(event.patch);
      } catch (error) {
        this.poisoned = true;
        throw new Error("无法保存备份进度：" + error.message, { cause: error });
      }
    };
    const result = this.chain.then(operation);
    this.chain = result.catch(() => {});
    return result;
  }
  async compact() {
    await this.chain;
    if (this.poisoned || !this.head) return;
    const path = `${BASE}/snapshots/${uuid()}.json`;
    await this.io.write(
      path,
      await seal({ seq: this.head.seq, state: this.state }),
    );
    const head = {
      ...this.head,
      revision: this.head.revision + 1,
      snapshot: path,
      tail: null,
    };
    await this.io.write(
      `${BASE}/heads/${head.revision % 2 ? "b" : "a"}.json`,
      await seal(head),
    );
    this.head = head;
  }
  async bind(profile, explicit = false) {
    const owner = this.state.owner;
    if (owner?.uid && String(owner.uid) !== String(profile.uid))
      throw new Error("此备份库属于其他账号，请切换账号或文件夹");
    if (this.state.legacyOwnerUnknown && !explicit)
      throw new Error("历史库归属未确认，请在库详情中核对并绑定账号");
    if (
      !owner?.uid ||
      owner.uid !== String(profile.uid) ||
      owner.nickname !== profile.nickname
    )
      await this.commit({
        owner: { uid: String(profile.uid), nickname: profile.nickname },
      });
  }
  latestTask(scope) {
    return (
      Object.values(this.state.tasks)
        .filter((t) => t.scope === scope)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null
    );
  }
}
