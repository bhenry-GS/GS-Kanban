const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { openStore } = require("./store");
const { createApp } = require("./index");
const { hashPassword, checkPassword } = require("./auth");

function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsk-auth-"));
  const store = openStore(path.join(dir, "t.db"));
  const server = createApp(store).listen(0);
  const base = "http://127.0.0.1:" + server.address().port + "/api/";
  // A tiny client that keeps its own sign-in cookie, like one browser.
  const client = () => {
    let cookie = "";
    return async (method, url, body, headers) => {
      const r = await fetch(base + url, {
        method, headers: Object.assign({ "Content-Type": "application/json", Cookie: cookie }, headers), body: body ? JSON.stringify(body) : undefined,
      });
      const sc = r.headers.get("set-cookie");
      if (sc) cookie = sc.split(";")[0];
      const text = await r.text();
      return { status: r.status, body: text ? JSON.parse(text) : null };
    };
  };
  return { store, server, client };
}

test("passwords are hashed with a salt and checked", () => {
  const h = hashPassword("correct horse");
  assert.notStrictEqual(h, hashPassword("correct horse"));
  assert.ok(!h.includes("correct horse"));
  assert.ok(checkPassword("correct horse", h));
  assert.ok(!checkPassword("wrong", h));
});

test("first admin setup, sign in, sign out", async () => {
  const { store, server, client } = start();
  try {
    const admin = client();
    assert.deepStrictEqual((await admin("GET", "all")).body, { error: "sign in required", needsSetup: true });
    assert.strictEqual((await admin("POST", "auth/setup", { name: "Bradley", email: "B@Example.com", password: "short" })).status, 400);
    let r = await admin("POST", "auth/setup", { name: "Bradley", role: "PM", email: "B@Example.com", password: "longenough" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.account.isAdmin, true);
    assert.strictEqual(r.body.account.email, "b@example.com");
    assert.strictEqual(store.get("members", r.body.account.memberId).name, "Bradley");
    assert.strictEqual((await admin("GET", "all")).status, 200);
    assert.ok(!JSON.stringify((await admin("GET", "all")).body).includes("scrypt"));

    assert.strictEqual((await client()("POST", "auth/setup", { name: "Eve", email: "e@x.co", password: "longenough" })).status, 409);

    assert.strictEqual((await admin("POST", "auth/logout")).status, 204);
    assert.strictEqual((await admin("GET", "auth/me")).status, 401);
    assert.strictEqual((await admin("POST", "auth/login", { email: "b@example.com", password: "nope-nope" })).status, 401);
    r = await admin("POST", "auth/login", { email: "b@example.com", password: "longenough" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await admin("GET", "auth/me")).body.account.name, "Bradley");
  } finally { server.close(); }
});

test("setup links to an existing team member with the same name", async () => {
  const { store, server, client } = start();
  try {
    store.set("members", "m1", { name: "Bradley Henry", role: "PM", boards: ["post"] });
    const r = await client()("POST", "auth/setup", { name: "bradley henry", email: "b@x.co", password: "longenough" });
    assert.strictEqual(r.body.account.memberId, "m1");
    assert.strictEqual(Object.keys(store.all().members).length, 1);
  } finally { server.close(); }
});

test("admin invites a team member, who sets a password and signs in", async () => {
  const { store, server, client } = start();
  try {
    const admin = client();
    await admin("POST", "auth/setup", { name: "Admin", email: "a@x.co", password: "longenough" });
    store.set("members", "m2", { name: "Sam", role: "Engineering", boards: ["pre", "post"] });

    let r = await admin("POST", "accounts/invite", { memberId: "m2", email: "sam@x.co" });
    assert.strictEqual(r.status, 200);
    const token = r.body.token;
    assert.ok(token.length > 30);
    assert.strictEqual((await admin("GET", "accounts")).body.invites[0].email, "sam@x.co");

    const sam = client();
    assert.deepStrictEqual((await sam("GET", "auth/invite/" + token)).body, { name: "Sam", email: "sam@x.co", reset: false });
    assert.strictEqual((await sam("POST", "auth/invite/" + token, { password: "x" })).status, 400);
    r = await sam("POST", "auth/invite/" + token, { password: "sams-password" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.account.isAdmin, false);
    assert.strictEqual((await sam("GET", "all")).status, 200);
    assert.strictEqual((await client()("GET", "auth/invite/" + token)).status, 404, "link works once");

    // Not an admin: can work the board but not change the team or logins.
    assert.strictEqual((await sam("PUT", "projects/p1", { name: "Job" })).status, 200);
    assert.strictEqual((await sam("PATCH", "members/m2", { role: "PM" })).status, 403);
    assert.strictEqual((await sam("GET", "accounts")).status, 403);

    // Reset link for someone who already has a login keeps their email.
    r = await admin("POST", "accounts/invite", { memberId: "m2" });
    assert.strictEqual(r.body.reset, true);
    await client()("POST", "auth/invite/" + r.body.token, { password: "new-password" });
    assert.strictEqual((await sam("GET", "all")).status, 401, "reset signs out old sessions");
    assert.strictEqual((await client()("POST", "auth/login", { email: "sam@x.co", password: "new-password" })).status, 200);

    // Removing the person removes their login.
    assert.strictEqual((await admin("DELETE", "members/m2")).status, 204);
    assert.strictEqual((await client()("POST", "auth/login", { email: "sam@x.co", password: "new-password" })).status, 401);
  } finally { server.close(); }
});

test("the last admin is kept, and other sites can't post", async () => {
  const { server, client } = start();
  try {
    const admin = client();
    const me = (await admin("POST", "auth/setup", { name: "Admin", email: "a@x.co", password: "longenough" })).body.account;
    assert.strictEqual((await admin("PATCH", "accounts/" + me.id, { isAdmin: false })).status, 400);
    assert.strictEqual((await admin("DELETE", "accounts/" + me.id)).status, 400);
    assert.strictEqual((await admin("DELETE", "members/" + me.memberId)).status, 400);
    assert.strictEqual((await admin("PUT", "projects/p1", { name: "x" }, { Origin: "https://evil.example" })).status, 403);
  } finally { server.close(); }
});

test("sign-in pauses after repeated wrong passwords", async () => {
  const { server, client } = start();
  try {
    await client()("POST", "auth/setup", { name: "Admin", email: "a@x.co", password: "longenough" });
    const c = client();
    for (let i = 0; i < 10; i++) await c("POST", "auth/login", { email: "a@x.co", password: "wrong-one" });
    assert.strictEqual((await c("POST", "auth/login", { email: "a@x.co", password: "longenough" })).status, 429);
  } finally { server.close(); }
});
