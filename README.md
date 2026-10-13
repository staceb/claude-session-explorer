# Second Brain (claude-session-explorer)

**A private, local dashboard for everything you've done with Claude Code: what you worked on, what ran,
what's installed, and how many tokens it all used.**

Claude Code keeps a transcript of every session in `~/.claude/projects/`. Second Brain reads them, plus
Claude Code's own config, and gives you:

- **Overview**: tokens this month, sessions open right now, agent runs, what loads before you type,
  tokens per week, and your heaviest sessions.
- **Map**: your conversations, memory notes and automated jobs, grouped into themes (*active*, *simmering*,
  *parked*) and linked by similarity, plus connections Claude noticed between themes.
- **Sessions**: conversations and automated runs past and present, the sessions **open right now**
  (with memory use and whether they're working), and your **heaviest requests** ranked by tokens. Each
  session has a summary card, its token breakdown, and the full readable transcript.
- **Agents**: every agent that has run, which session launched it, how many tokens it used, and
  **who decided to launch it** (you, Claude on its own, another agent, or a script). Includes the agents
  you've defined and which are running now.
- **Installed**: skills, connectors and MCP servers, plugins, scheduled jobs, memory and instructions,
  each with its token load and how often it's been used. You can **archive** any of them and
  **restore** it later.
- **Memory**: everything Claude remembers, each note linked to the session that wrote it.
- **Search** across everything you and Claude said.

Token counts only, no prices: what matters is what you use, not a bill.

## Private by design

- Everything runs on your computer. The viewer only listens on `127.0.0.1`, so nothing else on your network
  can reach it, and nothing is uploaded anywhere.
- Summaries and the map use **your own Claude Code** (`claude -p`), on the plan you're already logged in
  with. No API keys, no extra accounts, no third-party model. Claude has already seen these conversations,
  so nothing new is shared.
- Those summary runs are not saved as new transcripts (`--no-session-persistence`) and have no tools.
- Anything that looks like an API key or token is masked in the viewer and in summaries.
- Your data (`sessions.db`, `map.json`) stays in the app folder and is git-ignored.
- The server refuses requests from other websites (it checks Host and Origin), so a page you visit
  can't read your transcripts or trigger an action.
- **Archive never deletes.** Items move to `~/claude-archive/` with a manifest, and Restore puts each one
  back exactly where it was. MCP servers are saved, then removed with `claude mcp remove`, and
  restored with `claude mcp add-json`.

## Requirements

- **Python 3.9+**. It uses only the standard library, so there's nothing to `pip install`.
- **Claude Code**, installed and logged in, for summaries and the map. The viewer, search and memory tabs
  work without it.

## Install and run

```bash
git clone https://github.com/staceb/claude-session-explorer.git
cd claude-session-explorer
python3 server.py
```

Your browser opens at http://127.0.0.1:8765. The first start indexes your history, which takes about
20 seconds for a few hundred sessions. On macOS you can double-click `Session Explorer.command` instead.

Then press **↻ Update** in the sidebar. It:

1. reads any new or changed sessions,
2. summarises conversations that are new or have grown since their last summary (skipping any touched in
   the last 10 minutes, since those are probably still open), and
3. rebuilds the map, but only if something changed.

The first Update summarises your whole back catalogue, at about 20 seconds to a couple of minutes per
conversation. After that it only does what's new.

### What it costs

Each summary is one `claude -p` call with Sonnet, and the map is one more call. They count towards your
Claude plan's usage like any other Claude Code session. Automated runs aren't summarised unless you ask
(`python3 summarise.py --kind auto`).

## Command line

```bash
python3 index.py                  # index new/changed transcripts
python3 summarise.py              # summarise every conversation that needs it
python3 summarise.py --limit 3    # just a few, to try it
python3 summarise.py --session <id>
python3 map.py                    # rebuild the map
PORT=9000 python3 server.py       # another port; add --no-open to skip opening the browser
```

## Keep your history

By default **Claude Code deletes transcripts older than 30 days**. Session Explorer keeps its own copy of every
session it has indexed, but only of sessions it read before they were deleted. To keep everything, add this
to `~/.claude/settings.json`:

```json
"cleanupPeriodDays": 3650
```

## How it works

| File | Does |
|---|---|
| `index.py` | Reads `~/.claude/projects/**/*.jsonl` into `sessions.db` (SQLite, with full-text search). Incremental: only changed files are re-read. |
| `summarise.py` | Condenses a session (your words in full, Claude's shortened, tools as one-liners) and asks Claude for a JSON summary. |
| `map.py` | Collects conversations, memory notes and automated jobs. One Claude call groups them into themes and finds connections; a local TF-IDF score adds similarity links. Writes `map.json`. |
| `dashboard.py` | Overview, usage over time, open sessions (via `~/.claude/sessions/<pid>.json`), agents and who launched them, everything installed. |
| `manage.py` | Archive and restore. |
| `server.py` | Small local web server and JSON API. |
| `static/` | The interface: plain HTML, CSS and JS with no dependencies and no external requests. |

**Conversations vs automated:** each transcript records how it was started. Sessions launched from the terminal
(`entrypoint: cli`) are conversations; `claude -p` and SDK runs (`sdk-cli`) are automated, grouped by the opening
line of their prompt. Subagent transcripts appear inside the session that launched them.

To start again from scratch, delete `sessions.db` and `map.json`. Note that this also loses summaries and
copies of any sessions Claude Code has since deleted.

## Limitations

- Claude Code's transcript format isn't a public, stable API, so a future version could break the indexer.
  Please open an issue if it does.
- The map's grouping comes from a single Claude pass, so rebuilding may name or split the themes a little
  differently.
- Tested on macOS. Linux should work; Windows is untested.

Not affiliated with Anthropic.

## Licence

MIT
