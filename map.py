"""Build the mind map: your conversations, memories and automated jobs, grouped into themes and linked.

  python3 map.py     # (re)build map.json — one `claude -p` call for themes and links, the rest is local

Grouping and the explained cross-links come from Claude; the faint "similar" links come from a local
word-overlap score (TF-IDF), which also pulls similar things together on the map.
"""
import collections
import datetime
import json
import math
import os
import re

import index
import summarise

MAP_PATH = os.path.join(index.HERE, "map.json")

SYSTEM = """You turn one person's Claude Code history into a mind map of what they are working on and thinking about.
You get a list of items: conversations (with summaries), memory notes Claude keeps about them, and automated jobs they ran.
Group every item into 6-10 themes that would feel true to them: name what the work or thought is *about*, not the tool used.
Personal and inner-life threads (feelings, family, identity, writing) are themes too, and matter as much as work.
Then find 15-30 links between items in DIFFERENT themes that they might not have noticed: a shared idea, a tension,
one thing feeding another. Write to the person as "you". Be specific; no filler.
Return ONLY a JSON object:
{
  "centre": "one sentence: what you are mostly focused on right now",
  "themes": [
    {"id": "t1", "name": "2-4 words", "blurb": "one sentence", "status": "active | simmering | parked",
     "items": ["n1", "n7"]}
  ],
  "links": [{"a": "n3", "b": "n12", "why": "under 12 words"}]
}
Every item id appears in exactly one theme. Status: active = touched in the last ~3 weeks, parked = explicitly paused or long untouched."""

STOP = set("""the and for that this with you your are was were have has had not but they them their from what when where which who will
would could should into about then than there here just like also more most some such only very can its it's out our own all any
each how why yes yep okay ok one two use used using want need make made get got see let i'm don't it is be to of in on at by as or
an a we me my he she his her so if do does did no up new set via per now way""".split())


def short(text, n):
    text = re.sub(r"\s+", " ", text or "").strip()
    return text if len(text) <= n else text[: n - 1] + "…"


def collect():
    """Every item that can go on the map, with the text Claude and the similarity score see."""
    db = index.connect()
    nodes = []
    for s in db.execute("""select s.*, x.data from sessions s left join summaries x on x.session_id=s.id
                           where s.kind='real' and s.n_user>0 order by s.started"""):
        x = json.loads(s["data"]) if s["data"] else {}
        gist = x.get("summary") or short(s["first_prompt"], 400)
        extra = " ".join(x.get("topics", []) + x.get("open_threads", [])[:3] + x.get("decisions", [])[:3])
        nodes.append(dict(kind="session", ref=s["id"], title=s["title"] or short(s["first_prompt"], 60),
                          date=s["ended"], gist=gist, text=f"{s['title']} {gist} {extra}",
                          weight=s["n_user"], topics=x.get("topics", []), project=s["project"]))
    for m in index.memories():
        date = datetime.datetime.utcfromtimestamp(m["modified"]).isoformat() + "Z"
        nodes.append(dict(kind="memory", ref=m["path"], title=m["name"], date=date,
                          gist=m["description"] or short(m["body"], 200), text=f"{m['name']} {m['description']} {short(m['body'], 600)}",
                          weight=1, mtype=m["type"], project=m["project"], body=m["body"]))
    jobs = collections.defaultdict(list)
    for s in db.execute("select id, job, project, started, first_prompt from sessions where kind='auto' order by started"):
        jobs[s["job"]].append(s)
    for job, runs in jobs.items():
        nodes.append(dict(kind="job", ref=runs[-1]["id"], title=short(job, 70), date=runs[-1]["started"],
                          gist=f"{len(runs)} automated run{'s' if len(runs) != 1 else ''} in {runs[-1]['project']}: {short(runs[-1]['first_prompt'], 300)}",
                          text=f"{job} {short(runs[-1]['first_prompt'], 800)}", weight=len(runs), project=runs[-1]["project"],
                          runs=len(runs), first=runs[0]["started"]))
    for i, n in enumerate(nodes, 1):
        n["id"] = f"n{i}"
    return nodes


