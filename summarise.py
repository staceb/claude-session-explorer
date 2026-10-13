"""Write a short structured summary for each session, using `claude -p` on your plan.

  python3 summarise.py              # every real conversation not yet summarised (or grown since)
  python3 summarise.py --limit 3    # just a few, to try it
  python3 summarise.py --session ID # one session (re-does it even if summarised)
  python3 summarise.py --kind auto  # automated runs instead
"""
import argparse
import datetime
import json
import os
import shutil
import subprocess
import sys

import index

MODEL = "sonnet"
CHAR_BUDGET = 150_000

SYSTEM = """You summarise a person's past conversation with Claude Code (an AI assistant) so they can find and remember it later.
Write to the person directly as "you". Be concrete: names, numbers, decisions, file or product names. No filler, no praise.
Return ONLY a JSON object, no code fences, with exactly these keys:
{
  "summary": "2-4 sentences: what this session was about and where it ended up",
  "topics": ["3-6 short topic tags, lowercase"],
  "decisions": ["things you decided or settled on, one line each"],
  "about_you": ["durable things learned about you: preferences, feedback on how Claude should work, context about your life or projects. Only things worth remembering next time. Empty if none."],
  "open_threads": ["things left unfinished or to come back to"],
  "outputs": ["concrete things produced: files, drafts, plans, artifacts"]
}
Each list may be empty. Never include API keys, passwords or other secrets."""


def ask_claude(system, text, model=MODEL, timeout=600, kind="summary", ref=None, label=None):
    """One tool-less `claude -p` call that must answer with a JSON object. Leaves no transcript behind,
    so its token usage is recorded in bg_calls instead."""
    os.makedirs(index.SUMMARY_CWD, exist_ok=True)
    claude = shutil.which("claude")
    if not claude:
        raise RuntimeError("Claude Code isn't installed or isn't on your PATH: summaries need the `claude` command.")
    proc = subprocess.run(
        # --strict-mcp-config: with tools off, Claude Code would otherwise load every MCP connector's
        # full description (~50k tokens per call); this keeps the overhead to a few hundred
        [claude, "-p", "--model", model, "--no-session-persistence", "--tools", "", "--strict-mcp-config",
         "--system-prompt", system, "--output-format", "json"],
        input=text, capture_output=True, text=True, cwd=index.SUMMARY_CWD, timeout=timeout,
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout).strip()[:500])
    out = json.loads(proc.stdout)
    u = out.get("usage") or {}
    db = index.connect()
    db.execute("insert into bg_calls values(?,?,?,?,?,?,?,?,?)",
               (kind, ref, label, datetime.datetime.utcnow().isoformat(timespec="seconds") + "Z", model,
                u.get("input_tokens") or 0, u.get("cache_creation_input_tokens") or 0,
                u.get("cache_read_input_tokens") or 0, u.get("output_tokens") or 0))
    db.commit()
    result = out.get("result", "").strip()
    return json.loads(result[result.find("{"): result.rfind("}") + 1])


def condense(db, sid):
    """Turn a session into readable text that fits the budget: your words in full, Claude's shortened, tools as one-liners."""
    rows = db.execute("select role, tool_name, text, ts from messages where session_id=? order by seq", (sid,)).fetchall()

    def build(assistant_cap, with_tools):
        out = []
        for r in rows:
            t = r["text"] or ""
            if r["role"] == "user":
                out.append(f"\nYOU: {t[:4000]}")
            elif r["role"] == "assistant":
                out.append(f"CLAUDE: {t[:assistant_cap]}{'…' if len(t) > assistant_cap else ''}")
            elif r["role"] == "command":
                out.append(f"[ran /{t.lstrip('/')}]")
            elif with_tools:
                out.append(f"  [{r['tool_name']}: {t[:120]}]")
        return "\n".join(out)

    for cap, tools in ((2000, True), (600, True), (300, False)):
        text = build(cap, tools)
        if len(text) <= CHAR_BUDGET:
            return text
    head = int(CHAR_BUDGET * 0.35)
    return text[:head] + "\n\n[… middle of a very long session omitted …]\n\n" + text[-(CHAR_BUDGET - head):]


def summarise(db, sid, model=MODEL):
    s = db.execute("select * from sessions where id=?", (sid,)).fetchone()
    body = condense(db, sid)
    if not body.strip():
        return None
    header = (f"Session title: {s['title'] or '(untitled)'}\nProject folder: {s['project']}\n"
              f"Dates: {(s['started'] or '')[:16]} to {(s['ended'] or '')[:16]} (UTC)\n\nTRANSCRIPT\n")
    data = ask_claude(SYSTEM, header + body, model, kind="summary", ref=sid, label=s["title"])
    for k, v in data.items():
        if isinstance(v, str):
            data[k] = index.mask(v)
        elif isinstance(v, list):
            data[k] = [index.mask(x) for x in v if isinstance(x, str)]
    db.execute("insert or replace into summaries values(?,?,?,?,?)",
               (sid, json.dumps(data), model, datetime.datetime.utcnow().isoformat(timespec="seconds"), s["ended"]))
    db.commit()
    return data


def pending(db, kind="real", quiet_minutes=60):
    """Sessions with no summary, or that have grown since — skipping any touched in the last `quiet_minutes` (likely still open)."""
    cutoff = (datetime.datetime.utcnow() - datetime.timedelta(minutes=quiet_minutes)).isoformat()
    return [r["id"] for r in db.execute(
        """select s.id from sessions s left join summaries x on x.session_id=s.id
           where s.kind=? and s.n_user>0 and s.ended < ? and (x.session_id is null or x.source_ended != s.ended)
           order by s.ended desc""", (kind, cutoff))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session")
    ap.add_argument("--kind", default="real", choices=["real", "auto", "subagent"])
    ap.add_argument("--limit", type=int)
    ap.add_argument("--model", default=MODEL)
    a = ap.parse_args()
    index.run(verbose=False)
    db = index.connect()
    ids = [a.session] if a.session else pending(db, a.kind)[: a.limit]
    print(f"Summarising {len(ids)} session(s) with {a.model}…")
    for i, sid in enumerate(ids, 1):
        title = db.execute("select title from sessions where id=?", (sid,)).fetchone()
        print(f"[{i}/{len(ids)}] {title['title'] if title else sid}", flush=True)
        try:
            summarise(db, sid, a.model)
        except Exception as e:
            print(f"   failed: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
