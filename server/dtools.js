// D-Tools Cloud sync: turns won D-Tools projects into Post sales projects.
//
// The API key comes only from the DTOOLS_API_KEY environment variable; never
// commit it. Fetching from D-Tools is not wired up yet: the request and field
// names need to be checked against D-Tools Cloud's API docs with a real key.
const crypto = require("crypto");
const { createTasksFromTemplate } = require("./templates");

const INTERVAL_MS = Number(process.env.DTOOLS_SYNC_MINUTES || 15) * 60 * 1000;

function enabled() {
  return Boolean(process.env.DTOOLS_API_KEY);
}

// Fetch won projects from D-Tools Cloud and normalize them to
// { id, number, name, client, due }. Not implemented yet.
async function fetchWonProjects() {
  return null;
}

const newId = () => Date.now().toString(36) + crypto.randomBytes(4).toString("hex");

// Upsert board projects from normalized D-Tools records. A record already on the
// board (matched by dtoolsId) only has its D-Tools fields refreshed, so column,
// tasks and edits made on the board are kept. New records start in the first
// Post sales column with tasks from the first Post sales template.
function importProjects(store, records, { columns, templateId, createTasks }) {
  const existing = Object.entries(store.all().projects);
  const created = [];
  for (const r of records) {
    if (!r || !r.id) continue;
    const hit = existing.find(([, p]) => p.dtoolsId === String(r.id));
    const fields = { name: r.name || "Untitled", number: r.number || "", client: r.client || "" };
    if (hit) {
      store.update("projects", hit[0], fields);
      continue;
    }
    const id = newId();
    store.set("projects", id, Object.assign(fields, {
      board: "post", due: r.due || null, column: columns[0], templateId: templateId || null,
      archived: false, createdAt: new Date().toISOString(), dtoolsId: String(r.id), source: "dtools",
    }));
    if (templateId && createTasks) createTasks(id, templateId, r.due || null);
    created.push(id);
  }
  return created;
}

function start(store) {
  if (!enabled()) return;
  const run = async () => {
    try {
      const records = await fetchWonProjects();
      if (!records) { console.log("D-Tools sync: fetching is not implemented yet"); return; }
      const cfg = store.get("config", "boards");
      const tpl = Object.entries(store.all().templates).find(([, t]) => t.board === "post");
      const created = importProjects(store, records, {
        columns: (cfg && cfg.post) || ["Kickoff"],
        templateId: tpl ? tpl[0] : null,
        createTasks: (pid, tid, due) => createTasksFromTemplate(store, pid, tid, due),
      });
      if (created.length) console.log("D-Tools sync: added " + created.length + " project(s)");
    } catch (e) {
      console.error("D-Tools sync failed:", e.message);
    }
  };
  run();
  setInterval(run, INTERVAL_MS);
}

module.exports = { enabled, start, importProjects };
