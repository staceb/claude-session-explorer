"""Index Claude Code transcripts (~/.claude/projects) into a local SQLite file.

Incremental: a transcript is re-read only when its size or mtime changes.
Run directly (`python3 index.py`) or let server.py call it on start-up.
"""
import collections
import glob
import json
import os
import re
import sqlite3
import sys

HOME = os.path.expanduser("~")
PROJECTS = os.path.join(HOME, ".claude", "projects")
HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, "sessions.db")
# summarise.py runs `claude -p` from here; those runs are bookkeeping, not sessions
SUMMARY_CWD = os.path.join(HERE, ".summarise")

TOOL_RESULT_CAP = 4000
TOOL_INPUT_CAP = 3000

SCHEMA = """
create table if not exists files(path text primary key, size int, mtime real);
create table if not exists sessions(
  id text primary key, path text, parent_id text, agent_label text,
  kind text, project text, cwd text, git_branch text,
  title text, first_prompt text, job text,
  started text, ended text,
  n_user int, n_assistant int, n_tools int, size int
);
create table if not exists messages(
  session_id text, seq int, ts text, role text, tool_name text,
  text text, detail text
);
create index if not exists messages_session on messages(session_id, seq);
create table if not exists file_writes(session_id text, path text, ts text);
create table if not exists summaries(
  session_id text primary key, data text, model text, created text, source_ended text
);
create table if not exists api_calls(
  session_id text, seq int, turn_seq int, ts text, model text,
  tok_in int, tok_cw int, tok_cr int, tok_out int
);
create index if not exists api_calls_session on api_calls(session_id, turn_seq);
create table if not exists agent_spawns(
  session_id text, tool_use_id text, seq int, turn_seq int, ts text,
  subagent_type text, description text, prompt text
);
create table if not exists bg_calls(
  kind text, ref text, label text, ts text, model text,
  tok_in int, tok_cw int, tok_cr int, tok_out int
);
create virtual table if not exists search using fts5(
  text, session_id unindexed, seq unindexed, tokenize='porter unicode61'
);
"""

SECRET_PATTERNS = [
    re.compile(r"\b(sk-(?:ant-|proj-)?)[A-Za-z0-9_\-]{16,}"),
    re.compile(r"\b(ghp_|gho_|github_pat_|xox[abp]-)[A-Za-z0-9_\-]{16,}"),
    re.compile(r"\b(AKIA)[A-Z0-9]{12,}"),
    re.compile(r"(eyJ)[A-Za-z0-9_\-]{16,}(?:\.[A-Za-z0-9_\-]*)*"),  # JWTs and fragments of them (Supabase, OAuth, sessions)
    re.compile(r"\b(sb_secret_|sb_publishable_|rk_live_|sk_live_|pk_live_|whsec_|xai-|AIza)[A-Za-z0-9_\-]{12,}"),
    re.compile(r"((?:api[_-]?key|token|secret|password|authorization)[\"']?\s*[:=]\s*[\"']?(?:Bearer\s+)?)[A-Za-z0-9_\-\.]{16,}", re.I),
]


def mask(s):
    """Hide anything that looks like a credential, keeping a recognisable prefix."""
    if not s:
        return s
    for p in SECRET_PATTERNS:
        s = p.sub(lambda m: m.group(1) + "••••", s)
    return s


# columns added after the first release: added in place, then every transcript is re-read to fill them
SESSION_EXTRA = [("tok_in", "int"), ("tok_cw", "int"), ("tok_cr", "int"), ("tok_out", "int"), ("model", "text"),
                 ("agent_type", "text"), ("agent_desc", "text"), ("spawn_depth", "int"), ("tool_use_id", "text"),
                 ("is_fork", "int")]

# relative price of each kind of token (input = 1), the same ratios across current Claude models:
# writing to the prompt cache costs 1.25x, re-reading it 0.1x, output 5x
WEIGHTS = dict(tok_in=1.0, tok_cw=1.25, tok_cr=0.1, tok_out=5.0)
WEIGHTED_SQL = "(coalesce({p}tok_in,0) + 1.25*coalesce({p}tok_cw,0) + 0.1*coalesce({p}tok_cr,0) + 5*coalesce({p}tok_out,0))"


def weighted(prefix=""):
    return WEIGHTED_SQL.format(p=prefix)


