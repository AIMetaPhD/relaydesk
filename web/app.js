const $ = (selector) => document.querySelector(selector);

const el = {
  pairScreen: $("#pair-screen"),
  pairForm: $("#pair-form"),
  pairToken: $("#pair-token"),
  pairError: $("#pair-error"),
  main: $("#main"),
  statusDot: $("#dot"),
  statusText: $("#status-text"),
  toggleNew: $("#toggle-new"),
  caseForm: $("#case-form"),
  caseTitle: $("#case-title"),
  caseCapability: $("#case-capability"),
  caseTags: $("#case-tags"),
  caseList: $("#case-list"),
  caseEmpty: $("#case-empty"),
  caseTemplate: $("#case-template"),
  jobForm: $("#job-form"),
  jobCase: $("#job-case"),
  jobCapability: $("#job-capability"),
  jobInput: $("#job-input-fields"),
  workerList: $("#worker-list"),
  workerEmpty: $("#worker-empty"),
  logList: $("#log-list"),
  digest: $("#digest"),
  serverAddr: $("#server-addr"),
};

const state = {
  cases: [],
  entries: [],
  jobs: [],
  workers: [],
  logs: [],
  capabilities: [],
  open: new Set(),
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    ...options,
  });
  if (response.status === 401) {
    showPair();
    throw new Error("unauthorized");
  }
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new Error(value?.error || `HTTP ${response.status}`);
  return value;
}

function showPair() {
  el.pairScreen.classList.remove("hidden");
  el.main.classList.add("hidden");
  setStatus("down", "not paired");
}

function showMain() {
  el.pairScreen.classList.add("hidden");
  el.main.classList.remove("hidden");
}

function setStatus(kind, text) {
  el.statusDot.className = "dot " + kind;
  el.statusText.textContent = text;
}

function relative(iso) {
  const delta = Date.now() - Date.parse(iso);
  if (delta < 60000) return "just now";
  if (delta < 3600000) return `${Math.floor(delta / 60000)}m ago`;
  if (delta < 86400000) return `${Math.floor(delta / 3600000)}h ago`;
  return `${Math.floor(delta / 86400000)}d ago`;
}

function chip(job) {
  const span = document.createElement("span");
  span.className = `chip ${job.status}`;
  span.textContent = job.status;
  return span;
}

function renderCapabilityOptions() {
  const options = state.capabilities
    .map((item) => `<option value="${item.name}">${item.name}</option>`)
    .join("");
  el.caseCapability.innerHTML = `<option value="">none</option>${options}`;
  el.jobCapability.innerHTML = options;
}

function renderJobInputs() {
  const capability = state.capabilities.find((item) => item.name === el.jobCapability.value);
  el.jobInput.innerHTML = "";
  if (!capability) return;
  const schema = capability.input || {};
  for (const [name, spec] of Object.entries(schema.properties || {})) {
    const required = (schema.required || []).includes(name);
    const label = document.createElement("label");
    label.textContent = name + (required ? "" : " (optional)");
    label.htmlFor = `job-input-${name}`;
    const input = document.createElement("input");
    input.id = `job-input-${name}`;
    input.name = name;
    input.placeholder = spec.description || spec.type || "";
    if (spec.type === "number") input.type = "number";
    input.dataset.type = spec.type || "string";
    if (spec.type === "array") input.placeholder = "comma separated";
    el.jobInput.append(label, input);
  }
}

