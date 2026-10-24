# GS Kanban

Shared Kanban boards for the GS team:

- **Pre sales** (Sales, Engineering) and **Post sales** (PM, Engineering, Billing, Shipping & Receiving, Programming, Drafting), each with main columns you can rename and reorder.
- **Projects with several tasks at once.** Each task has a role, an assignee, a due date and optional prerequisites.
- **Pathway templates.** A new project picks up its tasks from a template, with due dates counted back from the project due date. Templates are edited in the app.
- **Alerts** for late tasks, prerequisites that aren't done ahead of a due date, unassigned work due this week, and projects nearing their deadline.
- **My tasks**: a personal list for each person, sorted by due date.
- **D-Tools Cloud sync** (in progress): won D-Tools projects become Post sales projects.

## Run it

```sh
npm install
npm start          # http://localhost:3000
npm test
```

Data is kept in SQLite at `$DATA_DIR/kanban.db` (default `./data`). On first start the two starter templates in `seed/templates.json` are loaded.

## Settings

All settings are environment variables. Keep secrets in your host's secret settings, never in this repo.

| Variable | Purpose |
| --- | --- |
| `PORT` | Port to listen on (default 3000) |
| `DATA_DIR` | Folder for the database (default `./data`; `/data` in Docker) |
| `BASIC_AUTH_USER`, `BASIC_AUTH_PASS` | Optional shared sign-in for the whole app |
| `DTOOLS_API_KEY` | D-Tools Cloud API key. Sync stays off without it |
| `DTOOLS_SYNC_MINUTES` | How often to sync (default 15) |

## Deploy

The `Dockerfile` runs anywhere that keeps a persistent volume mounted at `/data` (Render, Fly.io, Railway, or a server in the office).

## Layout

- `public/index.html`: the whole board UI (plain HTML, CSS and JavaScript, no build step). The same page also runs as a claude.ai Artifact, where it uses Claude's built-in store and the Zoom connector for "Find tasks in Zoom chat".
- `server/index.js`: web server, JSON API (`/api/all`, `PUT`/`PATCH`/`DELETE /api/:collection/:id`) and live updates (`/api/stream`).
- `server/store.js`: document store on SQLite.
- `server/dtools.js`: D-Tools Cloud sync. The import logic is in place and tested; the call that fetches projects from D-Tools still needs wiring to their API.
- `server/templates.js`: creates a project's tasks from a template on the server.