def connect():
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.executescript(SCHEMA)
    have = {r["name"] for r in db.execute("pragma table_info(sessions)")}
    missing = [(c, t) for c, t in SESSION_EXTRA if c not in have]
    for c, t in missing:
        db.execute(f"alter table sessions add column {c} {t}")
    if missing:
        db.execute("delete from files")
        db.commit()
    return db


def project_name(cwd):
    if not cwd:
        return "unknown"
    if cwd == HOME:
        return "home"
    if not cwd.startswith(HOME + os.sep) and cwd.startswith(("/private/tmp", "/tmp")):
        return "scratchpad"
    rel = cwd[len(HOME) + 1:] if cwd.startswith(HOME + os.sep) else cwd
    if rel.startswith("Documents/"):
        rel = rel[len("Documents/"):]
    return rel


def folder_project(folder):
    """Name a ~/.claude/projects folder ("-Users-ann-Documents-blog") the way project_name names a cwd."""
    home = re.sub(r"[^A-Za-z0-9]", "-", HOME)
    if folder == home:
        return "home"
    if folder.startswith(home + "-"):
        rest = folder[len(home) + 1:]
        return rest[len("Documents-"):] if rest.startswith("Documents-") else rest
    if folder.startswith(("-private-tmp", "-tmp")):
        return "scratchpad"
    return folder.lstrip("-")


def job_label(prompt):
    """Group automated runs by what they were asked to do: the prompt's opening clause."""
    if not prompt:
        return "(no prompt)"
    first = prompt.strip().split("\n")[0]
    first = re.split(r"(?<=[.!?:])\s", first)[0]
    first = re.sub(r"\d{4}-\d{2}-\d{2}", "<date>", first)
    return first[:90].rstrip(" ,.:") or "(no prompt)"


def block_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out = []
        for b in content:
            if isinstance(b, dict):
                if b.get("type") == "text":
                    out.append(b.get("text", ""))
                elif b.get("type") == "image":
                    out.append("[image]")
            elif isinstance(b, str):
                out.append(b)
        return "\n".join(out)
    return ""


def describe_tool(name, inp):
    """One-line label for a tool call, as the terminal would show it."""
    if not isinstance(inp, dict):
        return name
    for key in ("description", "file_path", "pattern", "query", "url", "prompt", "skill", "command"):
        v = inp.get(key)
        if isinstance(v, str) and v.strip():
            v = v.strip().split("\n")[0]
            if key == "file_path":
                v = v.replace(HOME, "~")
            return v[:140]
    return ""


def is_noise_user_text(t):
    t = t.strip()
    return (not t) or t.startswith(("<system-reminder>", "<local-command-caveat>", "Caveat:"))


