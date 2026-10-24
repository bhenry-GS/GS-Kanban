const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { openStore, deepMerge } = require("./store");
const { createApp, seedTemplates } = require("./index");
const { importProjects } = require("./dtools");
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

test("D-Tools import creates once, then only refreshes fields", () => {
  const store = tmpStore();
  seedTemplates(store);
  const opts = { columns: ["Kickoff"], templateId: "tpl-post-standard", createTasks: (pid, tid, due) => createTasksFromTemplate(store, pid, tid, due) };
  const created = importProjects(store, [{ id: 42, number: "P-1", name: "Lobby AV", client: "Acme", due: "2026-12-31" }], opts);
  assert.strictEqual(created.length, 1);
  const pid = created[0];
  store.update("projects", pid, { column: "Programming" });
  importProjects(store, [{ id: 42, number: "P-1", name: "Lobby AV rev B", client: "Acme" }], opts);
  const all = store.all();
  assert.strictEqual(Object.keys(all.projects).length, 1);
  assert.strictEqual(all.projects[pid].name, "Lobby AV rev B");
  assert.strictEqual(all.projects[pid].column, "Programming");
  const tasks = Object.values(all.tasks).filter((t) => t.projectId === pid);
  assert.strictEqual(tasks.length, 16);
  assert.ok(tasks.find((t) => t.title === "Closeout package and customer sign-off").due === "2026-12-31");
});