function renderCaseSelect() {
  const options = state.cases
    .map((item) => `<option value="${item.id}">${escapeHtml(item.title)}</option>`)
    .join("");
  el.jobCase.innerHTML = options || `<option value="">(creates a new case)</option>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function renderCases() {
  el.caseList.innerHTML = "";
  el.caseEmpty.classList.toggle("hidden", state.cases.length > 0);
  for (const record of state.cases) {
    const node = el.caseTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.caseId = record.id;
    node.classList.toggle("open", state.open.has(record.id));
    node.querySelector(".case-title").textContent = record.title;

    const meta = node.querySelector(".case-meta");
    const jobsHere = state.jobs.filter((job) => job.caseId === record.id);
    const entriesHere = state.entries.filter((entry) => entry.caseId === record.id);
    meta.append(
      textSpan(relative(record.createdAt)),
      textSpan(`${entriesHere.length} entries`),
    );
    for (const job of jobsHere.slice(0, 4)) meta.append(chip(job));
    if (record.capability) {
      const tag = document.createElement("span");
      tag.className = "chip";
      tag.textContent = record.capability;
      meta.append(tag);
    }

    node.querySelector(".case-head").addEventListener("click", () => {
      if (state.open.has(record.id)) state.open.delete(record.id);
      else state.open.add(record.id);
      node.classList.toggle("open");
    });

    const list = node.querySelector(".entries");
    if (entriesHere.length === 0) {
      const empty = document.createElement("li");
      empty.className = "entry muted";
      empty.textContent = "Nothing in this file yet.";
      list.append(empty);
    }
    for (const entry of entriesHere.slice(0, 60)) {
      const item = document.createElement("li");
      item.className = "entry";
      const time = document.createElement("time");
      time.textContent = `${relative(entry.createdAt)} · ${entry.kind} · ${entry.source}`;
      const body = document.createElement("div");
      body.textContent = entry.text;
      item.append(time, body);
      if (entry.data && Object.keys(entry.data).length) {
        const pre = document.createElement("pre");
        pre.textContent = JSON.stringify(entry.data, null, 2);
        item.append(pre);
      }
      list.append(item);
    }

    node.querySelector(".entry-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const input = event.target.elements.text;
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      void api("/api/notes", {
        method: "POST",
        body: JSON.stringify({ caseId: record.id, text }),
      }).catch((error) => setStatus("down", error.message));
    });

    el.caseList.append(node);
  }
  renderCaseSelect();
}

function textSpan(text) {
  const span = document.createElement("span");
  span.textContent = text;
  return span;
}

function renderWorkers() {
  el.workerList.innerHTML = "";
  const live = state.workers.filter((worker) => Date.now() - Date.parse(worker.lastSeen) < 90000);
  el.workerEmpty.classList.toggle("hidden", live.length > 0);
  for (const worker of live) {
    const item = document.createElement("li");
    const left = document.createElement("div");
    const name = document.createElement("div");
    name.textContent = worker.name;
    const caps = document.createElement("div");
    caps.className = "caps";
    caps.textContent = worker.capabilities.join(" · ");
    left.append(name, caps);
    const right = document.createElement("div");
    right.className = "caps";
    right.textContent = `${worker.platform} · ${relative(worker.lastSeen)}`;
    item.append(left, right);
    el.workerList.append(item);
  }
}

function renderLogs() {
  el.logList.innerHTML = "";
  for (const line of state.logs.slice(0, 40)) {
    const item = document.createElement("li");
    const time = document.createElement("time");
    time.textContent = new Date(line.at).toLocaleTimeString();
    const text = document.createElement("span");
    text.textContent = line.message;
    if (line.level === "error") text.style.color = "var(--red)";
    item.append(time, text);
    el.logList.append(item);
  }
}

function render() {
  renderCases();
  renderWorkers();
  renderLogs();
}

async function loadState() {
  const value = await api("/api/state");
  Object.assign(state, {
    cases: value.cases || [],
    entries: value.entries || [],
    jobs: value.jobs || [],
    workers: value.workers || [],
    logs: value.logs || [],
    capabilities: value.capabilities || [],
  });
  el.digest.textContent = value.stats ? `digest ${value.stats.digest}` : "";
  el.serverAddr.textContent = value.servers?.[0]?.addr || "";
  if (!state.capabilities.length) {
    state.capabilities = [];
  }
  renderCapabilityOptions();
  renderJobInputs();
  render();
  showMain();
  setStatus("live", "connected");
  connectEvents();
}

let stream = null;

function connectEvents() {
  if (stream) stream.close();
  stream = new EventSource("/api/events");
  stream.onopen = () => setStatus("live", "connected");
  stream.onerror = () => setStatus("down", "reconnecting");
  stream.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "log") {
      state.logs.unshift({ at: payload.at, level: payload.level, message: payload.message });
      renderLogs();
      return;
    }
    void refresh();
  };
}

let refreshTimer = null;
async function refresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    try {
      const value = await api("/api/state");
      Object.assign(state, {
        cases: value.cases || [],
        entries: value.entries || [],
        jobs: value.jobs || [],
        workers: value.workers || [],
        logs: value.logs || state.logs,
      });
      el.digest.textContent = value.stats ? `digest ${value.stats.digest}` : "";
      render();
    } catch {
      /* the SSE reconnect path will retry */
    }
  }, 120);
}

el.pairForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  el.pairError.textContent = "";
  try {
    const response = await fetch("/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: el.pairToken.value.trim() }),
    });
    if (!response.ok) {
      el.pairError.textContent = "That token was not accepted. Check the terminal output.";
      return;
    }
    el.pairToken.value = "";
    await loadState();
  } catch (error) {
    el.pairError.textContent = error.message;
  }
});

el.toggleNew.addEventListener("click", () => {
  const hidden = el.caseForm.classList.toggle("hidden");
  el.toggleNew.setAttribute("aria-expanded", String(!hidden));
  if (!hidden) el.caseTitle.focus();
});

el.caseForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = el.caseTitle.value.trim();
  if (!title) return;
  const tags = el.caseTags.value.split(",").map((item) => item.trim()).filter(Boolean);
  try {
    await api("/api/cases", {
      method: "POST",
      body: JSON.stringify({ title, tags, capability: el.caseCapability.value || null }),
    });
    el.caseTitle.value = "";
    el.caseTags.value = "";
    el.caseForm.classList.add("hidden");
    el.toggleNew.setAttribute("aria-expanded", "false");
    await refresh();
  } catch (error) {
    setStatus("down", error.message);
  }
});

el.jobCapability.addEventListener("change", renderJobInputs);

el.jobForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = {};
  for (const field of el.jobInput.querySelectorAll("input")) {
    if (field.value === "") continue;
    if (field.dataset.type === "number") input[field.name] = Number(field.value);
    else if (field.dataset.type === "array") {
      input[field.name] = field.value.split(",").map((item) => item.trim()).filter(Boolean);
    } else input[field.name] = field.value;
  }
  try {
    await api("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        caseId: el.jobCase.value || undefined,
        capability: el.jobCapability.value,
        input,
        title: state.cases.find((item) => item.id === el.jobCase.value)?.title || "",
      }),
    });
    await refresh();
  } catch (error) {
    setStatus("down", error.message);
  }
});

const boot = async () => {
  try {
    await loadState();
  } catch {
    showPair();
  }
};

void boot();
