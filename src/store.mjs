import { id, now, readJson, writeJsonAtomic, sha256 } from "./util.mjs";

/**
 * Single-file JSON store. Writes are serialized and atomic (write + rename),
 * so a crash never leaves a half-written case file. The store keeps the last
 * N events in memory for the SSE stream and the browser UI.
 */
export class Store {
  constructor(path) {
    this.path = path;
    this.state = {
      version: 1,
      createdAt: now(),
      cases: [],
      entries: [],
      jobs: [],
      workers: [],
    };
    this.listeners = new Set();
    this.pending = Promise.resolve();
    this.sequence = 0;
  }

  async load() {
    const saved = await readJson(this.path, null);
    if (saved && saved.version === 1) this.state = saved;
    return this;
  }

  async flush() {
    this.pending = this.pending.then(() => writeJsonAtomic(this.path, this.state));
    return this.pending;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    this.sequence += 1;
    const payload = { seq: this.sequence, at: now(), ...event };
    for (const listener of this.listeners) {
      try {
        listener(payload);
      } catch {
        // A dead SSE client must not break the writer.
      }
    }
  }

  createCase({ title, tags = [], capability = null }) {
    const record = {
      id: id("case"),
      title: String(title || "Untitled case").slice(0, 200),
      tags: tags.map((tag) => String(tag).slice(0, 40)).slice(0, 20),
      capability: capability ? String(capability) : null,
      createdAt: now(),
      updatedAt: now(),
    };
    this.state.cases.unshift(record);
    this.emit({ type: "case.created", case: record });
    void this.flush();
    return record;
  }

  getCase(caseId) {
    return this.state.cases.find((item) => item.id === caseId) || null;
  }

  addEntry({ caseId, kind = "note", text = "", data = null, source = "user" }) {
    const record = {
      id: id("entry"),
      caseId,
      kind,
      text: String(text).slice(0, 20000),
      data,
      source,
      createdAt: now(),
    };
    this.state.entries.unshift(record);
    const parent = this.getCase(caseId);
    if (parent) parent.updatedAt = record.createdAt;
    this.emit({ type: "entry.created", entry: record });
    void this.flush();
    return record;
  }

  entriesFor(caseId) {
    return this.state.entries.filter((entry) => entry.caseId === caseId);
  }

  addJob({ caseId, capability, input = {}, title = "" }) {
    const record = {
      id: id("job"),
      caseId,
      capability,
      title: String(title).slice(0, 200),
      input,
      status: "queued",
      workerId: null,
      createdAt: now(),
      updatedAt: now(),
      result: null,
      error: null,
    };
    this.state.jobs.unshift(record);
    this.emit({ type: "job.created", job: record });
    void this.flush();
    return record;
  }

  getJob(jobId) {
    return this.state.jobs.find((item) => item.id === jobId) || null;
  }

  updateJob(jobId, patch) {
    const job = this.getJob(jobId);
    if (!job) return null;
    Object.assign(job, patch, { updatedAt: now() });
    this.emit({ type: "job.updated", job });
    void this.flush();
    return job;
  }

  queuedJob(capability, workerCaps) {
    const supported = new Set(workerCaps);
    return (
      this.state.jobs
        .filter((job) => job.status === "queued")
        .filter((job) => job.capability === "*" || supported.has(job.capability))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] || null
    );
  }

  registerWorker({ workerId, name, capabilities = [], platform, version }) {
    let worker = this.state.workers.find((item) => item.id === workerId);
    if (!worker) {
      worker = { id: workerId, firstSeen: now() };
      this.state.workers.push(worker);
    }
    Object.assign(worker, {
      name: String(name || workerId).slice(0, 80),
      capabilities: capabilities.map((item) => String(item).slice(0, 80)).slice(0, 50),
      platform: String(platform || "unknown").slice(0, 120),
      version: String(version || "0").slice(0, 40),
      lastSeen: now(),
    });
    this.emit({ type: "worker.seen", worker });
    void this.flush();
    return worker;
  }

  liveWorkers(maxAgeMs) {
    const cutoff = Date.now() - maxAgeMs;
    return this.state.workers.filter((worker) => Date.parse(worker.lastSeen) >= cutoff);
  }

  stats() {
    const byStatus = {};
    for (const job of this.state.jobs) byStatus[job.status] = (byStatus[job.status] || 0) + 1;
    return {
      cases: this.state.cases.length,
      entries: this.state.entries.length,
      jobs: this.state.jobs.length,
      byStatus,
      digest: sha256(JSON.stringify(this.state)).slice(0, 16),
    };
  }
}
