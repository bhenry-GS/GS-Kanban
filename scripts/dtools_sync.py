#!/usr/bin/env python3
"""Plan a D-Tools Cloud -> Kanban board sync.

Reads the board's current "projects" documents (one JSON file per document,
as saved by an ArtifactData list with out_dir) and the live D-Tools data, then
writes the changes to apply into an output folder:

  <out>/plan.json   [{op, doc_id, file}]  op is "set" (new) or "update"
  <out>/docs/*.json the document body or fields for each write

Board work is never overwritten: an existing card keeps its column, due date,
tasks and other edits. Only the D-Tools fields (name, number, client, stage)
are refreshed, a missing due date is filled in, and a card whose D-Tools item
has closed is moved to the board's last column (opportunities lost or on hold
are archived instead).

The API key is read from the DTOOLS_API_KEY environment variable only.

Usage: dtools_sync.py <board-projects-dir> <out-dir> [--columns boards.json]
"""
import glob
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone

API = "https://dtcloudapi.d-tools.cloud/api/v1"
# Fixed Basic credential from D-Tools' public API docs; the same for every
# customer. The per-company secret is the X-API-Key header.
BASIC = "RFRDbG91ZEFQSVVzZXI6MyNRdVkrMkR1QCV3Kk15JTU8Yi1aZzlV"

DEFAULT_COLUMNS = {
    "pre": ["Lead", "Qualify", "Engineering review", "Quote", "Negotiation", "Won / Lost"],
    "post": ["Kickoff", "Design & Drafting", "Programming", "Procurement & Build",
             "Ship & Install", "Billing & Closeout", "Complete"],
}

# D-Tools stage -> board column for newly added cards. Unknown stages land in
# the board's first column.
POST_STAGE = {
    "Accepted": "Kickoff",
    "Deposit/PO Rcvd HOLDING": "Kickoff",
    "Engineering/ Drafting": "Design & Drafting",
    "Partially Ordered": "Procurement & Build",
    "100% Materials Ordered": "Procurement & Build",
    "Materials Received": "Procurement & Build",
    "Scheduled": "Ship & Install",
    "In Progress": "Ship & Install",
    "Pending Change Orders": "Ship & Install",
    "Pending Schedule of Readiness": "Ship & Install",
    "Completed/ Not Invoiced": "Billing & Closeout",
}
PRE_STAGE = {"New": "Lead", "Engineering": "Engineering review", "Proposal Shared": "Quote"}


def get(path, **params):
    key = os.environ.get("DTOOLS_API_KEY")
    if not key:
        sys.exit("DTOOLS_API_KEY is not set")
    req = urllib.request.Request(
        API + path + "?" + urllib.parse.urlencode(params),
        headers={"X-API-Key": key, "Authorization": "Basic " + BASIC},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def fetch_all(kind):
    items, page = [], 1
    while True:
        batch = get(f"/{kind}/Get{kind}", page=page, pageSize=100)[kind.lower()]
        items += batch
        if len(batch) < 100:
            return items
        page += 1


def day(s):
    return s[:10] if s else None


def main():
    board_dir, out = sys.argv[1], sys.argv[2]
    columns = dict(DEFAULT_COLUMNS)
    if "--columns" in sys.argv:
        cfg = json.load(open(sys.argv[sys.argv.index("--columns") + 1]))
        for b in ("pre", "post"):
            if isinstance(cfg.get(b), list) and cfg[b]:
                columns[b] = cfg[b]

    board = {}
    for f in glob.glob(os.path.join(board_dir, "*.json")):
        doc = json.load(open(f))
        if doc.get("dtoolsId"):
            # A won opportunity keeps its id as the project id, so key by board too.
            board[(doc.get("board"), doc["dtoolsId"])] = (os.path.basename(f)[:-5], doc)
    used_ids = {os.path.basename(f)[:-5] for f in glob.glob(os.path.join(board_dir, "*.json"))}

    records = []
    for p in fetch_all("Projects"):
        if p.get("isArchived"):
            continue
        records.append(dict(board="post", active=p["systemState"] != "Completed", closed="done",
                            src=p, people={"projectManager": p.get("projectManager") or ""}))
    for o in fetch_all("Opportunities"):
        if o.get("isArchived"):
            continue
        state = o["systemState"]
        records.append(dict(board="pre", active=state == "Open",
                            closed="done" if state == "Won" else "archive",
                            src=o, people={"owner": o.get("owner") or ""}))

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    os.makedirs(os.path.join(out, "docs"), exist_ok=True)
    plan = []

    def emit(op, doc_id, data):
        path = os.path.join(out, "docs", doc_id + ".json")
        json.dump(data, open(path, "w"))
        plan.append({"op": op, "doc_id": doc_id, "file": path})

    for r in records:
        s, b = r["src"], r["board"]
        fields = dict(name=s["name"] or "Untitled", number=s.get("number") or "",
                      client=s.get("clientName") or "", dtoolsStage=s.get("stage") or "", **r["people"])
        hit = board.get((b, s["id"]))
        if not hit:
            if not r["active"]:
                continue
            stage_map = POST_STAGE if b == "post" else PRE_STAGE
            col = stage_map.get(s.get("stage"))
            if col not in columns[b]:
                col = columns[b][0]
            due = day(s.get("estimatedCloseDate"))
            if b == "post":
                due = day(get("/Projects/GetProject", id=s["id"]).get("endDate"))
            doc_id = ("dt-" if b == "post" else "dto-") + s["id"].replace("-", "")[:8]
            n = 8
            while doc_id in used_ids:
                n += 1
                doc_id = doc_id[:doc_id.index("-") + 1] + s["id"].replace("-", "")[:n]
            used_ids.add(doc_id)
            emit("set", doc_id, dict(board=b, due=due, column=col, templateId=None, archived=False,
                                     createdAt=now, source="dtools", dtoolsId=s["id"], **fields))
            continue

        doc_id, doc = hit
        change = {k: v for k, v in fields.items() if doc.get(k) != v}
        if not doc.get("due") and b == "pre" and day(s.get("estimatedCloseDate")):
            change["due"] = day(s.get("estimatedCloseDate"))
        if not r["active"] and not doc.get("archived"):
            if r["closed"] == "archive":
                change["archived"] = True
            elif doc.get("column") != columns[b][-1]:
                change["column"] = columns[b][-1]
        if change:
            emit("update", doc_id, change)

    json.dump(plan, open(os.path.join(out, "plan.json"), "w"), indent=1)
    added = sum(1 for p in plan if p["op"] == "set")
    print(f"{added} new, {len(plan) - added} updated -> {out}/plan.json")


if __name__ == "__main__":
    main()
