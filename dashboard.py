"""Data for the Second Brain dashboard: usage over time, what's running, agents, and what's installed.

Everything here reads local files only: the index (sessions.db), ~/.claude, ~/.claude.json and launchd.
"""
import collections
import datetime
import glob
import json
import os
import plistlib
import re
import subprocess

import index
import manage

HOME = index.HOME
CLAUDE = os.path.join(HOME, ".claude")
BUILTIN_AGENTS = {"general-purpose", "Explore", "Plan", "claude-code-guide", "statusline-setup", "output-style-setup", "fork"}
# words in your message that mean you asked for agents
ASKED_RE = re.compile(r"\b(agents?|sub-?agents?|in parallel|parallel(?:ise|ize)?|fork(?:s|ed)?|spin (?:up|off)|spawn|delegate|workflow|team of|fan out)\b", re.I)
KIND_LABEL = {"real": "conversations", "subagent": "agents", "auto": "automated"}
TOK = "(coalesce(tok_in,0)+coalesce(tok_cw,0)+coalesce(tok_cr,0)+coalesce(tok_out,0))"


def tokens(row, prefix=""):
    g = lambda k: row[prefix + k] or 0
    return dict(total=g("tok_in") + g("tok_cw") + g("tok_cr") + g("tok_out"), new=g("tok_in") + g("tok_cw"),
                reread=g("tok_cr"), output=g("tok_out"))


def frontmatter(path):
    """`---` key: value block at the top of a markdown file → dict (single-line values only)."""
    try:
        text = open(path, errors="ignore").read(6000)
    except OSError:
        return {}
    m = re.match(r"---\s*\n(.*?)\n---", text, re.S)
    out = {}
    for line in (m.group(1).splitlines() if m else []):
        k, _, v = line.partition(":")
        if v.strip() and not k.startswith(" "):
            out[k.strip()] = v.strip().strip("\"'")
    return out


def birth(path):
    try:
        st = os.stat(path)
        return datetime.datetime.fromtimestamp(getattr(st, "st_birthtime", st.st_mtime)).isoformat(timespec="seconds")
    except OSError:
        return None


def claude_json():
    try:
        return json.load(open(os.path.join(HOME, ".claude.json")))
    except (OSError, ValueError):
        return {}


def project_dirs(db):
    """Folders you've run Claude Code in (still on disk), for finding project-level agents, skills and MCP servers."""
    dirs = {r[0] for r in db.execute("select distinct cwd from sessions where kind='real' and cwd is not null")}
    # your home folder's .claude is the user-level folder, already covered on its own
    return sorted(d for d in dirs if os.path.isdir(d) and d != HOME and not d.startswith(("/private/tmp", "/tmp")))


# ── running now ───────────────────────────────────────────────────────────────

