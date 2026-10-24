// GS Kanban server: serves the board page, a small JSON API over the document
// store, and a live change stream (Server-Sent Events) so every open board updates.
const path = require("path");
const fs = require("fs");
const express = require("express");
const { openStore, COLLECTIONS } = require("./store");
const dtools = require("./dtools");

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;

function createApp(store) {
  const app = express();
  app.use(express.json({ limit: "256kb" }));

  // Optional shared login until single sign-on is set up.
  const user = process.env.BASIC_AUTH_USER, pass = process.env.BASIC_AUTH_PASS;
  if (user && pass) {
    app.use((req, res, next) => {
      const [scheme, encoded] = (req.headers.authorization || "").split(" ");
      const [u, p] = Buffer.from(encoded || "", "base64").toString().split(":");
      if (scheme === "Basic" && u === user && p === pass) return next();
      res.set("WWW-Authenticate", 'Basic realm="GS Kanban"').status(401).send("Sign in required");
    });
  }

  const checkPath = (req, res, next) => {
    if (!COLLECTIONS.includes(req.params.col) || !ID_RE.test(req.params.id)) return res.status(400).json({ error: "bad path" });
    next();
  };
  const checkBody = (req, res, next) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) return res.status(400).json({ error: "body must be a JSON object" });
    next();
  };

  app.get("/api/health", (req, res) => res.json({ ok: true, dtools: dtools.enabled() }));
  app.get("/api/all", (req, res) => res.json(store.all()));
  app.put("/api/:col/:id", checkPath, checkBody, (req, res) => res.json(store.set(req.params.col, req.params.id, req.body)));
  app.patch("/api/:col/:id", checkPath, checkBody, (req, res) => {
    const out = store.update(req.params.col, req.params.id, req.body);
    out ? res.json(out) : res.status(404).json({ error: "not found" });
  });
  app.delete("/api/:col/:id", checkPath, (req, res) => { store.delete(req.params.col, req.params.id); res.status(204).end(); });

  app.get("/api/stream", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders();
    const off = store.subscribe((ev) => res.write("data: " + JSON.stringify(ev) + "\n\n"));
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => { off(); clearInterval(ping); });
  });

  app.use(express.static(path.join(__dirname, "..", "public")));
  return app;
}

// First start only: load the starter pathway templates so New project has something to use.
function seedTemplates(store) {
  if (Object.keys(store.all().templates).length) return;
  const file = path.join(__dirname, "..", "seed", "templates.json");
  const tpls = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const [id, t] of Object.entries(tpls)) store.set("templates", id, t);
  console.log("Loaded " + Object.keys(tpls).length + " starter templates");
}

// Members used to have one `role`; copy it into the `roles` list the page now edits.
function migrateMemberRoles(store) {
  let n = 0;
  for (const [id, m] of Object.entries(store.all().members)) {
    if (Array.isArray(m.roles)) continue;
    store.update("members", id, { roles: m.role ? [m.role] : [] });
    n++;
  }
  if (n) console.log("Moved " + n + " member role" + (n === 1 ? "" : "s") + " into role lists");
}

if (require.main === module) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const store = openStore(path.join(DATA_DIR, "kanban.db"));
  seedTemplates(store);
  migrateMemberRoles(store);
  createApp(store).listen(PORT, () => console.log("GS Kanban listening on :" + PORT));
  dtools.start(store);
}

module.exports = { createApp, seedTemplates, migrateMemberRoles };