def parse(path):
    meta = dict(cwd=None, git_branch=None, title=None, first_prompt=None,
                started=None, ended=None, entry=set())
    msgs, writes, spawns = [], [], []
    calls = {}  # API message id -> [first seq, turn seq, ts, model, usage]; streamed blocks repeat the id
    pending_tools = {}  # tool_use_id -> index in msgs
    counts = dict(user=0, assistant=0, tools=0)
    turn = -1  # seq of the request (your message) the current work belongs to; -1 = before any

    def add(ts, role, text, tool_name=None, detail=None):
        msgs.append([ts, role, tool_name, mask(text), mask(detail)])
        return len(msgs) - 1

    with open(path, errors="ignore") as fh:
        for line in fh:
            try:
                o = json.loads(line)
            except ValueError:
                continue
            ts = o.get("timestamp")
            if ts:
                meta["started"] = meta["started"] or ts
                meta["ended"] = ts
            if o.get("entrypoint"):
                meta["entry"].add(o["entrypoint"])
            meta["cwd"] = meta["cwd"] or o.get("cwd")
            meta["git_branch"] = meta["git_branch"] or o.get("gitBranch")
            t = o.get("type")
            if t == "ai-title" and o.get("aiTitle"):
                meta["title"] = o["aiTitle"]
                continue
            msg = o.get("message")
            if t not in ("user", "assistant") or not isinstance(msg, dict):
                continue
            content = msg.get("content")

            if t == "user":
                if isinstance(content, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
                    for b in content:
                        if isinstance(b, dict) and b.get("type") == "tool_result":
                            res = block_text(b.get("content"))
                            if len(res) > TOOL_RESULT_CAP:
                                res = res[:TOOL_RESULT_CAP] + f"\n… ({len(res) - TOOL_RESULT_CAP:,} more characters)"
                            i = pending_tools.pop(b.get("tool_use_id"), None)
                            if i is not None:
                                msgs[i][4] = mask((msgs[i][4] or "") + "\n\n── result" + (" (error)" if b.get("is_error") else "") + " ──\n" + res)
                    continue
                if o.get("isMeta") or o.get("isCompactSummary"):
                    continue
                text = block_text(content)
                if is_noise_user_text(text):
                    continue
                cmd = re.search(r"<command-name>(.*?)</command-name>", text)
                if cmd:
                    args = re.search(r"<command-args>(.*?)</command-args>", text, re.S)
                    turn = add(ts, "command", (cmd.group(1) + " " + (args.group(1).strip() if args else "")).strip())
                    continue
                if text.startswith("<local-command-stdout>") or text.startswith("<bash-"):
                    continue
                counts["user"] += 1
                meta["first_prompt"] = meta["first_prompt"] or text[:2000]
                turn = add(ts, "user", text)
            else:
                mid, usage = msg.get("id"), msg.get("usage")
                if mid and isinstance(usage, dict) and msg.get("model") != "<synthetic>":
                    if mid not in calls:
                        calls[mid] = [len(msgs), turn, ts, msg.get("model"), usage]
                    else:
                        calls[mid][4] = usage
                for b in content if isinstance(content, list) else []:
                    if not isinstance(b, dict):
                        continue
                    if b.get("type") == "text" and b.get("text", "").strip():
                        counts["assistant"] += 1
                        add(ts, "assistant", b["text"])
                    elif b.get("type") == "tool_use":
                        counts["tools"] += 1
                        name, inp = b.get("name", "tool"), b.get("input") or {}
                        detail = json.dumps(inp, indent=2, ensure_ascii=False)
                        if len(detail) > TOOL_INPUT_CAP:
                            detail = detail[:TOOL_INPUT_CAP] + "\n…"
                        seq = pending_tools[b.get("id")] = add(ts, "tool", describe_tool(name, inp), name, detail)
                        if name in ("Agent", "Task") and isinstance(inp, dict):
                            spawns.append((b.get("id"), seq, turn, ts, inp.get("subagent_type") or ("fork" if inp.get("fork") else "general-purpose"),
                                           mask(inp.get("description")), mask((inp.get("prompt") or "")[:1500])))
                        fp = inp.get("file_path") if isinstance(inp, dict) else None
                        if name in ("Write", "Edit", "MultiEdit") and fp:
                            writes.append((fp, ts))
    api = []
    for seq, turn_seq, ts, model, u in calls.values():
        api.append((seq, turn_seq, ts, model, u.get("input_tokens") or 0, u.get("cache_creation_input_tokens") or 0,
                    u.get("cache_read_input_tokens") or 0, u.get("output_tokens") or 0))
    return meta, msgs, writes, counts, api, spawns


def index_file(db, path, parent_id=None, agent=None):
    meta, msgs, writes, counts, api, spawns = parse(path)
    agent = agent or {}
    if meta["cwd"] == SUMMARY_CWD:
        return
    sid = os.path.splitext(os.path.basename(path))[0]
    if parent_id:
        kind = "subagent"
    elif "cli" in meta["entry"]:
        kind = "real"
    else:
        kind = "auto"
    db.execute("delete from messages where session_id=?", (sid,))
    db.execute("delete from search where session_id=?", (sid,))
    db.execute("delete from file_writes where session_id=?", (sid,))
    db.execute("delete from api_calls where session_id=?", (sid,))
    db.execute("delete from agent_spawns where session_id=?", (sid,))
    models = collections.Counter(a[3] for a in api if a[3])
    row = dict(
        id=sid, path=path, parent_id=parent_id, agent_label=agent.get("description") or agent.get("agentType"),
        kind=kind, project=project_name(meta["cwd"]), cwd=meta["cwd"], git_branch=meta["git_branch"],
        title=meta["title"], first_prompt=mask(meta["first_prompt"]),
        job=job_label(meta["first_prompt"]) if kind == "auto" else None,
        started=meta["started"], ended=meta["ended"], n_user=counts["user"], n_assistant=counts["assistant"],
        n_tools=counts["tools"], size=os.path.getsize(path),
        tok_in=sum(a[4] for a in api), tok_cw=sum(a[5] for a in api), tok_cr=sum(a[6] for a in api), tok_out=sum(a[7] for a in api),
        model=models.most_common(1)[0][0] if models else None,
        agent_type=agent.get("agentType"), agent_desc=agent.get("description"), spawn_depth=agent.get("spawnDepth"),
        tool_use_id=agent.get("toolUseId"), is_fork=1 if agent.get("isFork") or agent.get("agentType") == "fork" else 0,
    )
    db.execute(f"insert or replace into sessions({','.join(row)}) values({','.join('?' * len(row))})", list(row.values()))
    db.executemany("insert into api_calls values(?,?,?,?,?,?,?,?,?)", [(sid, *a) for a in api])
    db.executemany("insert into agent_spawns values(?,?,?,?,?,?,?,?)", [(sid, *x) for x in spawns])
    db.executemany(
        "insert into messages values(?,?,?,?,?,?,?)",
        [(sid, i, m[0], m[1], m[2], m[3], m[4]) for i, m in enumerate(msgs)],
    )
    db.executemany(
        "insert into search(text, session_id, seq) values(?,?,?)",
        [(m[3], sid, i) for i, m in enumerate(msgs) if m[1] in ("user", "assistant") and m[3]],
    )
    db.executemany("insert into file_writes values(?,?,?)", [(sid, p, t) for p, t in writes])


def run(verbose=True):
    db = connect()
    known = {r["path"]: (r["size"], r["mtime"]) for r in db.execute("select * from files")}
    top = glob.glob(os.path.join(PROJECTS, "*", "*.jsonl"))
    subs = glob.glob(os.path.join(PROJECTS, "*", "*", "subagents", "*.jsonl"))
    changed = 0
    for path in top + subs:
        st = os.stat(path)
        if known.get(path) == (st.st_size, st.st_mtime):
            continue
        parent = None
        agent = None
        if path in subs:
            parent = os.path.basename(os.path.dirname(os.path.dirname(path)))
            meta_path = path[:-len(".jsonl")] + ".meta.json"
            if os.path.exists(meta_path):
                try:
                    agent = json.load(open(meta_path))
                except ValueError:
                    pass
        try:
            index_file(db, path, parent, agent)
        except Exception as e:  # one bad transcript shouldn't stop the rest
            print(f"skipped {path}: {e}", file=sys.stderr)
            continue
        db.execute("insert or replace into files values(?,?,?)", (path, st.st_size, st.st_mtime))
        changed += 1
        if verbose and changed % 25 == 0:
            print(f"  indexed {changed}…")
            db.commit()
    gone = set(known) - set(top + subs)
    for path in gone:  # transcript deleted by Claude Code's cleanup: keep what we indexed
        db.execute("delete from files where path=?", (path,))
    db.commit()
    if verbose:
        print(f"Indexed {changed} changed transcript(s).")
    return changed


def memories():
    """Every memory file Claude keeps, parsed, with the sessions that wrote it."""
    con = connect()
    out = []
    for path in sorted(glob.glob(os.path.join(PROJECTS, "*", "memory", "*.md"))):
        if os.path.basename(path) == "MEMORY.md":
            continue
        text = open(path, errors="ignore").read()
        name = os.path.basename(path)
        folder = os.path.basename(os.path.dirname(os.path.dirname(path)))
        meta = {}
        m = re.match(r"---\n(.*?)\n---\n?", text, re.S)
        if m:
            for line in m.group(1).splitlines():
                k, _, v = line.partition(":")
                if v.strip():
                    meta[k.strip()] = v.strip()
            text = text[m.end():]
        sources = [dict(r) for r in con.execute(
            """select distinct w.session_id, s.title, s.kind, max(w.ts) as ts from file_writes w
               join sessions s on s.id = w.session_id
               where w.path = ? or w.path = ? group by w.session_id order by ts desc""",
            (path, path.replace(HOME, "~")))]
        out.append({
            "file": name, "path": path.replace(HOME, "~"),
            "project": folder_project(folder),
            "name": meta.get("name") or name[:-3], "description": meta.get("description", ""),
            "type": meta.get("type", ""), "body": mask(text.strip()),
            "modified": os.path.getmtime(path), "sources": sources,
        })
    return out


if __name__ == "__main__":
    run()
