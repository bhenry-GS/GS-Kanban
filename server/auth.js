// Accounts, sign-in sessions and invite links. Each account belongs to one person
// in the members collection; the board's own data stays in the document store.
// Account rows live in their own tables so password hashes never reach /api/all.
const crypto = require("crypto");
const express = require("express");

const COOKIE = "gsk_session";
const SESSION_DAYS = 30;
const INVITE_DAYS = 7;
const MIN_PASSWORD = 8;
const MAX_FAILS = 10;                 // failed sign-ins per address and email...
const FAIL_WINDOW_MS = 15 * 60 * 1000; // ...in this window before sign-in pauses

const now = () => Date.now();
const newToken = () => crypto.randomBytes(32).toString("base64url");
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const newId = () => crypto.randomBytes(9).toString("base64url");
const cleanEmail = (e) => String(e || "").trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return "scrypt$" + salt.toString("hex") + "$" + hash.toString("hex");
}
function checkPassword(pw, stored) {
  const [kind, salt, hash] = String(stored || "").split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "hex");
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, "hex"), want.length);
  return crypto.timingSafeEqual(want, got);
}
const passwordProblem = (pw) =>
  typeof pw !== "string" || pw.length < MIN_PASSWORD ? "Use at least " + MIN_PASSWORD + " characters." : pw.length > 200 ? "That password is too long." : null;

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function openAccounts(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      member_id TEXT NOT NULL UNIQUE,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_login INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invites (
      token_hash TEXT PRIMARY KEY,
      member_id TEXT NOT NULL,
      email TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL
    );
  `);
  const q = {
    count: db.prepare("SELECT COUNT(*) AS n FROM accounts"),
    admins: db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE is_admin = 1"),
    byId: db.prepare("SELECT * FROM accounts WHERE id = ?"),
    byEmail: db.prepare("SELECT * FROM accounts WHERE email = ?"),
    byMember: db.prepare("SELECT * FROM accounts WHERE member_id = ?"),
    list: db.prepare("SELECT * FROM accounts ORDER BY email"),
    insert: db.prepare("INSERT INTO accounts (id, email, password_hash, member_id, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
    setPassword: db.prepare("UPDATE accounts SET password_hash = ? WHERE id = ?"),
    setAdmin: db.prepare("UPDATE accounts SET is_admin = ? WHERE id = ?"),
    setEmail: db.prepare("UPDATE accounts SET email = ? WHERE id = ?"),
    touch: db.prepare("UPDATE accounts SET last_login = ? WHERE id = ?"),
    remove: db.prepare("DELETE FROM accounts WHERE id = ?"),
    sessionAdd: db.prepare("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)"),
    sessionGet: db.prepare("SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?"),
    sessionDel: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
    sessionsDelFor: db.prepare("DELETE FROM sessions WHERE account_id = ?"),
    sessionsDelOthers: db.prepare("DELETE FROM sessions WHERE account_id = ? AND token_hash != ?"),
    sessionsPurge: db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),
    inviteAdd: db.prepare("INSERT INTO invites (token_hash, member_id, email, is_admin, expires_at) VALUES (?, ?, ?, ?, ?)"),
    inviteGet: db.prepare("SELECT * FROM invites WHERE token_hash = ? AND expires_at > ?"),
    inviteDel: db.prepare("DELETE FROM invites WHERE token_hash = ?"),
    invitesDelFor: db.prepare("DELETE FROM invites WHERE member_id = ?"),
    invitesList: db.prepare("SELECT member_id, email, is_admin, expires_at FROM invites WHERE expires_at > ?"),
  };

  const accounts = {
    count: () => q.count.get().n,
    get: (id) => q.byId.get(id),
    byEmail: (email) => q.byEmail.get(cleanEmail(email)),
    byMember: (memberId) => q.byMember.get(memberId),
    list: () => q.list.all(),
    pendingInvites: () => q.invitesList.all(now()),
    create({ email, password, memberId, isAdmin }) {
      const id = newId();
      q.insert.run(id, cleanEmail(email), hashPassword(password), memberId, isAdmin ? 1 : 0, now());
      return q.byId.get(id);
    },
    setPassword(id, pw) { q.setPassword.run(hashPassword(pw), id); },
    setAdmin(id, on) { q.setAdmin.run(on ? 1 : 0, id); },
    setEmail(id, email) { q.setEmail.run(cleanEmail(email), id); },
    adminCount: () => q.admins.get().n,
    remove(id) { q.sessionsDelFor.run(id); q.remove.run(id); },
    removeForMember(memberId) {
      const a = q.byMember.get(memberId);
      if (a) accounts.remove(a.id);
      q.invitesDelFor.run(memberId);
    },

    startSession(accountId) {
      const token = newToken();
      q.sessionsPurge.run(now());
      q.sessionAdd.run(sha256(token), accountId, now() + SESSION_DAYS * 86400000);
      q.touch.run(now(), accountId);
      return token;
    },
    sessionAccount(token) {
      if (!token) return null;
      const s = q.sessionGet.get(sha256(token), now());
      return s ? q.byId.get(s.account_id) || null : null;
    },
    endSession(token) { if (token) q.sessionDel.run(sha256(token)); },
    endOtherSessions(accountId, keepToken) { q.sessionsDelOthers.run(accountId, sha256(keepToken || "")); },

    // One open link per person: making a new one cancels the old.
    createInvite({ memberId, email, isAdmin }) {
      const token = newToken();
      q.invitesDelFor.run(memberId);
      q.inviteAdd.run(sha256(token), memberId, cleanEmail(email), isAdmin ? 1 : 0, now() + INVITE_DAYS * 86400000);
      return token;
    },
    getInvite: (token) => (token ? q.inviteGet.get(sha256(token), now()) : null),
    useInvite(token) { q.inviteDel.run(sha256(token)); },
  };
  return accounts;
}

const publicAccount = (a) => a && { id: a.id, email: a.email, memberId: a.member_id, isAdmin: !!a.is_admin, createdAt: a.created_at, lastLogin: a.last_login };

// Mounts /api/auth/* (open) and /api/accounts/* (admins), and returns the
// middleware that keeps every other /api route behind a signed-in session.
function mountAuth(app, store) {
  const accounts = openAccounts(store.db);
  const fails = new Map();

  const setCookie = (req, res, token, maxAgeSec) => {
    const parts = [COOKIE + "=" + (token || ""), "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=" + maxAgeSec];
    if (req.secure) parts.push("Secure");
    res.append("Set-Cookie", parts.join("; "));
  };
  const signIn = (req, res, account) => setCookie(req, res, accounts.startSession(account.id), SESSION_DAYS * 86400);
  const tokenOf = (req) => parseCookies(req.headers.cookie)[COOKIE];

  // Writes must come from this site's own pages.
  const sameOrigin = (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    const origin = req.headers.origin;
    if (origin) {
      let host = null;
      try { host = new URL(origin).host; } catch (e) {}
      if (host !== req.headers.host) return res.status(403).json({ error: "cross-site request refused" });
    }
    next();
  };
  const loadUser = (req, res, next) => { req.account = accounts.sessionAccount(tokenOf(req)); next(); };
  const requireUser = (req, res, next) => (req.account ? next() : res.status(401).json({ error: "sign in required", needsSetup: accounts.count() === 0 }));
  const requireAdmin = (req, res, next) => (req.account && req.account.is_admin ? next() : res.status(403).json({ error: "admins only" }));
  const body = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});
  const memberOf = (account) => store.get("members", account.member_id);
  const me = (account) => Object.assign(publicAccount(account), { name: (memberOf(account) || {}).name || account.email });

  app.use("/api", sameOrigin, loadUser);

  const r = express.Router();
  r.get("/me", requireUser, (req, res) => res.json({ account: me(req.account) }));

  r.post("/login", (req, res) => {
    const { email, password } = body(req);
    const key = req.ip + "|" + cleanEmail(email);
    const f = fails.get(key);
    if (f && f.until > now() && f.n >= MAX_FAILS) return res.status(429).json({ error: "Too many tries. Wait 15 minutes and try again." });
    const a = accounts.byEmail(email);
    if (!a || !checkPassword(password, a.password_hash)) {
      const cur = f && f.until > now() ? f : { n: 0, until: now() + FAIL_WINDOW_MS };
      cur.n++; fails.set(key, cur);
      return res.status(401).json({ error: "That email and password don't match." });
    }
    fails.delete(key);
    signIn(req, res, a);
    res.json({ account: me(a) });
  });

  r.post("/logout", (req, res) => {
    accounts.endSession(tokenOf(req));
    setCookie(req, res, "", 0);
    res.status(204).end();
  });

  r.post("/password", requireUser, (req, res) => {
    const { current, password } = body(req);
    if (!checkPassword(current, req.account.password_hash)) return res.status(400).json({ error: "Your current password isn't right." });
    const bad = passwordProblem(password);
    if (bad) return res.status(400).json({ error: bad });
    accounts.setPassword(req.account.id, password);
    accounts.endOtherSessions(req.account.id, tokenOf(req));
    res.status(204).end();
  });

  // First start: whoever opens the app creates the first admin account.
  r.post("/setup", (req, res) => {
    if (accounts.count() > 0) return res.status(409).json({ error: "Setup is already done. Sign in instead." });
    const { name, role, email, password } = body(req);
    const nm = String(name || "").trim();
    if (!nm) return res.status(400).json({ error: "Enter your name." });
    if (!validEmail(cleanEmail(email))) return res.status(400).json({ error: "Enter a valid email address." });
    const bad = passwordProblem(password);
    if (bad) return res.status(400).json({ error: bad });
    const members = store.all().members;
    let memberId = Object.keys(members).find((id) => String(members[id].name || "").trim().toLowerCase() === nm.toLowerCase());
    if (!memberId) {
      memberId = newId();
      store.set("members", memberId, { name: nm, role: String(role || "PM"), boards: ["pre", "post"], userId: null });
    }
    const a = accounts.create({ email, password, memberId, isAdmin: true });
    signIn(req, res, a);
    res.json({ account: me(a) });
  });

  r.get("/invite/:token", (req, res) => {
    const inv = accounts.getInvite(req.params.token);
    const m = inv && store.get("members", inv.member_id);
    if (!m) return res.status(404).json({ error: "This link has expired or was already used. Ask an admin for a new one." });
    res.json({ name: m.name, email: inv.email, reset: !!accounts.byMember(inv.member_id) });
  });

  r.post("/invite/:token", (req, res) => {
    const inv = accounts.getInvite(req.params.token);
    if (!inv || !store.get("members", inv.member_id)) return res.status(404).json({ error: "This link has expired or was already used. Ask an admin for a new one." });
    const { password } = body(req);
    const bad = passwordProblem(password);
    if (bad) return res.status(400).json({ error: bad });
    let a = accounts.byMember(inv.member_id);
    if (a) {
      accounts.setPassword(a.id, password);
      accounts.endOtherSessions(a.id, "");
    } else {
      const taken = accounts.byEmail(inv.email);
      if (taken) return res.status(409).json({ error: "Another login already uses " + inv.email + ". Ask an admin for a new link." });
      a = accounts.create({ email: inv.email, password, memberId: inv.member_id, isAdmin: !!inv.is_admin });
    }
    accounts.useInvite(req.params.token);
    signIn(req, res, accounts.get(a.id));
    res.json({ account: me(accounts.get(a.id)) });
  });
  app.use("/api/auth", r);

  const adm = express.Router();
  adm.use(requireUser, requireAdmin);
  adm.get("/", (req, res) => res.json({
    accounts: accounts.list().map(publicAccount),
    invites: accounts.pendingInvites().map((i) => ({ memberId: i.member_id, email: i.email, isAdmin: !!i.is_admin, expiresAt: i.expires_at })),
  }));

  // New login for a person on the team, or a password reset link for one who has a login.
  adm.post("/invite", (req, res) => {
    const { memberId, email, isAdmin } = body(req);
    if (!memberId || !store.get("members", memberId)) return res.status(400).json({ error: "Pick a person from the team first." });
    const existing = accounts.byMember(memberId);
    const em = existing ? existing.email : cleanEmail(email);
    if (!validEmail(em)) return res.status(400).json({ error: "Enter a valid email address." });
    const taken = accounts.byEmail(em);
    if (taken && taken.member_id !== memberId) return res.status(409).json({ error: em + " is already used by another login." });
    res.json({ token: accounts.createInvite({ memberId, email: em, isAdmin: existing ? !!existing.is_admin : !!isAdmin }), reset: !!existing });
  });

  adm.patch("/:id", (req, res) => {
    const a = accounts.get(req.params.id);
    if (!a) return res.status(404).json({ error: "not found" });
    const { isAdmin, email } = body(req);
    if (typeof isAdmin === "boolean" && !isAdmin && a.is_admin && accounts.adminCount() <= 1) return res.status(400).json({ error: "Keep at least one admin." });
    if (email !== undefined) {
      const em = cleanEmail(email);
      if (!validEmail(em)) return res.status(400).json({ error: "Enter a valid email address." });
      const taken = accounts.byEmail(em);
      if (taken && taken.id !== a.id) return res.status(409).json({ error: em + " is already used by another login." });
      accounts.setEmail(a.id, em);
    }
    if (typeof isAdmin === "boolean") accounts.setAdmin(a.id, isAdmin);
    res.json(publicAccount(accounts.get(a.id)));
  });

  adm.delete("/:id", (req, res) => {
    const a = accounts.get(req.params.id);
    if (!a) return res.status(204).end();
    if (a.is_admin && accounts.adminCount() <= 1) return res.status(400).json({ error: "Keep at least one admin." });
    accounts.remove(a.id);
    res.status(204).end();
  });
  app.use("/api/accounts", adm);

  return { accounts, requireUser, requireAdmin };
}

module.exports = { mountAuth, hashPassword, checkPassword, parseCookies };
