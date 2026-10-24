const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { openStore, deepMerge } = require("./store");
const { createApp, seedTemplates } = require("./index");
const { importProjects, normalize, syncOnce } = require("./dtools");
const { createTasksFromTemplate, addDays } = require("./templates");

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsk-"));
  return openStore(path.join(dir, "t.db"));
}

test("deepMerge merges objects and replaces arrays", () => {
  assert.deepStrictEqual(deepMerge({ a: { b: 1, c: 2 }, l: [1, 2] }, { a: { c: 3 }, l: [9] }), { a: { b: 1, c: 3 }, l: [9] });
});

test("addDays counts back across months", () => {
  assert.strictEqual(addDays("2026-11-03", -5), "2026-10-29");
});

test("API set, update, delete round trip", async () => {
  const store = tmpStore();
  const server = createApp(store).listen(0);
  const base = "http://127.0.0.1:" + server.address().port + "/api/";
  try {
    let r = await fetch(base + "projects/p1", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "A", board: "pre" }) });
    assert.strictEqual(r.status, 200);
    r = await fetch(base + "projects/p1", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ column: "Quote" }) });
    assert.deepStrictEqual(await r.json(), { name: "A", board: "pre", column: "Quote" });
    r = await fetch(base + "projects/missing", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.strictEqual(r.status, 404);
    r = await fetch(base + "secrets/x", { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.strictEqual(r.status, 400);
    await fetch(base + "projects/p1", { method: "DELETE" });
    assert.deepStrictEqual((await (await fetch(base + "all")).json()).projects, {});
  } finally {
    server.close();
  }
});

const importOpts = (store) => ({
  columnsFor: (b) => (b === "pre" ? ["Lead", "Quote"] : ["Kickoff", "Programming"]),
  templateFor: (b) => (b === "post" ? "tpl-post-standard" : "tpl-pre-standard"),
  createTasks: (pid, tid, due) => createTasksFromTemplate(store, pid, tid, due),
});

test("D-Tools import creates once, then only refreshes fields", () => {
  const store = tmpStore();
  seedTemplates(store);
  const created = importProjects(store, [{ id: "a1", board: "post", column: "Kickoff", number: "P-1", name: "Lobby AV", client: "Acme", due: "2026-12-31" }], importOpts(store));
  assert.strictEqual(created.length, 1);
  const pid = created[0];
  store.update("projects", pid, { column: "Programming" });
  importProjects(store, [{ id: "a1", board: "post", column: "Kickoff", number: "P-1", name: "Lobby AV rev B", client: "Acme", stage: "Scheduled" }], importOpts(store));
  const all = store.all();
  assert.strictEqual(Object.keys(all.projects).length, 1);
  assert.strictEqual(all.projects[pid].name, "Lobby AV rev B");
  assert.strictEqual(all.projects[pid].dtoolsStage, "Scheduled");
  assert.strictEqual(all.projects[pid].column, "Programming");
  const tasks = Object.values(all.tasks).filter((t) => t.projectId === pid);
  assert.strictEqual(tasks.length, 16);
  assert.ok(tasks.find((t) => t.title === "Closeout package and customer sign-off").due === "2026-12-31");
});

test("D-Tools projects already under way get no template tasks", () => {
  const store = tmpStore();
  seedTemplates(store);
  const [pid] = importProjects(store, [{ id: "b2", board: "post", column: "Programming", name: "Rack room" }], importOpts(store));
  assert.strictEqual(store.get("projects", pid).column, "Programming");
  assert.strictEqual(Object.keys(store.all().tasks).length, 0);
});

test("normalize maps stages and drops completed, archived and closed records", () => {
  const recs = normalize(
    [
      { id: "p1", name: "A", number: "P-1", clientName: "C", systemState: "Open", stage: "Materials Received" },
      { id: "p2", name: "B", systemState: "Completed", stage: "Completed/ Not Invoiced" },
      { id: "p3", name: "C", systemState: "Open", stage: "Mystery", isArchived: true },
    ],
    [
      { id: "o1", name: "D", systemState: "Open", stage: "Proposal Shared", estimatedCloseDate: "2026-11-30T00:00:00" },
      { id: "o2", name: "E", systemState: "Won", stage: "Proposal Shared" },
    ],
  );
  assert.deepStrictEqual(recs.map((r) => [r.id, r.board, r.column, r.due || null]), [
    ["p1", "post", "Procurement & Build", null],
    ["o1", "pre", "Quote", "2026-11-30"],
  ]);
});

test("syncOnce pages through D-Tools with both auth headers", async () => {
  const store = tmpStore();
  seedTemplates(store);
  process.env.DTOOLS_API_KEY = "k"; process.env.DTOOLS_BASIC_AUTH = "Basic x";
  const seen = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    seen.push([url, opts.headers["X-API-Key"], opts.headers.Authorization]);
    const page = Number(new URL(url).searchParams.get("page"));
    const body = url.includes("GetProjects")
      ? { projects: page === 1 ? Array.from({ length: 100 }, (_, i) => ({ id: "p" + i, name: "P" + i, systemState: "Open", stage: "Scheduled" })) : [{ id: "last", name: "Last", systemState: "New", stage: "Accepted" }] }
      : { opportunities: [] };
    return { ok: true, json: async () => body };
  };
  try {
    const created = await syncOnce(store);
    assert.strictEqual(created.length, 101);
    assert.ok(seen.every(([, k, a]) => k === "k" && a === "Basic x"));
    assert.strictEqual(seen.filter(([u]) => u.includes("GetProjects")).length, 2);
  } finally {
    global.fetch = realFetch;
    delete process.env.DTOOLS_API_KEY; delete process.env.DTOOLS_BASIC_AUTH;
  }
});
