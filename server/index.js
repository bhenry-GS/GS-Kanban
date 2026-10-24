// GS Kanban server: serves the board page, a small JSON API over the document
// store, and a live change stream (Server-Sent Events) so every open board updates.
const path = require("path");
const fs = require("fs");
const express = require("express");
const { openStore, COLLECTIONS } = require("./store");
const dtools = require("./dtools");
const { mountAuth } = require("./auth");

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;

function createApp(store) {
  const app = express();
  app.use(express.json({ limit: "256kb" }));

  // Behind a proxy that ends HTTPS (Render, Fly.io...), set TRUST_PROXY=1 so sign-in cookies are marked Secure.
  const tp = process.env.TRUST_PROXY;
  if (tp) app.set("trust proxy", tp === "true" ? true : /^\d+$/.test(tp) ? Number(tp) : tp);

  app.get("/api/health", (req, res) => res.json({ ok: true, auth: true, dtools: dtools.enabled() }));
  const { accounts, requireUser, requireAdmin } = mountAuth(app, store);
  app.use("/api", requireUser);

  const checkPath = (req, res, next) => {
    if (!COLLECTIONS.includes(req.params.col) || !ID_RE.test(req.params.id)) return res.status(400).json({ error: "bad path" });
    next();
  };
  const checkBody = (req, res, next) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) return res.status(400).json({ error: "body must be a JSON object" });
    next();
  };

  // Each login belongs to a person on the team, so only admins change the team.
  const teamGuard = (req, res, next) => (req.params.col === "members" ? requireAdmin(req, res, next) : next());

  app.get("/api/all", (req, res) => res.json(store.all()));
  app.put("/api/:col/:id", checkPath, teamGuard, checkBody, (req, res) => res.json(store.set(req.params.col, req.params.id, req.body)));
  app.patch("/api/:col/:id", checkPath, teamGuard, checkBody, (req, res) => {
    const out = store.update(req.params.col, req.params.id, req.body);
    out ? res.json(out) : res.status(404).json({ error: "not found" });
  });
  app.delete("/api/:col/:id", checkPath, teamGuard, (req, res) => {
    if (req.params.col === "members") {
      const a = accounts.byMember(req.params.id);
      if (a && a.id === req.account.id) return res.status(400).json({ error: "You can't remove yourself." });
      accounts.removeForMember(req.params.id);
    }
    store.delete(req.params.col, req.params.id);
    res.status(204).end();
  });

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

if (require.main === module) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const store = openStore(path.join(DATA_DIR, "kanban.db"));
  seedTemplates(store);
  createApp(store).listen(PORT, () => console.log("GS Kanban listening on :" + PORT));
  dtools.start(store);
}

module.exports = { createApp, seedTemplates };
