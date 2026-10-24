// Server-side copy of the page's "new project from template" step, for projects
// created by integrations. Due dates count back from the project due date.
const crypto = require("crypto");

const newId = () => Date.now().toString(36) + crypto.randomBytes(4).toString("hex");

function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

// Members hold a list of roles; records saved before that only have `role`.
function rolesOf(m) {
  return Array.isArray(m.roles) && m.roles.length ? m.roles : m.role ? [m.role] : [];
}

function createTasksFromTemplate(store, projectId, templateId, due) {
  const project = store.get("projects", projectId);
  const tpl = store.get("templates", templateId);
  if (!project || !tpl) return [];
  const members = Object.entries(store.all().members);
  const keyToId = {};
  (tpl.steps || []).forEach((s) => (keyToId[s.key] = newId()));
  return (tpl.steps || []).map((s, i) => {
    const inRole = members.filter(([, m]) => rolesOf(m).includes(s.role) && (m.boards || ["pre", "post"]).includes(project.board));
    const off = Number(s.offsetDays);
    store.set("tasks", keyToId[s.key], {
      projectId, board: project.board, title: s.title, role: s.role, stage: s.stage, order: i,
      due: due && Number.isFinite(off) ? addDays(due, -off) : null,
      status: "todo", assigneeId: inRole.length === 1 ? inRole[0][0] : null,
      dependsOn: (s.dependsOn || []).map((k) => keyToId[k]).filter(Boolean),
    });
    return keyToId[s.key];
  });
}

module.exports = { createTasksFromTemplate, addDays, rolesOf };