def similarity_links(nodes, per_node=3, threshold=0.12):
    """TF-IDF cosine similarity over each item's text; keep each item's few closest neighbours."""
    docs = [collections.Counter(w for w in re.findall(r"[a-z][a-z'\-]{2,}", n["text"].lower()) if w not in STOP) for n in nodes]
    df = collections.Counter(w for d in docs for w in d)
    N = len(docs)
    vecs = []
    for d in docs:
        v = {w: (1 + math.log(c)) * math.log(N / df[w]) for w, c in d.items() if df[w] > 1}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1
        vecs.append({w: x / norm for w, x in v.items()})
    pairs = {}
    for i, a in enumerate(vecs):
        scores = []
        for j, b in enumerate(vecs):
            if i != j:
                small, big = (a, b) if len(a) < len(b) else (b, a)
                s = sum(x * big.get(w, 0) for w, x in small.items())
                if s >= threshold:
                    scores.append((s, j))
        for s, j in sorted(scores, reverse=True)[:per_node]:
            key = tuple(sorted((i, j)))
            pairs[key] = max(pairs.get(key, 0), s)
    return [dict(a=nodes[i]["id"], b=nodes[j]["id"], score=round(s, 3)) for (i, j), s in pairs.items()]


def build(model=summarise.MODEL):
    nodes = collect()
    today = datetime.date.today().isoformat()
    lines = [f"Today is {today}.\n\nITEMS"]
    for n in nodes:
        label = {"session": "conversation", "memory": f"memory note ({n.get('mtype') or 'note'})", "job": "automated job"}[n["kind"]]
        lines.append(f"{n['id']} | {label} | {(n['date'] or '')[:10]} | {n['project']} | {n['title']}: {short(n['gist'], 420)}")
    data = summarise.ask_claude(SYSTEM, "\n".join(lines), model, timeout=900, kind="map", label="Mind map")

    ids = {n["id"] for n in nodes}
    seen = set()
    themes = []
    for t in data.get("themes", []):
        items = [i for i in t.get("items", []) if i in ids and i not in seen]
        seen.update(items)
        if items:
            themes.append(dict(id=t.get("id") or f"t{len(themes) + 1}", name=t.get("name", "Untitled"),
                               blurb=index.mask(t.get("blurb", "")), status=t.get("status", "simmering"), items=items))
    leftovers = [n["id"] for n in nodes if n["id"] not in seen]
    if leftovers:
        themes.append(dict(id="t_other", name="Everything else", blurb="Items that didn't fit a theme.", status="simmering", items=leftovers))
    theme_of = {i: t["id"] for t in themes for i in t["items"]}
    links = [dict(a=l["a"], b=l["b"], why=index.mask(l.get("why", ""))) for l in data.get("links", [])
             if l.get("a") in ids and l.get("b") in ids and l["a"] != l["b"]]
    similar = similarity_links(nodes)
    for n in nodes:
        n["theme"] = theme_of[n["id"]]
        n.pop("text", None)
    out = dict(built=datetime.datetime.utcnow().isoformat(timespec="seconds") + "Z", model=model,
               centre=index.mask(data.get("centre", "")), themes=themes, nodes=nodes, links=links, similar=similar)
    with open(MAP_PATH, "w") as fh:
        json.dump(out, fh, indent=1, default=str)
    return out


def is_stale():
    """True when the map is missing, or items were added, removed or re-summarised since it was built."""
    m = load()
    if not m:
        return True
    built = m["built"].rstrip("Z")
    current = collect()
    if {(n["kind"], n["ref"]) for n in current} != {(n["kind"], n["ref"]) for n in m["nodes"]}:
        return True
    if any(n["kind"] == "memory" and (n["date"] or "").rstrip("Z") > built for n in current):
        return True
    newer = index.connect().execute("select count(*) from summaries where created > ?", (built,)).fetchone()[0]
    return newer > 0


def load():
    if not os.path.exists(MAP_PATH):
        return None
    with open(MAP_PATH) as fh:
        return json.load(fh)


if __name__ == "__main__":
    index.run(verbose=False)
    print("Building the map (one Claude call, about a minute)…")
    m = build()
    print(f"{len(m['nodes'])} items in {len(m['themes'])} themes, {len(m['links'])} explained links, {len(m['similar'])} similarity links.")
    for t in m["themes"]:
        print(f"  {t['status']:9} {t['name']} ({len(t['items'])})")
