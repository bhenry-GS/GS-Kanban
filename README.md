# GS Kanban

Shared Kanban boards for the GS team:

- **Pre sales** (Sales, Engineering) and **Post sales** (PM, Engineering, Billing, Shipping & Receiving, Programming, Drafting), each with main columns you can rename and reorder.
- **Projects with several tasks at once.** Each task has a role, an assignee, a due date and optional prerequisites.
- **Pathway templates.** A new project picks up its tasks from a template, with due dates counted back from the project due date. Templates are edited in the app.
- **Alerts** for late tasks, prerequisites that aren't done ahead of a due date, unassigned work due this week, and projects nearing their deadline.
- **My tasks**: a personal list for each person, sorted by due date.
- **Logins.** Everyone signs in with their email and a password. Each login belongs to a person on the Team page. Admins add people and send them an invite link to set their password.
- **D-Tools Cloud sync**: open D-Tools projects become Post sales projects and open opportunities become Pre sales projects, placed in the column that matches their D-Tools stage.

## Run it

```sh
npm install
npm start          # http://localhost:3000
npm test
```

Data is kept in SQLite at `$DATA_DIR/kanban.db` (default `./data`). On first start the two starter templates in `seed/templates.json` are loaded.

## Logins

1. The first time anyone opens a new install, the app asks them to create the first **admin** account (name, role, email, password). Do this right after deploying, before sharing the address.
2. Admins add people on the **Team** page, then click **Invite** on a person's row. That makes a one-time link (good for 7 days) to send them in Zoom chat or email. Opening it lets them choose a password, and they're signed in.
3. Forgot a password? An admin opens that person's **Login** and makes a reset link. Admins can also make someone an admin or remove a login there. Removing a person from the team removes their login.

Only admins can change the Team page; everyone signed in can work on the boards. Passwords are stored as salted scrypt hashes, and sign-ins last 30 days (stored in an HttpOnly cookie). No email server is needed, since invite links are copied and sent by hand.

## Settings

All settings are environment variables. Keep secrets in your host's secret settings, never in this repo.

| Variable | Purpose |
| --- | --- |
| `PORT` | Port to listen on (default 3000) |
| `DATA_DIR` | Folder for the database (default `./data`; `/data` in Docker) |
| `TRUST_PROXY` | Set to `1` when the app runs behind an HTTPS proxy or load balancer (Render, Fly.io, Railway, nginx) so sign-in cookies are marked secure |
| `DTOOLS_API_KEY` | D-Tools Cloud API key. Sync stays off without it |
| `DTOOLS_BASIC_AUTH` | The fixed `Authorization` header value from D-Tools Cloud's API docs (starts with `Basic `). Sync stays off without it |
| `DTOOLS_SYNC_MINUTES` | How often to sync (default 15) |

## Deploy

The `Dockerfile` runs anywhere that keeps a persistent volume mounted at `/data` (Render, Fly.io, Railway, or a server in the office). It needs a host that runs a server: GitHub Pages only serves static files, so it can't run the app or its logins. Serve it over HTTPS so passwords aren't sent in the clear.

## Layout

- `public/index.html`: the whole board UI (plain HTML, CSS and JavaScript, no build step). The same page also runs as a claude.ai Artifact, where it uses Claude's built-in store and the Zoom connector for "Find tasks in Zoom chat".
- `server/index.js`: web server, JSON API (`/api/all`, `PUT`/`PATCH`/`DELETE /api/:collection/:id`) and live updates (`/api/stream`).
- `server/store.js`: document store on SQLite.
- `server/auth.js`: logins, sessions and invite links (`/api/auth/*`, and `/api/accounts/*` for admins). Every other `/api` route needs a signed-in session.
- `server/dtools.js`: D-Tools Cloud sync. Pulls projects and opportunities every `DTOOLS_SYNC_MINUTES`. A project already on the board only has its name, number, customer and D-Tools stage refreshed, so board edits are kept. The stage-to-column map is at the top of the file.
- `server/templates.js`: creates a project's tasks from a template on the server.