def process_table():
    try:
        out = subprocess.run(["ps", "-axo", "pid=,rss=,etime=,command="], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return {}
    procs = {}
    for line in out.splitlines():
        parts = line.split(None, 3)
        if len(parts) == 4 and parts[0].isdigit():
            procs[int(parts[0])] = dict(rss_mb=int(parts[1]) // 1024, etime=parts[2], command=parts[3])
    return procs


def running(db):
    """Claude Code processes that are still open, matched to their session via ~/.claude/sessions/<pid>.json."""
    procs = process_table()
    out = []
    for f in glob.glob(os.path.join(CLAUDE, "sessions", "*.json")):
        try:
            info = json.load(open(f))
            pid = int(info.get("pid") or os.path.basename(f).split(".")[0])
        except (ValueError, OSError):
            continue
        p = procs.get(pid)
        if not p or "claude" not in p["command"]:
            continue
        s = db.execute(f"select id, title, first_prompt, project, kind, ended, {TOK} as tok from sessions where id=?",
                       (info.get("sessionId"),)).fetchone()
        started = info.get("startedAt")
        out.append(dict(
            pid=pid, session_id=info.get("sessionId"), status=info.get("status") or "unknown",
            title=(s["title"] if s else None) or (s and (s["first_prompt"] or "")[:60]) or info.get("name"),
            project=s["project"] if s else index.project_name(info.get("cwd")), cwd=(info.get("cwd") or "").replace(HOME, "~"),
            kind=info.get("kind"), started=datetime.datetime.utcfromtimestamp(started / 1000).isoformat() + "Z" if started else None,
            last_active=s["ended"] if s else None, tokens=s["tok"] if s else 0, memory_mb=p["rss_mb"], open_for=p["etime"],
        ))
    out.sort(key=lambda r: r["last_active"] or "", reverse=True)
    return out


# ── usage over time ───────────────────────────────────────────────────────────

def week_of(ts):
    d = datetime.date.fromisoformat(ts[:10])
    return (d - datetime.timedelta(days=d.weekday())).isoformat()


def weekly(db, weeks=20):
    """Tokens per week (Monday start) for conversations, agents and automated runs (incl. Session Explorer's own calls)."""
    start = (datetime.date.today() - datetime.timedelta(weeks=weeks)).isoformat()
    acc = collections.defaultdict(lambda: collections.Counter())
    for kind, ts, t, o in db.execute(
            """select s.kind, a.ts, coalesce(a.tok_in,0)+coalesce(a.tok_cw,0)+coalesce(a.tok_cr,0)+coalesce(a.tok_out,0), coalesce(a.tok_out,0)
               from api_calls a join sessions s on s.id=a.session_id where a.ts >= ?""", (start,)):
        if ts:
            acc[week_of(ts)][KIND_LABEL.get(kind, "automated")] += t
    for ts, t in db.execute("select ts, coalesce(tok_in,0)+coalesce(tok_cw,0)+coalesce(tok_cr,0)+coalesce(tok_out,0) from bg_calls where ts >= ?", (start,)):
        acc[week_of(ts)]["automated"] += t
    first = datetime.date.fromisoformat(week_of(start + "T"))
    rows = []
    for i in range(weeks + 1):
        wk = (first + datetime.timedelta(weeks=i)).isoformat()
        if wk > datetime.date.today().isoformat():
            break
        for k in ("conversations", "agents", "automated"):
            rows.append(dict(week=wk, kind=k, tokens=acc[wk][k]))
    return rows


def month_totals(db):
    today = datetime.date.today()
    this = today.replace(day=1)
    last = (this - datetime.timedelta(days=1)).replace(day=1)
    q = f"select coalesce(sum({TOK.replace('tok_', 'a.tok_')}),0) from api_calls a where a.ts >= ? and a.ts < ?"
    nxt = (this + datetime.timedelta(days=32)).replace(day=1)
    return dict(this_month=db.execute(q, (this.isoformat(), nxt.isoformat())).fetchone()[0],
                last_month=db.execute(q, (last.isoformat(), this.isoformat())).fetchone()[0],
                this_label=this.strftime("%B"), last_label=last.strftime("%B"))


def heaviest_sessions(db, days=30, limit=8):
    """Sessions ranked by tokens used in the window, each counting the agents it launched."""
    since = (datetime.date.today() - datetime.timedelta(days=days)).isoformat()
    per = collections.Counter()
    for sid, parent, kind, t in db.execute(
            f"""select s.id, s.parent_id, s.kind, {TOK.replace('tok_', 'a.tok_')} from api_calls a join sessions s on s.id=a.session_id
                where a.ts >= ?""", (since,)):
        per[parent if kind == "subagent" and parent else sid] += t
    out = []
    for sid, t in per.most_common(limit):
        s = db.execute("select id, title, first_prompt, project, kind, ended from sessions where id=?", (sid,)).fetchone()
        if s:
            out.append(dict(id=sid, title=s["title"] or (s["first_prompt"] or "Untitled")[:70], project=s["project"],
                            kind=s["kind"], ended=s["ended"], tokens=t))
    return out


def turns(db, sid):
    """Each request in a session (your message → everything until the next) with its tokens, agents included."""
    rows = db.execute(
        f"""select a.turn_seq, count(*) calls, sum({TOK.replace('tok_', 'a.tok_')}) tok, sum(coalesce(a.tok_out,0)) outp, min(a.ts) ts
            from api_calls a where a.session_id=? and a.turn_seq >= 0 group by a.turn_seq""", (sid,)).fetchall()
    agent_tok = collections.Counter()
    for turn_seq, t in db.execute(
            f"""select sp.turn_seq, {TOK.replace('tok_', 's.tok_')} from agent_spawns sp join sessions s on s.tool_use_id=sp.tool_use_id
                where sp.session_id=?""", (sid,)):
        agent_tok[turn_seq] += t
    out = []
    for r in rows:
        m = db.execute("select role, text from messages where session_id=? and seq=?", (sid, r["turn_seq"])).fetchone()
        out.append(dict(seq=r["turn_seq"], ts=r["ts"], calls=r["calls"], tokens=r["tok"], output=r["outp"],
                        agent_tokens=agent_tok.get(r["turn_seq"], 0), text=(m["text"] if m else "")[:300],
                        role=m["role"] if m else "user"))
    return out


def heaviest_turns(db, kind="real", limit=60):
    rows = db.execute(
        f"""select a.session_id, a.turn_seq, sum({TOK.replace('tok_', 'a.tok_')}) tok, sum(coalesce(a.tok_out,0)) outp, min(a.ts) ts, count(*) calls
            from api_calls a join sessions s on s.id=a.session_id
            where s.kind=? and a.turn_seq >= 0 group by a.session_id, a.turn_seq order by tok desc limit ?""", (kind, limit)).fetchall()
    out = []
    for r in rows:
        s = db.execute("select title, first_prompt, project from sessions where id=?", (r["session_id"],)).fetchone()
        m = db.execute("select text from messages where session_id=? and seq=?", (r["session_id"], r["turn_seq"])).fetchone()
        ag = db.execute(f"""select coalesce(sum({TOK.replace('tok_', 's.tok_')}),0) from agent_spawns sp join sessions s on s.tool_use_id=sp.tool_use_id
                            where sp.session_id=? and sp.turn_seq=?""", (r["session_id"], r["turn_seq"])).fetchone()[0]
        out.append(dict(session_id=r["session_id"], seq=r["turn_seq"], tokens=r["tok"], output=r["outp"], ts=r["ts"], calls=r["calls"],
                        agent_tokens=ag, text=(m["text"] if m else "")[:240],
                        session=(s["title"] or (s["first_prompt"] or "")[:60]) if s else "", project=s["project"] if s else ""))
    return out


# ── agents ────────────────────────────────────────────────────────────────────

def agent_definitions(db):
    found = []
    roots = [("user", "all projects", os.path.join(CLAUDE, "agents"))]
    roots += [("project", index.project_name(d), os.path.join(d, ".claude", "agents")) for d in project_dirs(db)]
    roots += [("plugin", p.split(os.sep)[-3], p) for p in glob.glob(os.path.join(CLAUDE, "plugins", "cache", "*", "*", "*", "agents"))]
    seen = set()
    for scope, where, folder in roots:
        for path in sorted(glob.glob(os.path.join(folder, "*.md"))):
            if path in seen:
                continue
            seen.add(path)
            fm = frontmatter(path)
            created = db.execute("""select s.id, s.title, min(w.ts) from file_writes w join sessions s on s.id=w.session_id
                                    where w.path=? group by s.id order by min(w.ts) limit 1""", (path,)).fetchone()
            found.append(dict(name=fm.get("name") or os.path.basename(path)[:-3], description=fm.get("description", ""),
                              model=fm.get("model"), tools=fm.get("tools"), scope=scope, where=where,
                              path=path.replace(HOME, "~"), status="installed", installed=birth(path),
                              created_in=dict(id=created[0], title=created[1], ts=created[2]) if created else None))
    # agent files a session wrote that are gone now (and weren't archived from here)
    archived = {a["original"] for a in manage.load() if a["kind"] == "agent"}
    for path, sid, title, ts in db.execute(
            """select w.path, s.id, s.title, min(w.ts) from file_writes w join sessions s on s.id=w.session_id
               where w.path like '%/.claude/agents/%.md' group by w.path"""):
        if not os.path.exists(path) and path not in seen and path not in archived:
            found.append(dict(name=os.path.basename(path)[:-3], description="", scope="project", where=index.project_name(path.split("/.claude/")[0]),
                              path=path.replace(HOME, "~"), status="deleted", created_in=dict(id=sid, title=title, ts=ts)))
    for a in manage.load():
        if a["kind"] == "agent":
            found.append(dict(name=a["name"], description=a.get("description", ""), scope="archived", where="archive",
                              path=a["original"].replace(HOME, "~"), status="archived", archive_id=a["id"]))
    return found


def trigger_of(db, run):
    """Who decided to launch this agent: you, Claude, another agent, or a script."""
    if (run["spawn_depth"] or 1) > 1:
        return "agent"
    parent = db.execute("select kind from sessions where id=?", (run["parent_id"],)).fetchone()
    if parent and parent["kind"] == "auto":
        return "scripted"
    sp = db.execute("select session_id, turn_seq from agent_spawns where tool_use_id=?", (run["tool_use_id"],)).fetchone()
    if not sp:
        return "unknown"
    m = db.execute("select text from messages where session_id=? and seq=?", (sp["session_id"], sp["turn_seq"])).fetchone()
    return "you" if m and ASKED_RE.search(m["text"] or "") else "claude"


def agents(db):
    defs = agent_definitions(db)
    by_name = {d["name"]: d for d in defs if d["status"] in ("installed", "archived")}
    recent = (datetime.datetime.utcnow() - datetime.timedelta(minutes=3)).isoformat()
    runs = []
    for r in db.execute(f"select *, {TOK} as tok from sessions where kind='subagent' order by started"):
        sp = db.execute("select session_id, turn_seq from agent_spawns where tool_use_id=?", (r["tool_use_id"],)).fetchone()
        runs.append(dict(id=r["id"], parent_id=r["parent_id"], type=r["agent_type"] or "general-purpose",
                         description=r["agent_desc"] or r["agent_label"] or "", started=r["started"], ended=r["ended"],
                         tokens=tokens(r), steps=r["n_tools"], model=r["model"], depth=r["spawn_depth"] or 1,
                         trigger=trigger_of(db, r), running=bool(r["ended"] and r["ended"] > recent),
                         turn_seq=sp["turn_seq"] if sp else None))
    types = {}
    for run in runs:
        t = types.setdefault(run["type"], dict(name=run["type"], runs=0, tokens=0, last=None, parents=set()))
        t["runs"] += 1
        t["tokens"] += run["tokens"]["total"]
        t["last"] = max(t["last"] or "", run["started"] or "")
        t["parents"].add(run["parent_id"])
    for d in defs:
        if d["status"] in ("installed", "archived"):
            types.setdefault(d["name"], dict(name=d["name"], runs=0, tokens=0, last=None, parents=set()))
    for t in types.values():
        d = by_name.get(t["name"])
        t["kind"] = "fork" if t["name"] == "fork" else "yours" if d else "built-in" if t["name"] in BUILTIN_AGENTS else "unknown"
        t["status"] = d["status"] if d else ("built-in" if t["name"] in BUILTIN_AGENTS else "definition not found")
        t["definition"] = d
        t["parents"] = sorted(p for p in t["parents"] if p)
    parent_ids = sorted({r["parent_id"] for r in runs if r["parent_id"]})
    parents = []
    for pid in parent_ids:
        s = db.execute("select id, title, first_prompt, project, kind, started, ended from sessions where id=?", (pid,)).fetchone()
        mine = [r for r in runs if r["parent_id"] == pid]
        parents.append(dict(id=pid, title=(s["title"] or (s["first_prompt"] or "")[:60]) if s else pid[:8],
                            project=s["project"] if s else "", kind=s["kind"] if s else "", runs=len(mine),
                            tokens=sum(r["tokens"]["total"] for r in mine), last=max(r["started"] or "" for r in mine)))
    triggers = collections.Counter(r["trigger"] for r in runs)
    return dict(types=sorted(types.values(), key=lambda t: -t["tokens"]), runs=runs, parents=parents,
                definitions=defs, triggers=triggers, running=[r for r in runs if r["running"]])


# ── installed ─────────────────────────────────────────────────────────────────

def skill_entry(path, source, loaded, usage):
    folder = os.path.dirname(path) if path.endswith("SKILL.md") else path
    name = os.path.basename(folder)
    fm = frontmatter(os.path.join(folder, "SKILL.md"))
    has_file = os.path.exists(os.path.join(folder, "SKILL.md"))
    keys = {fm.get("name") or name, name}
    # plugin and synced skills are recorded as "<plugin>:<skill>"
    u = next((v for k, v in usage.items() if k in keys or k.split(":")[-1] in keys), {})
    desc = fm.get("description", "")
    return dict(name=fm.get("name") or name, description=desc, source=source, path=folder.replace(HOME, "~"),
                loaded=loaded and has_file, note=None if has_file or not loaded else "no SKILL.md, so Claude Code skips it",
                context_tokens=(len(name) + len(desc)) // 4 + 8 if loaded and has_file else 0,
                used=u.get("usageCount", 0) if loaded else 0, last_used=ms_iso(u.get("lastUsedAt")) if loaded else None,
                installed=birth(folder))


def ms_iso(ms):
    return datetime.datetime.utcfromtimestamp(ms / 1000).isoformat() + "Z" if ms else None


def skills(db, usage):
    out = []
    for p in sorted(glob.glob(os.path.join(CLAUDE, "skills", "*"))):
        if os.path.isdir(p) and os.path.basename(p) != "synced":
            out.append(skill_entry(p, "your skills folder", True, usage) | dict(manageable=True))
    for p in sorted(glob.glob(os.path.join(CLAUDE, "skills", "synced", "*", "*", "SKILL.md"))):
        out.append(skill_entry(p, "synced from claude.ai", True, usage))
    for p in sorted(glob.glob(os.path.join(CLAUDE, "plugins", "cache", "*", "*", "*", "skills", "*", "SKILL.md"))):
        out.append(skill_entry(p, "plugin: " + p.split(os.sep)[-5], True, usage))
    for d in project_dirs(db):
        for p in sorted(glob.glob(os.path.join(d, ".claude", "skills", "*"))):
            if os.path.isdir(p):
                out.append(skill_entry(p, "project: " + index.project_name(d), True, usage) | dict(manageable=True))
    for p in sorted(glob.glob(os.path.join(HOME, ".agents", "skills", "*"))):
        if os.path.isdir(p):
            out.append(skill_entry(p, "~/.agents (another tool's folder)", False, usage) | dict(manageable=True))
    for a in manage.load():
        if a["kind"] == "skill":
            out.append(dict(name=a["name"], description=a.get("description", ""), source="archived", path=a["original"].replace(HOME, "~"),
                            loaded=False, context_tokens=0, used=0, archived=True, archive_id=a["id"]))
    return out


def mcp_servers(db, cj, tool_usage):
    out = []

    def usage(prefix):
        n = sum(v.get("usageCount", 0) for k, v in tool_usage.items() if k.startswith(prefix))
        n_tx = db.execute("select count(*), max(ts) from messages where role='tool' and tool_name like ?", (prefix + "%",)).fetchone()
        last = max([ms_iso(v.get("lastUsedAt")) or "" for k, v in tool_usage.items() if k.startswith(prefix)] + [n_tx[1] or ""])
        return max(n, n_tx[0]), last or None

    for name, cfg in (cj.get("mcpServers") or {}).items():
        used, last = usage(f"mcp__{name}__")
        out.append(dict(name=name, kind="MCP server", scope="all projects", transport=cfg.get("type") or "stdio",
                        target=(cfg.get("url") or cfg.get("command") or "").replace(HOME, "~"), used=used, last_used=last,
                        manageable=True, manage_scope="user"))
    for proj, v in (cj.get("projects") or {}).items():
        for name, cfg in (v.get("mcpServers") or {}).items():
            used, last = usage(f"mcp__{name}__")
            out.append(dict(name=name, kind="MCP server", scope=index.project_name(proj), transport=cfg.get("type") or "stdio",
                            target=(cfg.get("url") or cfg.get("command") or "").replace(HOME, "~"), used=used, last_used=last,
                            manageable=True, manage_scope="local", project=proj))
    # claude.ai connectors: named in the deferred-tool list of your latest conversation
    latest = db.execute("select path from sessions where kind='real' order by ended desc limit 1").fetchone()
    names = set()
    if latest and os.path.exists(latest["path"]):
        with open(latest["path"], errors="ignore") as fh:
            for line in fh:
                if '"attachment"' in line and "mcp__claude_ai_" in line:
                    names.update(re.findall(r"mcp__claude_ai_([A-Za-z0-9_]+?)__", line))
    for n in sorted(names):
        used, last = usage(f"mcp__claude_ai_{n}__")
        out.append(dict(name=n.replace("_", " "), kind="claude.ai connector", scope="your claude.ai account", transport="connector",
                        target="claude.ai → Settings → Connectors", used=used, last_used=last, manageable=False))
    for a in manage.load():
        if a["kind"] == "mcp":
            out.append(dict(name=a["name"], kind="MCP server", scope="archived", transport="", target="", used=0,
                            archived=True, archive_id=a["id"]))
    return out


def scheduled():
    out = []
    try:
        listed = subprocess.run(["launchctl", "list"], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        listed = ""
    status = {}
    for line in listed.splitlines()[1:]:
        parts = line.split("\t")
        if len(parts) == 3:
            status[parts[2]] = (parts[0], parts[1])
    for plist in sorted(glob.glob(os.path.join(HOME, "Library", "LaunchAgents", "*.plist"))):
        try:
            d = plistlib.load(open(plist, "rb"))
        except Exception:
            continue
        args = d.get("ProgramArguments") or [d.get("Program", "")]
        script = next((a for a in args[1:] if a.endswith((".sh", ".py", ".zsh"))), None)
        text = " ".join(args)
        if script and os.path.exists(script):
            text += open(script, errors="ignore").read(20000)
        if "claude" not in text:
            continue
        label = d.get("Label") or os.path.basename(plist)[:-6]
        pid, code = status.get(label, (None, None))
        log = d.get("StandardErrorPath") or d.get("StandardOutPath")
        last_line = None
        if log and os.path.exists(log):
            with open(log, errors="ignore") as fh:
                tail = fh.read()[-400:].strip().splitlines()
                last_line = tail[-1][:200] if tail else None
        state = "not loaded" if label not in status else "running" if pid not in (None, "-") else "failing" if code not in ("0", None) else "ok"
        out.append(dict(name=label, kind="launchd job", schedule=schedule_text(d), script=(script or args[0]).replace(HOME, "~"),
                        state=state, exit_code=code, last_log=last_line, path=plist.replace(HOME, "~"), manageable=True))
    try:
        cron = subprocess.run(["crontab", "-l"], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        cron = ""
    for line in cron.splitlines():
        if line.strip() and not line.startswith("#"):
            paths = [p for p in re.findall(r"(/\S+\.(?:sh|py))", line)]
            missing = [p for p in paths if not os.path.exists(p)]
            out.append(dict(name=" ".join(line.split()[5:])[:80].replace(HOME, "~"), kind="cron line", schedule=" ".join(line.split()[:5]),
                            script=(paths[0] if paths else "").replace(HOME, "~"), state="failing" if missing else "ok",
                            last_log="script not found" if missing else None, manageable=False))
    for a in manage.load():
        if a["kind"] == "job":
            out.append(dict(name=a["name"], kind="launchd job", schedule="", script="", state="archived", archived=True, archive_id=a["id"]))
    return out


def schedule_text(d):
    cal = d.get("StartCalendarInterval")
    if cal:
        days = "Mon Tue Wed Thu Fri Sat Sun".split()
        items = cal if isinstance(cal, list) else [cal]
        bits = []
        for c in items:
            t = f"{c.get('Hour', 0):02d}:{c.get('Minute', 0):02d}"
            bits.append((days[(c["Weekday"] - 1) % 7] + " " if "Weekday" in c else "") + t)
        return ("daily " if all("Weekday" not in c for c in items) else "") + ", ".join(bits)
    if d.get("StartInterval"):
        return f"every {d['StartInterval'] // 60} min"
    return "at login" if d.get("RunAtLoad") else "on demand"


def memory_and_instructions(db):
    out = []
    for folder in sorted(glob.glob(os.path.join(index.PROJECTS, "*", "memory"))):
        files = [f for f in glob.glob(os.path.join(folder, "*.md"))]
        idx = os.path.join(folder, "MEMORY.md")
        size = os.path.getsize(idx) if os.path.exists(idx) else 0
        out.append(dict(name="Memory · " + index.folder_project(os.path.basename(os.path.dirname(folder))), kind="memory",
                        notes=len([f for f in files if not f.endswith("MEMORY.md")]), context_tokens=size // 4,
                        path=folder.replace(HOME, "~"), updated=max((os.path.getmtime(f) for f in files), default=None)))
    for p in [os.path.join(CLAUDE, "CLAUDE.md")] + [os.path.join(d, "CLAUDE.md") for d in project_dirs(db)]:
        if os.path.exists(p):
            out.append(dict(name="Instructions · " + ("all projects" if p.startswith(CLAUDE) else index.project_name(os.path.dirname(p))),
                            kind="instructions", context_tokens=os.path.getsize(p) // 4, path=p.replace(HOME, "~"),
                            updated=os.path.getmtime(p)))
    return out


def plugins():
    try:
        data = json.load(open(os.path.join(CLAUDE, "plugins", "installed_plugins.json")))
    except (OSError, ValueError):
        return []
    try:
        enabled = json.load(open(os.path.join(CLAUDE, "settings.json"))).get("enabledPlugins") or {}
    except (OSError, ValueError):
        enabled = {}
    out = []
    for key, installs in (data.get("plugins") or {}).items():
        i = installs[0] if installs else {}
        out.append(dict(name=key.split("@")[0], marketplace=key.split("@")[-1], version=i.get("version"),
                        installed=i.get("installedAt"), enabled=bool(enabled.get(key)), kind="plugin"))
    return out


def installed(db):
    cj = claude_json()
    sk = skills(db, cj.get("skillUsage") or {})
    mcp = mcp_servers(db, cj, cj.get("toolUsage") or {})
    ag = [d for d in agent_definitions(db)]
    jobs = scheduled()
    mem = memory_and_instructions(db)
    pl = plugins()
    # what a session in your home folder starts with: global skills + its memory index + global instructions
    # (a project adds its own skills and memory on top)
    home_name = "Memory · home"
    loaded_tokens = (sum(s["context_tokens"] for s in sk if not s["source"].startswith("project:"))
                     + sum(m["context_tokens"] for m in mem if m["name"] in (home_name, "Instructions · all projects")))
    return dict(skills=sk, mcp=mcp, agents=ag, jobs=jobs, memory=mem, plugins=pl,
                summary=dict(skills_loaded=sum(1 for s in sk if s["loaded"]), skills_unused=sum(1 for s in sk if s["loaded"] and not s["used"]),
                             skills_global=sum(1 for s in sk if s["loaded"] and not s["source"].startswith("project:")),
                             skills_not_loaded=sum(1 for s in sk if not s["loaded"] and not s.get("archived")),
                             connectors=len([m for m in mcp if not m.get("archived")]),
                             agents=len([a for a in ag if a["status"] == "installed"]),
                             jobs=len([j for j in jobs if not j.get("archived")]), jobs_failing=sum(1 for j in jobs if j["state"] in ("failing", "not loaded")),
                             plugins=len(pl), loaded_tokens=loaded_tokens, archived=len(manage.load())))


# ── overview ──────────────────────────────────────────────────────────────────

def overview(db):
    counts = {r["kind"]: r["n"] for r in db.execute("select kind, count(*) n from sessions group by kind")}
    inst = installed(db)
    run = running(db)
    m = None
    try:
        import map as mindmap
        mp = mindmap.load()
        if mp:
            m = dict(centre=mp.get("centre"), themes=[dict(name=t["name"], status=t["status"], size=len(t["items"])) for t in mp["themes"]])
    except Exception:
        pass
    ag = agents(db)
    return dict(
        months=month_totals(db), weekly=weekly(db), heaviest=heaviest_sessions(db),
        counts=dict(conversations=counts.get("real", 0), automated=counts.get("auto", 0), agent_runs=counts.get("subagent", 0)),
        running=run, agents_running=len(ag["running"]), triggers=ag["triggers"],
        installed=inst["summary"], memory_notes=sum(x.get("notes", 0) for x in inst["memory"]), map=m,
    )
