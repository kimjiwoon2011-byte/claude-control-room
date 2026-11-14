# Claude Control Room

Run up to 8 Claude Code agents side by side from one window, with a read-only supervisor that reviews their work, optional GPT (Codex) agents, and a fallback AI for when you hit your Claude usage limit.

> **Unofficial hobby project.** It is not made by, affiliated with, or endorsed by Anthropic or OpenAI. It drives the official `claude` (and optionally `codex`) command-line tools that you install and log in to yourself.

[한국어 설명은 여기 (Korean)](README.ko.md)

## What it does

- **1–8 agents at once.** Each agent is its own Claude Code process. Send a task to the least busy agent, to all of them, or to the ones you pick, and watch them read and edit files live.
- **You approve risky actions.** Commands and other tool calls that need permission show up as approval cards: Allow, Always allow, or Deny. A "skip all permissions" mode is deliberately not offered.
- **Supervisor.** A separate, read-only agent reviews finished tasks that edited files or ran commands, posts a short report, and sends fixes back to the worker (up to 1–3 rounds).
- **GPT agents (optional).** Pick a GPT model and that agent runs on the official OpenAI Codex CLI with your ChatGPT login. It can't ask for approval, so it runs in Codex's sandbox and can only write inside its work folder.
- **Fallback AI (optional).** When Claude hits its usage limit, agents continue on other AIs (OpenRouter, Kimi, Codex, …) through [claude-code-router](https://github.com/musistudio/claude-code-router).
- **Hand over (⇄).** Move an agent's current or failed task to another AI. The new AI first gets a handoff note (last task, last message, edited files) so it continues instead of starting over.
- **Korean / English UI**, picked on first run and changeable in Settings.

## Requirements

- **Windows 10/11** is the main target. On macOS/Linux the server runs with `node server.js`, but the folder picker only works on Windows (type the path instead), and you run `claude auth login` and claude-code-router yourself in a terminal.
- **Node.js 22.5 or newer** recommended. The core runs on Node 18+, but the "Import from CCR" button needs 22.5+. There are no dependencies, so there's nothing to `npm install`.
- **Claude Code** (`claude`) installed and logged in with your own account. Agents use your Claude plan's usage, so running more agents uses it up faster.
- Optional: **OpenAI Codex** (the Codex app, or `npm install -g @openai/codex`) logged in with `codex login`, for GPT agents.
- Optional: **claude-code-router** (`npm install -g @musistudio/claude-code-router`) for the fallback AI. Add providers in its own UI, but **don't apply its "Connect agent" step** — that rewires every Claude Code on your PC through the router.

## Quick start

1. Download or clone this folder.
2. On Windows, double-click **`실행.bat`** ("run"). On other systems, run `node server.js`.
3. The control room opens at `http://127.0.0.1:7707`. On first run, pick the language, the **work folder** (where agents create files) and the **data folder** (settings and history).
4. If Claude Code isn't logged in yet, press **Open login window** in Settings (Windows) or run `claude auth login`.

Closing the server window quits the app.

## Where things are saved

| What | Where |
|---|---|
| Files the agents create | The work folder (default `workspace/`; change it in Settings → Storage or per agent) |
| Settings, history, supervisor reports | The data folder (default `data/`: `state.json`, `logs.json`) |
| Location of a custom data folder | `config.json` in the app folder |
| English translations | `locales/en.json` |

The data folder can contain the claude-code-router key in plain text, so keep it private. `data/`, `config.json` and the work folders are listed in `.gitignore`.

## Command-line options

```
node server.js [--port 7707] [--no-open] [--data <folder>] [--claude <path>] [--codex <path>]
```

- `--port` — port to listen on (default 7707)
- `--no-open` — don't open a window
- `--data` — use this data folder (it can't be changed from the app while this is set)
- `--claude`, `--codex` — use a specific CLI (also handy for testing with a fake CLI)

## Security

- The server only listens on `127.0.0.1`, and every API call needs a random per-start token and a local `Host` header, so other websites can't drive your agents.
- Approvals stay with you, and the supervisor can only read files.
- GPT agents run in Codex's sandbox: read-only for the "Plan only" and "Ask every time" permissions, otherwise write access inside the work folder only.

## Costs

The app itself is free and has no backend. Agents use your own Claude plan's usage, GPT agents use your ChatGPT plan's Codex usage, and the fallback AI uses whatever providers you set up in claude-code-router. **Fast mode (↯)** is billed from paid usage credits, so it's off by default and asks before it turns on.

## Files

- `server.js` — the Node server (no dependencies). Runs one CLI process per agent and talks to the page over Server-Sent Events.
- `index.html` — the whole UI.
- `locales/en.json` — English translations. The Korean sentence in the code is the key.
- `실행.bat` / `로그인.bat` — Windows launchers ("run" / "log in").
- `icon.ico` — app icon.

## Translations

All user-facing text goes through `t('한국어 문장', { vars })`: the Korean sentence is the key and `locales/en.json` maps it to English, with `{name}`-style placeholders. Restart the server after editing the dictionary. Adding a third language currently needs small code changes (`LANGS` and `DICTS` in `server.js`, `LANG` in `index.html`, and the language selects).

## Known limitations

- Windows first; macOS/Linux are less tested.
- It relies on Claude Code's stream-json and permission-prompt protocol, so a CLI update can break it.
- Code comments are written in Korean.
- Tested with Node.js 24, Claude Code 2.1, and Codex CLI 0.166.

## License

[MIT](LICENSE) — free to use, copy, modify and share, as long as the license notice stays with the code. It comes with no warranty.
