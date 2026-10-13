"""Second Brain (Session Explorer): a local dashboard for your Claude Code sessions.

  python3 server.py          # indexes new sessions, then opens http://127.0.0.1:8765
"""
import datetime
import glob
import json
import os
import re
import sqlite3
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import dashboard
import index
import manage
import map as mindmap
import summarise

PORT = int(os.environ.get("PORT", 8765))
STATIC = os.path.join(index.HERE, "static")
TYPES = {".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".html": "text/html; charset=utf-8",
         ".svg": "image/svg+xml", ".png": "image/png"}
ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
lock = threading.Lock()
jobs = {}  # session id -> "running" | "done" | error text


def db():
    return index.connect()


def refresh():
    with lock:
        index.run(verbose=False)


def session_rows(kind):
    rows = db().execute(
        """select s.*, x.data as summary from sessions s left join summaries x on x.session_id=s.id
           where s.kind=? order by s.started desc""", (kind,)).fetchall()
    return [dict(r) | {"summary": json.loads(r["summary"]) if r["summary"] else None} for r in rows]


def sessions_payload(kind):
    if kind == "running":
        return dashboard.running(db())
    return session_rows(kind)


def session_detail(sid):
    con = db()
    s = con.execute("select * from sessions where id=?", (sid,)).fetchone()
    if not s:
        return None
    x = con.execute("select * from summaries where session_id=?", (sid,)).fetchone()
    msgs = [dict(r) for r in con.execute(
        "select seq, ts, role, tool_name, text, detail from messages where session_id=? order by seq", (sid,))]
    subs = [dict(r) for r in con.execute(
        f"select id, agent_label, agent_type, n_tools, started, {dashboard.TOK} as tokens from sessions where parent_id=? order by started", (sid,))]
    return dict(s) | {
        "summary": json.loads(x["data"]) if x else None,
        "summary_model": x["model"] if x else None,
        "summary_stale": bool(x and x["source_ended"] != s["ended"]),
        "messages": msgs, "subagents": subs, "job_status": jobs.get(sid),
        "tokens": dashboard.tokens(s), "agent_tokens": sum(x["tokens"] or 0 for x in subs),
        "turns": dashboard.turns(con, sid),
    }


def search(q, kind):
    terms = [t for t in re.findall(r"\w+", q)]
    if not terms:
        return []
    match = " ".join(f'"{t}"' for t in terms)
    sql = """select search.session_id, search.seq, snippet(search, 0, char(1), char(2), '…', 18) as snip,
                    s.title, s.kind, s.project, s.started, m.role
             from search join sessions s on s.id = search.session_id
             join messages m on m.session_id = search.session_id and m.seq = search.seq
             where search match ? {kind} order by rank limit 150"""
    args = [match]
    if kind:
        sql = sql.format(kind="and s.kind = ?")
        args.append(kind)
    else:
        sql = sql.format(kind="")
    try:
        return [dict(r) for r in db().execute(sql, args)]
    except sqlite3.OperationalError:
        return []


def stats():
    con = db()
    c = {r["kind"]: r["n"] for r in con.execute("select kind, count(*) n from sessions group by kind")}
    c["summarised"] = con.execute("select count(*) from summaries x join sessions s on s.id=x.session_id where s.kind='real'").fetchone()[0]
    c["memories"] = len([p for p in glob.glob(os.path.join(index.PROJECTS, "*", "memory", "*.md")) if not p.endswith("/MEMORY.md")])
    return c


update = {"stage": "idle"}  # the Update button's progress, polled by the page


def run_update():
    """Read new sessions, summarise what's new or has grown, then rebuild the map if anything changed."""
    started = datetime.datetime.now().strftime("%H:%M")
    try:
        update.update(stage="indexing", detail="Reading new sessions…", done=0, total=0, error=None)
        refresh()
        con = index.connect()
        ids = summarise.pending(con, "real", quiet_minutes=10)
        update.update(stage="summarising", total=len(ids))
        failed = 0
        for i, sid in enumerate(ids, 1):
            title = con.execute("select title from sessions where id=?", (sid,)).fetchone()["title"] or "untitled"
            update.update(done=i - 1, detail=f"Summarising {i} of {len(ids)}: {title}")
            try:
                summarise.summarise(con, sid)
            except Exception:
                failed += 1
        update.update(done=len(ids))
        rebuilt = False
        if mindmap.is_stale():
            update.update(stage="map", detail="Rebuilding the map…")
            mindmap.build()
            rebuilt = True
        bits = [f"{len(ids) - failed} summarised" if ids else "no new sessions", "map rebuilt" if rebuilt else "map up to date"]
        if failed:
            bits.append(f"{failed} failed")
        update.update(stage="done", detail=f"Updated {started} · " + ", ".join(bits))
    except Exception as e:
        update.update(stage="error", detail=f"Update failed: {e}", error=str(e))


