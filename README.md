# Session Explorer

**A private, local map of everything you've done with Claude Code.**

Claude Code keeps a full transcript of every session in `~/.claude/projects/`, but there's no good way to look
back through them. Session Explorer reads those transcripts and gives you:

- **Map**: your conversations, Claude's memory notes and your automated jobs, grouped into themes
  (*active*, *simmering*, *parked*) and linked by similarity. It also shows the connections Claude noticed
  between themes, each with a reason.
- **Conversations**: every session you started yourself, each with a summary card (what it was about,
  decisions, things learned about you, open threads, what was made) above the full, readable transcript.
- **Automated**: `claude -p` runs from scripts and pipelines, grouped by job, kept separate from your real
  conversations.
- **Memory**: the memory files Claude Code keeps, each linked to the session that wrote it.
- **Search**: full-text search across everything you and Claude said, jumping straight to the message.

## Private by design

- Everything runs on your computer. The viewer only listens on `127.0.0.1`, so nothing else on your network
  can reach it, and nothing is uploaded anywhere.
- Summaries and the map use **your own Claude Code** (`claude -p`), on the plan you're already logged in
  with. No API keys, no extra accounts, no third-party model. Claude has already seen these conversations,
  so nothing new is shared.
- Those summary runs are not saved as new transcripts (`--no-session-persistence`) and have no tools.
- Anything that looks like an API key or token is masked in the viewer and in summaries.
- Your data (`sessions.db`, `map.json`) stays in the app folder and is git-ignored.

## Requirements

- **Python 3.9+**. It uses only the standard library, so there's nothing to `pip install`.
- **Claude Code**, installed and logged in, for summaries and the map. The viewer, search and memory tabs
  work without it.

## Install and run

```bash
git clone https://github.com/<you>/session-explorer.git
cd session-explorer
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
| `server.py` | Small local web server and JSON API. |
| `static/index.html` | The whole interface: plain HTML/CSS/JS with no dependencies, light and dark mode. |

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
