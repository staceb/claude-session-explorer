"""Archive and restore what's installed. Nothing is deleted: items move to ~/claude-archive/ and a manifest
records where each came from, so Restore puts it back exactly.

  skill  a skill folder           → moved
  agent  an agent .md file        → moved
  job    a launchd plist          → unloaded, then moved
  mcp    an MCP server            → config saved, then `claude mcp remove`; restored with `claude mcp add-json`
"""
import datetime
import json
import os
import shutil
import subprocess
import uuid

HOME = os.path.expanduser("~")
ARCHIVE = os.path.join(HOME, "claude-archive")
MANIFEST = os.path.join(ARCHIVE, "manifest.json")

# only these places can be archived from: nothing outside them can be moved by a request
ALLOWED = {
    "skill": [os.path.join(HOME, ".claude", "skills"), os.path.join(HOME, ".agents", "skills"), "/.claude/skills/"],
    "agent": [os.path.join(HOME, ".claude", "agents"), "/.claude/agents/"],
    "job": [os.path.join(HOME, "Library", "LaunchAgents")],
}


def load():
    try:
        return json.load(open(MANIFEST))
    except (OSError, ValueError):
        return []


def save(items):
    os.makedirs(ARCHIVE, exist_ok=True)
    tmp = MANIFEST + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(items, fh, indent=1)
    os.replace(tmp, MANIFEST)


def allowed(kind, path):
    real = os.path.realpath(path)
    if not real.startswith(HOME + os.sep) or not os.path.exists(real):
        return False
    if kind == "skill" and (os.sep + "synced" + os.sep) in real:
        return False  # synced from claude.ai: managed there
    return any((real.startswith(os.path.realpath(r) + os.sep) if r.startswith(HOME) else r in real) for r in ALLOWED.get(kind, []))


def archive(kind, path=None, name=None, description="", mcp_scope="user", project=None):
    items = load()
    entry = dict(id=uuid.uuid4().hex[:12], kind=kind, name=name, description=description,
                 at=datetime.datetime.now().isoformat(timespec="seconds"))
    if kind == "mcp":
        cfg = mcp_config(name, mcp_scope, project)
        if cfg is None:
            raise ValueError(f"no MCP server called {name}")
        run(["claude", "mcp", "remove", name, "-s", mcp_scope], cwd=project)
        entry.update(original=f"mcp:{mcp_scope}:{name}", config=cfg, scope=mcp_scope, project=project)
    else:
        path = os.path.expanduser(path)
        if not allowed(kind, path):
            raise ValueError("that path can't be archived from here")
        if kind == "job":
            run(["launchctl", "unload", path], check=False)
        dest = os.path.join(ARCHIVE, kind + "s", entry["id"] + "-" + os.path.basename(path.rstrip("/")))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.move(path, dest)
        entry.update(original=path, archived_path=dest, name=name or os.path.basename(path.rstrip("/")))
    items.append(entry)
    save(items)
    return entry


def restore(archive_id):
    items = load()
    entry = next((a for a in items if a["id"] == archive_id), None)
    if not entry:
        raise ValueError("not in the archive")
    if entry["kind"] == "mcp":
        run(["claude", "mcp", "add-json", entry["name"], json.dumps(entry["config"]), "-s", entry["scope"]], cwd=entry.get("project"))
    else:
        if os.path.exists(entry["original"]):
            raise ValueError("something already exists where it came from")
        os.makedirs(os.path.dirname(entry["original"]), exist_ok=True)
        shutil.move(entry["archived_path"], entry["original"])
        if entry["kind"] == "job":
            run(["launchctl", "load", entry["original"]], check=False)
    save([a for a in items if a["id"] != archive_id])
    return entry


def mcp_config(name, scope, project):
    try:
        cj = json.load(open(os.path.join(HOME, ".claude.json")))
    except (OSError, ValueError):
        return None
    if scope == "user":
        servers = cj.get("mcpServers") or {}
    else:
        servers = ((cj.get("projects") or {}).get(project) or {}).get("mcpServers") or {}
    return servers.get(name)


def run(cmd, cwd=None, check=True):
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=60, cwd=cwd or HOME)
    if check and p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout).strip()[:300] or f"{cmd[0]} failed")
    return p