def run_map():
    jobs["__map__"] = "running"
    try:
        mindmap.build()
        jobs["__map__"] = "done"
    except Exception as e:
        jobs["__map__"] = f"error: {e}"


def run_summary(sid):
    jobs[sid] = "running"
    try:
        summarise.summarise(index.connect(), sid)
        jobs[sid] = "done"
    except Exception as e:
        jobs[sid] = f"error: {e}"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, obj, status=200, ctype="application/json"):
        body = obj if isinstance(obj, bytes) else json.dumps(obj, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def trusted(self, write=False):
        """Only this app may talk to the server: blocks DNS rebinding (Host) and other sites' requests (Origin)."""
        if self.headers.get("Host") not in ALLOWED_HOSTS:
            return False
        origin = self.headers.get("Origin")
        if origin and origin.split("//", 1)[-1] not in ALLOWED_HOSTS:
            return False
        if write and not (self.headers.get("Content-Type") or "").startswith("application/json"):
            return False
        return True

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        try:
            return json.loads(self.rfile.read(n) or b"{}") if n else {}
        except ValueError:
            return {}

    def do_GET(self):
        if not self.trusted():
            return self.send({"error": "forbidden"}, 403)
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        p = u.path
        if p in ("/", "/index.html"):
            return self.send(open(os.path.join(STATIC, "index.html"), "rb").read(), ctype="text/html; charset=utf-8")
        if p.startswith("/static/"):
            name = os.path.basename(p)
            path = os.path.join(STATIC, name)
            if os.path.splitext(name)[1] in TYPES and os.path.isfile(path):
                return self.send(open(path, "rb").read(), ctype=TYPES[os.path.splitext(name)[1]])
            return self.send({"error": "not found"}, 404)
        if p == "/api/stats":
            refresh()
            return self.send(stats())
        if p == "/api/sessions":
            return self.send(sessions_payload(q.get("kind", "real")))
        if p == "/api/overview":
            refresh()
            return self.send(dashboard.overview(db()))
        if p == "/api/running":
            return self.send(dashboard.running(db()))
        if p == "/api/turns":
            return self.send(dashboard.heaviest_turns(db(), q.get("kind", "real")))
        if p == "/api/agents":
            refresh()
            return self.send(dashboard.agents(db()))
        if p == "/api/installed":
            return self.send(dashboard.installed(db()))
        if p.startswith("/api/session/"):
            d = session_detail(p.rsplit("/", 1)[1])
            return self.send(d) if d else self.send({"error": "not found"}, 404)
        if p == "/api/search":
            return self.send(search(q.get("q", ""), q.get("kind")))
        if p == "/api/map":
            return self.send({"map": mindmap.load(), "status": jobs.get("__map__")})
        if p == "/api/update":
            return self.send(update)
        if p == "/api/memory":
            return self.send(index.memories())
        self.send({"error": "not found"}, 404)

    def do_POST(self):
        if not self.trusted(write=True):
            return self.send({"error": "forbidden"}, 403)
        p = urlparse(self.path).path
        if p == "/api/manage":
            b = self.body()
            try:
                if b.get("action") == "archive":
                    r = manage.archive(b.get("kind"), path=b.get("path"), name=b.get("name"),
                                       mcp_scope=b.get("scope") or "user", project=b.get("project"))
                elif b.get("action") == "restore":
                    r = manage.restore(b.get("id"))
                else:
                    return self.send({"error": "unknown action"}, 400)
                return self.send({"ok": True, "item": r})
            except Exception as e:
                return self.send({"error": str(e)}, 400)
        if p == "/api/update":
            if update["stage"] not in ("indexing", "summarising", "map"):
                update["stage"] = "indexing"
                threading.Thread(target=run_update, daemon=True).start()
            return self.send(update)
        if p == "/api/map/rebuild":
            if jobs.get("__map__") != "running":
                threading.Thread(target=run_map, daemon=True).start()
            return self.send({"status": "running"})
        if p.startswith("/api/summarise/"):
            sid = p.rsplit("/", 1)[1]
            if jobs.get(sid) != "running":
                threading.Thread(target=run_summary, args=(sid,), daemon=True).start()
            return self.send({"status": "running"})
        self.send({"error": "not found"}, 404)


if __name__ == "__main__":
    print("Indexing sessions…")
    index.run()
    url = f"http://127.0.0.1:{PORT}"
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Second Brain running at {url}  (Ctrl+C to stop)")
    if "--no-open" not in sys.argv:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
