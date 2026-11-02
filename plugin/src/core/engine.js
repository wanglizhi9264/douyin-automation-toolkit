import {
  newTask,
  counters,
  finishStatus,
  checkAbort,
  sleep,
  BUSY,
} from "./model.js";
import { qualityUpgradeParts } from "./media.js";
import { ensureSourceLayout, hasSourceLayout } from "../archive/layout.js";
import { profileTotal } from "./progress.js";
import { httpStatus } from "../shared/http.js";
import { cursorKey, PaginationError } from "./pagination.js";

export class Engine {
  constructor(
    repo,
    sources,
    download,
    { lock = globalThis.navigator?.locks, capacity = 64 } = {},
  ) {
    this.repo = repo;
    this.sources = sources;
    this.download = download;
    this.lock = lock;
    this.capacity = capacity;
    this.listeners = new Set();
    this.active = new Map();
    this.task = null;
    this.queue = [];
    this.busy = false;
    sources.retry?.subscribe(() => this.emit());
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(kind = "state") {
    for (const listener of this.listeners) listener(this, kind);
  }
  async update(fields = {}, items = [], extra = {}) {
    const patch = { taskUpdate: { id: this.task.id, fields, items }, ...extra };
    await this.repo.commit(patch);
    Object.assign(this.task, fields);
    for (const item of items) this.task.items[item.id] = item;
    this.emit();
  }
  start(
    scope,
    authors = [],
    resume = null,
    { retryOnly = false, retryIds = null, continueFollowing = false } = {},
  ) {
    if (this.busy) throw new Error("已有任务正在运行");
    if (!this.lock) throw new Error("浏览器不支持备份库锁，请升级 Chrome");
    this.busy = true;
    this.error = "";
    this.controller = new AbortController();
    this.task = newTask(scope, this.repo.state.owner?.uid || "", authors);
    this.task.status = "starting";
    this.task.retryOnly = retryOnly;
    this.emit();
    this.done = this.lock
      .request(
        "douyin-archive-" + this.repo.state.id,
        { ifAvailable: true },
        async (lock) => {
          if (!lock)
            throw new Error("其他标签页正在使用这个备份库，请先暂停那里的任务");
          if (await this.repo.io.read("data/.appdata/maintenance.json"))
            throw new Error("备份库正在本地整理，请完成后再下载");
          await this.repo.load();
          this.sources.retry?.restore(
            resume && this.repo.state.tasks[resume.id]?.retryState,
          );
          const restoredTask = resume && this.repo.state.tasks[resume.id];
          for (const info of Object.values(restoredTask?.cooldowns || {}))
            this.sources.retry?.restore(info);
          this.sources.onRetry = async (info) => {
            if (info.scope !== "local" && this.task && this.repo.state.tasks[this.task.id])
              await this.update({ retryState: info });
          };
          const profile = await this.sources.profile(this.controller.signal);
          this.profile = profile;
          await this.repo.bind(profile);
          const savedTask = resume && this.repo.state.tasks[resume.id];
          if (
            savedTask &&
            (savedTask.accountUid !== profile.uid || savedTask.scope !== scope)
          )
            throw new Error("任务账号与当前账号不一致");
          this.task = newTask(scope, profile.uid, authors);
          const continuing = Boolean(
            continueFollowing &&
              scope === "following" &&
              savedTask?.batchVersion === 1 &&
              savedTask.status !== "completed",
          );
          if (continuing) {
            if (
              JSON.stringify(authors.map((a) => a.uid).sort()) !==
              JSON.stringify(savedTask.authors.map((a) => a.uid).sort())
            )
              throw new Error("作者选择已改变，请重新开始任务");
            this.task.authors = structuredClone(savedTask.authors);
            this.task.items = structuredClone(savedTask.items);
            for (const item of Object.values(this.task.items)) {
              if (
                !["saved", "existing"].includes(item.state) &&
                !item.upgrade &&
                this.repo.state.works[item.id]?.complete
              ) {
                item.state = "existing";
                item.error = "";
              }
            }
          }
          this.task.batchVersion = scope === "following" ? 1 : null;
          this.task.authorProgress = continuing
            ? structuredClone(savedTask.authorProgress || {})
            : {};
          this.task.retryOnly = retryOnly;
          this.task.previousTaskId =
            savedTask?.id || this.repo.latestTask(scope)?.id || null;
          this.task.baselineSaved = this.repo.stats.sources[scope] || 0;
          this.task.retryState = savedTask?.retryState || null;
          this.task.cooldowns = { ...(savedTask?.cooldowns || {}) };
          await this.repo.commit({ tasks: [this.task] });
          this.queue = [];
          this.raw = new Map();
          this.active.clear();
          const pending =
            retryOnly || continuing
              ? Object.values(savedTask?.items || {})
                  .filter(
                    (item) =>
                      (continuing
                        ? !["saved", "existing"].includes(item.state)
                        : ["failed", "unsupported"].includes(item.state)) &&
                      (!this.repo.state.works[item.id]?.complete ||
                        item.upgrade) &&
                      (!retryIds || retryIds.includes(item.id)),
                  )
                  .sort((a, b) => (a.authorIndex || 0) - (b.authorIndex || 0))
                  .map((item) => ({
                    ...item,
                    taskId: this.task.id,
                    state: "queued",
                    error: "",
                    retryAt: null,
                    retryAttempt: 0,
                  }))
              : [];
          this.queue = pending.map((item) => item.id);
          const run = {
            id: crypto.randomUUID(),
            startedAt: new Date().toISOString(),
            fromLatest: !retryOnly && !continuing,
            continuingFollowing: continuing,
            retryOnly,
            previousCursor: structuredClone(savedTask?.cursor ?? null),
            previousSourceDone: savedTask?.sourceDone ?? null,
            restored: pending.length,
            checked: pending.length,
            existing: 0,
            saved: 0,
            upgraded: 0,
            failed: 0,
            unsupported: 0,
          };
          const reviewed = new Set(pending.map((item) => item.id)),
            attempted = new Set(),
            scheduled = new Set(pending.map((item) => item.id));
          await this.update(
            {
              status: "running",
              cursor: continuing ? structuredClone(savedTask.cursor) : null,
              sourceDone:
                retryOnly || continuing
                  ? Boolean(savedTask?.sourceDone)
                  : false,
              ...(retryOnly
                ? {
                    listTotal:
                      savedTask?.listTotal ??
                      (savedTask?.sourceDone
                        ? (savedTask.run?.checked ??
                          Object.keys(savedTask.items || {}).length)
                        : null),
                    listTotalAt: savedTask?.listTotalAt ?? null,
                  }
                : {}),
              sourceEnd: null,
              run: { ...run },
              sourceErrors: [],
              sourceEmptyPages: 0,
              sourceStageMessage: continuing
                ? "继续上次作者进度"
                : retryOnly
                  ? "正在重试未完成作品"
                  : "正在检查最新作品",
              platformTotal:
                profileTotal(profile, scope) ??
                (retryOnly ? (savedTask?.platformTotal ?? null) : null),
              platformTotalAt: profile.readAt || new Date().toISOString(),
            },
            pending,
          );
          const signal = this.controller.signal;
          this.producerFinished = false;
          const discoveryReserve = Math.min(18, Math.max(0, this.capacity - 2));
          const seenCursors = new Set([cursorKey(this.task.cursor, scope)]);
          this.sources.onPaginationRetry = async ({ message, trace }) =>
            this.update({ sourceStageMessage: message, sourceLastPage: trace });
          const enqueuePage = async (page) => {
            const observed = new Map(
              page.items.map((raw) => [
                String(raw.aweme_id || raw.awemeId || raw.id || ""),
                raw,
              ]),
            );
            const rows = [],
              knownWorks = [];
            for (const [id, raw] of observed) {
              if (!id) continue;
              const work = this.repo.state.works[id];
              const upgradeParts = qualityUpgradeParts(
                work,
                raw,
                this.repo.state.files,
              );
              if (!reviewed.has(id)) {
                reviewed.add(id);
                run.checked++;
                if (
                  work?.complete &&
                  !upgradeParts.length &&
                  !attempted.has(id)
                )
                  run.existing++;
              }
              if (scheduled.has(id)) {
                if (this.queue.includes(id)) this.raw.set(id, raw);
                continue;
              }
              const prior = this.task.items[id];
              if (prior && this.repo.state.works[id]?.complete) continue;
              scheduled.add(id);
              if (
                work?.complete &&
                (!work.sources?.includes(scope) ||
                  (!work.desc && raw.desc) ||
                  (!work.authorName && raw.author?.nickname) ||
                  (!work.authorUid &&
                    (raw.author?.uid || scope === "following")))
              )
                knownWorks.push({
                  ...work,
                  sources: [...new Set([...(work.sources || []), scope])],
                  desc: work.desc || raw.desc || "",
                  authorName: work.authorName || raw.author?.nickname || "",
                  authorUid:
                    work.authorUid ||
                    raw.author?.uid ||
                    this.task.authors[this.task.cursor?.authorIndex || 0]
                      ?.uid ||
                    "",
                });
              rows.push({
                id,
                state:
                  work?.complete &&
                  !upgradeParts.length &&
                  hasSourceLayout(this.repo, work, scope)
                    ? "existing"
                    : "queued",
                upgrade: upgradeParts.length > 0,
                upgradeParts,
                ...(scope === "following"
                  ? {
                      authorIndex: this.task.cursor?.authorIndex || 0,
                      authorUid:
                        this.task.authors[this.task.cursor?.authorIndex || 0]
                          ?.uid,
                    }
                  : {}),
                scope,
                taskId: this.task.id,
                desc: raw.desc || "",
                authorName:
                  raw.author?.nickname ||
                  (scope === "following"
                    ? this.task.authors[this.task.cursor?.authorIndex || 0]
                        ?.nickname
                    : "") ||
                  "",
                error: "",
              });
            }
            const trace = page.trace || [];
            await this.update(
              {
                cursor: page.cursor,
                run: { ...run },
                sourceDone: page.done,
                ...(page.done
                  ? {
                      listTotal: continuing
                        ? new Set([
                            ...Object.keys(this.task.items),
                            ...rows.map((r) => r.id),
                          ]).size
                        : reviewed.size,
                      listTotalAt: new Date().toISOString(),
                    }
                  : {}),
                ...(scope === "bookmarked" && this.profile.bookmarkedDisplay
                  ? { platformDisplayTotal: this.profile.bookmarkedDisplay }
                  : {}),
                sourceEmptyPages: page.emptyPages || 0,
                sourceStageMessage: page.emptyPages
                  ? `已跨过 ${page.emptyPages} 个空页，继续读取后续列表…`
                  : "",
                sourcePageHistory: [
                  ...(this.task.sourcePageHistory || []),
                  ...trace,
                ].slice(-12),
                sourceLastPage:
                  trace.at(-1) || this.task.sourceLastPage || null,
                ...(page.done
                  ? { sourceEnd: page.end || { kind: "server_end" } }
                  : {}),
                ...(profileTotal(this.profile, scope) !== null
                  ? {
                      platformTotal: profileTotal(this.profile, scope),
                      platformTotalAt:
                        this.profile.readAt || new Date().toISOString(),
                    }
                  : {}),
              },
              rows,
              { works: knownWorks },
            );
            const queued = rows.filter((row) => row.state === "queued");
            let offset = 0;
            while (offset < queued.length) {
              checkAbort(signal);
              const room = this.capacity - this.queue.length - this.active.size;
              if (room <= 0) {
                await sleep(60, signal);
                continue;
              }
              const batch = queued.slice(offset, offset + room);
              for (const row of batch)
                this.raw.set(row.id, observed.get(row.id));
              this.queue.push(...batch.map((row) => row.id));
              offset += batch.length;
              this.emit();
            }
          };
          const produce = async () => {
            try {
              if (retryOnly) return;
              if (continuing) {
                while (this.queue.length || this.active.size) {
                  checkAbort(signal);
                  await sleep(60, signal);
                }
                const authorProgress = { ...this.task.authorProgress };
                for (const author of this.task.authors.slice(
                  0,
                  this.task.cursor?.authorIndex || 0,
                )) {
                  const items = Object.values(this.task.items).filter(
                    (item) => item.authorUid === author.uid,
                  );
                  const failed = items.filter((item) =>
                    ["failed", "unsupported"].includes(item.state),
                  ).length;
                  authorProgress[author.uid] = {
                    status: failed ? "partial" : "completed",
                    checked: items.length,
                    failed,
                    at: new Date().toISOString(),
                  };
                }
                await this.update({ authorProgress });
              }
              while (
                this.queue.length + this.active.size >
                this.capacity - discoveryReserve
              ) {
                checkAbort(signal);
                await sleep(80, signal);
              }
              while (!this.task.sourceDone) {
                checkAbort(signal);
                while (
                  this.queue.length + this.active.size >
                  this.capacity - discoveryReserve
                ) {
                  await sleep(80, signal);
                }
                const currentProfile = await this.sources.profile(signal);
                if (currentProfile.uid !== profile.uid) {
                  this.controller.abort();
                  await this.update({
                    sourceErrors: ["账号已切换，任务已暂停，请回到原账号继续"],
                  });
                  return;
                }
                this.profile = currentProfile;
                const authorIndex = this.task.cursor?.authorIndex || 0;
                const page = await this.sources.page(
                  this.task,
                  profile,
                  signal,
                  { seenCursors },
                );
                checkAbort(signal);
                const key = cursorKey(page.cursor, scope);
                if (!page.done && seenCursors.has(key)) {
                  const error = new PaginationError("分页游标出现循环", {
                    items: page.items,
                    cursor: this.task.cursor,
                    trace: [
                      ...(page.trace || []),
                      {
                        at: new Date().toISOString(),
                        decision: "retry",
                        reason: "cursor_cycle",
                        inputCursor: this.task.cursor,
                        outputCursor: page.cursor,
                        itemCount: page.items.length,
                      },
                    ],
                  });
                  throw error;
                }
                seenCursors.add(key);
                await enqueuePage(page);
                if (
                  scope === "following" &&
                  (page.cursor?.authorIndex || 0) > authorIndex
                ) {
                  while (this.queue.length || this.active.size) {
                    checkAbort(signal);
                    await sleep(60, signal);
                  }
                  const author = this.task.authors[authorIndex];
                  const items = Object.values(this.task.items).filter(
                    (item) => item.authorUid === author.uid,
                  );
                  const failed = items.filter((item) =>
                    ["failed", "unsupported"].includes(item.state),
                  ).length;
                  await this.update({
                    authorProgress: {
                      ...this.task.authorProgress,
                      [author.uid]: {
                        status: failed ? "partial" : "completed",
                        checked: items.length,
                        failed,
                        at: new Date().toISOString(),
                      },
                    },
                  });
                }
              }
            } catch (error) {
              if (error.page && !signal.aborted) await enqueuePage(error.page);
              if (httpStatus(error) === 429) {
                this.controller.abort();
                await this.update({
                  sourceErrors: [error.message],
                  retryState: this.sources.retry?.last || null,
                });
              }
              if (!signal.aborted)
                await this.update({ sourceErrors: [error.message] });
            } finally {
              this.producerFinished = true;
            }
          };
          const consume = async () => {
            while (!signal.aborted) {
              if (
                scope === "following" &&
                this.queue.length &&
                this.active.size &&
                [...this.active.values()].some(
                  (active) =>
                    active.authorUid !==
                    this.task.items[this.queue[0]]?.authorUid,
                )
              ) {
                await sleep(60, signal);
                continue;
              }
              const id = this.queue.shift();
              if (!id) {
                if (this.producerFinished) return;
                await sleep(60, signal);
                continue;
              }
              let item = { ...this.task.items[id] };
              this.active.set(id, { ...item, loaded: 0, total: 0 });
              this.emit();
              try {
                const existing = this.repo.state.works[id];
                if (existing?.complete && !item.upgrade) {
                  await ensureSourceLayout(this.repo, id, scope, { signal });
                  const organized = this.repo.state.works[id];
                  await this.repo.commit({
                    works: [
                      {
                        ...organized,
                        sources: [
                          ...new Set([...(existing.sources || []), scope]),
                        ],
                      },
                    ],
                  });
                  item.state =
                    existing.lastTask === this.task.id ? "saved" : "existing";
                } else {
                  attempted.add(id);
                  item.state = "downloading";
                  await this.update({}, [item]);
                  const result = await this.download(
                    item,
                    this.raw.get(id),
                    signal,
                    async (progress) => {
                      this.active.set(id, {
                        ...this.active.get(id),
                        ...item,
                        ...progress,
                      });
                      this.emit("progress");
                      if (progress.retry) {
                        const info = progress.retry;
                        item = { ...item, state: "retry_wait", retryAt: info.until,
                          retryAttempt: info.attempt };
                        const fields = info.rateKey
                          ? { cooldowns: { ...this.task.cooldowns, [info.rateKey]: info } }
                          : info.scope === "local" ? {} : { retryState: info };
                        await this.update(fields, [item]);
                      } else if (progress.retry === null && item.state === "retry_wait") {
                        item = { ...item, state: "downloading", retryAt: null };
                        await this.update({}, [item]);
                      }
                    },
                  );
                  for (const source of this.repo.state.works[id]?.sources || [])
                    await ensureSourceLayout(this.repo, id, source, { signal });
                  item.upgraded = Boolean(result?.upgraded);
                  item.state = result?.unchanged ? "existing" : "saved";
                  if (result?.unchanged) run.existing++;
                  else if (result?.upgraded) run.upgraded++;
                  else run.saved++;
                }
                item.error = "";
                await this.update({ run: { ...run } }, [item]);
              } catch (error) {
                const fatal =
                  this.repo.poisoned ||
                  (httpStatus(error) === 429 && !error.deferToSweep) ||
                  [
                    "QuotaExceededError",
                    "NotAllowedError",
                    "NotReadableError",
                    "SecurityError",
                    "NoModificationAllowedError",
                  ].includes(error.name);
                if (fatal) this.controller.abort();
                item.state = signal.aborted
                  ? "queued"
                  : error.unsupported
                    ? "unsupported"
                    : "failed";
                item.error =
                  signal.aborted && httpStatus(error) !== 429
                    ? ""
                    : item.upgrade && this.repo.state.works[id]?.complete
                      ? "画质升级未成功，原文件保留：" + error.message
                      : error.message;
                item.canRetry = !error.unsupported;
                item.retryAt = error.retryUntil || null;
                if (!signal.aborted) {
                  if (error.unsupported) run.unsupported++;
                  else run.failed++;
                }
                await this.update({ run: { ...run } }, [item]);
                if (fatal) throw error;
              } finally {
                this.raw.delete(id);
                this.active.delete(id);
                this.emit();
              }
            }
          };
          const checkResults = async (jobs) => {
            const results = await Promise.allSettled(jobs);
            const fatal = results.find(
              (r) => r.status === "rejected" && r.reason?.name !== "AbortError",
            );
            if (fatal) {
              if (!this.repo.poisoned)
                await this.update({ status: "paused", sourceErrors: [fatal.reason.message] });
              throw fatal.reason;
            }
          };
          await checkResults([produce(), consume(), consume()]);
          const deferred = Object.values(this.task.items).filter(
            (item) => item.state === "failed" && item.canRetry !== false,
          );
          if (!retryOnly && this.task.sourceDone && !signal.aborted && deferred.length) {
            const current = await this.sources.profile(signal);
            if (current.uid !== profile.uid) throw new Error("账号已切换，任务已暂停");
            await this.update({ recovery: { round: 1, status: "running", total: deferred.length } });
            this.producerFinished = false;
            const recover = async () => {
              const pending = [...deferred];
              try {
                while (pending.length) {
                  checkAbort(signal);
                  if (this.queue.length + this.active.size >= this.capacity) {
                    await sleep(60, signal); continue;
                  }
                  const readyIndex = pending.findIndex((item) => !item.retryAt || item.retryAt <= Date.now());
                  if (readyIndex < 0) {
                    const waitUntil = Math.min(...pending.map((item) => item.retryAt));
                    if (this.task.recovery.status !== "waiting")
                      await this.update({ recovery: { ...this.task.recovery, status: "waiting", waitUntil } });
                    await sleep(Math.min(1000, Math.max(1, waitUntil - Date.now())), signal);
                    continue;
                  }
                  const [previous] = pending.splice(readyIndex, 1);
                  const item = { ...previous, state: "queued", recoveryRound: 1, error: "", retryAt: null };
                  run.failed--;
                  await this.update({ run: { ...run }, recovery: { ...this.task.recovery, status: "running", waitUntil: null } }, [item]);
                  this.queue.push(item.id);
                }
              } catch (error) {
                if (error.name !== "AbortError") { this.controller.abort(); throw error; }
              } finally { this.producerFinished = true; }
            };
            await checkResults([recover(), consume(), consume()]);
            const recovered = deferred.filter((item) => ["saved", "existing"].includes(this.task.items[item.id]?.state)).length;
            await this.update({ recovery: { ...this.task.recovery,
              status: signal.aborted ? "paused" : "completed", recovered,
              remaining: deferred.length - recovered } });
            if (scope === "following") {
              const authorProgress = { ...this.task.authorProgress };
              for (const author of this.task.authors) {
                const items = Object.values(this.task.items).filter((item) => item.authorUid === author.uid);
                const failed = items.filter((item) => ["failed", "unsupported"].includes(item.state)).length;
                const pending = items.some((item) => !["saved", "existing", "failed", "unsupported"].includes(item.state));
                authorProgress[author.uid] = { ...authorProgress[author.uid],
                  status: pending ? "partial" : failed ? "partial" : "completed",
                  checked: items.length, failed, at: new Date().toISOString() };
              }
              await this.update({ authorProgress });
            }
          }
          await this.update({
            status: signal.aborted ? "paused" : finishStatus(this.task),
          });
          await this.repo.compact();
        },
      )
      .catch(async (error) => {
        this.error = error.name === "AbortError" ? "" : error.message;
        this.controller.abort();
        if (this.task) this.task.status = "paused";
      })
      .finally(() => {
        this.sources.onRetry = null;
        this.sources.onPaginationRetry = null;
        this.busy = false;
        this.active.clear();
        this.emit();
      });
    return this.done;
  }
  retryFailures(task, ids = null) {
    const failures = Object.values(task?.items || {}).filter(
      (item) =>
        ["failed", "unsupported"].includes(item.state) &&
        (!this.repo.state.works[item.id]?.complete || item.upgrade) &&
        (!ids || ids.includes(item.id)),
    );
    if (!failures.length) throw new Error("没有需要重试的作品");
    return this.start(task.scope, task.authors, task, {
      retryOnly: true,
      retryIds: failures.map((item) => item.id),
    });
  }
  continueFollowing(task) {
    if (!task || task.scope !== "following" || task.status === "completed")
      throw new Error("没有待继续的关注任务");
    return this.start("following", task.authors, task, {
      continueFollowing: true,
    });
  }
  async pause() {
    if (!this.busy) return;
    this.controller.abort();
    if (this.task) {
      this.task.status = "pausing";
      this.emit();
    }
    await this.done;
  }
  get counts() {
    return counters(this.task);
  }
  get isRunning() {
    return this.busy || BUSY.has(this.task?.status);
  }
}
