// D-Tools Cloud sync: D-Tools projects become Post sales projects and open
// opportunities become Pre sales projects.
//
// Credentials come only from environment variables; never commit them.
// DTOOLS_API_KEY is your company's key. DTOOLS_BASIC_AUTH is the fixed
// Authorization value published in D-Tools Cloud's API docs (the same for every
// customer); requests without it are refused with 401.
const crypto = require("crypto");
const { createTasksFromTemplate } = require("./templates");

const BASE = process.env.DTOOLS_API_BASE || "https://dtcloudapi.d-tools.cloud/api/v1";
const INTERVAL_MS = Number(process.env.DTOOLS_SYNC_MINUTES || 15) * 60 * 1000;
const PAGE_SIZE = 100;

// D-Tools stage name -> board column. Stages not listed keep the first column.
const POST_STAGE_COLUMNS = {
  "Accepted": "Kickoff",
  "Deposit holding": "Kickoff",
  "Engineering/ Drafting": "Design & Drafting",
  "Partially Ordered": "Procurement & Build",
  "100% Materials Ordered": "Procurement & Build",
  "Materials Received": "Procurement & Build",
  "Scheduled": "Ship & Install",
  "In Progress": "Ship & Install",
  "Pending Change Orders": "Ship & Install",
  "Pending Schedule of Readiness": "Ship & Install",
  "Completed/ Not Invoiced": "Billing & Closeout",
};
const PRE_STAGE_COLUMNS = {
  "New": "Lead",
  "Engineering": "Engineering review",
  "Proposal Shared": "Quote",
};

function enabled() {
  return Boolean(process.env.DTOOLS_API_KEY && process.env.DTOOLS_BASIC_AUTH);
}

async function getAll(path, listKey) {
  const out = [];
  for (let page = 1; page < 1000; page++) {
    const url = BASE + path + "?page=" + page + "&pageSize=" + PAGE_SIZE + "&includeArchived=false";
    const res = await fetch(url, {
      headers: { "X-API-Key": process.env.DTOOLS_API_KEY, Authorization: process.env.DTOOLS_BASIC_AUTH, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(path + " returned " + res.status);
    const items = (await res.json())[listKey] || [];
    out.push(...items);
    if (items.length < PAGE_SIZE) break;
  }
  return out;
}

// Normalize D-Tools projects and opportunities to
// { id, board, column, number, name, client, stage }.
function normalize(projects, opportunities) {
  const recs = [];
  for (const p of projects) {
    if (p.isArchived || p.systemState === "Completed") continue;
    recs.push({ id: p.id, board: "post", column: POST_STAGE_COLUMNS[p.stage] || null, number: p.number, name: p.name, client: p.clientName, stage: p.stage || "" });
  }
  for (const o of opportunities) {
    if (o.isArchived || o.systemState !== "Open") continue;
    recs.push({ id: o.id, board: "pre", column: PRE_STAGE_COLUMNS[o.stage] || null, number: o.number, name: o.name, client: o.clientName, stage: o.stage || "", due: (o.estimatedCloseDate || "").slice(0, 10) || null });
  }
  return recs;
}

const newId = () => Date.now().toString(36) + crypto.randomBytes(4).toString("hex");

// Upsert board projects from normalized records, matched by dtoolsId. A project
// already on the board only has its D-Tools fields refreshed, so its column,
// tasks and board edits are kept. A new project starts in its mapped column;
// one that lands in the board's first column (just starting) also gets that
// board's template tasks, while projects already under way don't.
function importProjects(store, records, { columnsFor, templateFor, createTasks }) {
  const existing = Object.entries(store.all().projects);
  const created = [];
  for (const r of records) {
    if (!r || !r.id) continue;
    const hit = existing.find(([, p]) => p.dtoolsId === String(r.id));
    const fields = { name: r.name || "Untitled", number: r.number || "", client: r.client || "", dtoolsStage: r.stage || "" };
    if (hit) {
      store.update("projects", hit[0], fields);
      continue;
    }
    const cols = columnsFor(r.board);
    const column = cols.includes(r.column) ? r.column : cols[0];
    const templateId = templateFor(r.board);
    const id = newId();
    store.set("projects", id, Object.assign(fields, {
      board: r.board, due: r.due || null, column, templateId,
      archived: false, createdAt: new Date().toISOString(), dtoolsId: String(r.id), source: "dtools",
    }));
    if (templateId && column === cols[0] && createTasks) createTasks(id, templateId, r.due || null);
    created.push(id);
  }
  return created;
}

const DEFAULT_COLUMNS = {
  pre: ["Lead", "Qualify", "Engineering review", "Quote", "Negotiation", "Won / Lost"],
  post: ["Kickoff", "Design & Drafting", "Programming", "Procurement & Build", "Ship & Install", "Billing & Closeout", "Complete"],
};

async function syncOnce(store) {
  const [projects, opportunities] = await Promise.all([
    getAll("/Projects/GetProjects", "projects"),
    getAll("/Opportunities/GetOpportunities", "opportunities"),
  ]);
  const cfg = store.get("config", "boards") || {};
  const templates = Object.entries(store.all().templates);
  return importProjects(store, normalize(projects, opportunities), {
    columnsFor: (b) => (Array.isArray(cfg[b]) && cfg[b].length ? cfg[b] : DEFAULT_COLUMNS[b]),
    templateFor: (b) => { const t = templates.find(([, x]) => x.board === b); return t ? t[0] : null; },
    createTasks: (pid, tid, due) => createTasksFromTemplate(store, pid, tid, due),
  });
}

function start(store) {
  if (!enabled()) return;
  const run = () => syncOnce(store)
    .then((created) => { if (created.length) console.log("D-Tools sync: added " + created.length + " project(s)"); })
    .catch((e) => console.error("D-Tools sync failed:", e.message));
  run();
  setInterval(run, INTERVAL_MS);
}

module.exports = { enabled, start, importProjects, normalize, syncOnce };
