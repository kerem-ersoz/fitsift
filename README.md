# fit2json

Pull your workouts from Garmin Connect or Strava, store them as **faithful, lossless JSON**, and **analyze them with an LLM** — GitHub Copilot CLI or a local model (Ollama / LM Studio) — using your own prompt. Every analysis is saved to a **training-memory corpus** so the model can revisit past workouts and reason about your progress over time.

> **Architecture & diagrams:** see [ARCHITECTURE.md](ARCHITECTURE.md) for how the poller, auto-analyzer, and web UI fit together as a local pipeline.

## What It Does

**fit2json** is a command-line harness with three stages:

1. **Fetch / convert** — decode `.fit` files (Garmin, Wahoo, etc.) losslessly, or pull recent activities straight from Garmin Connect / Strava.
2. **Store** — write a **complete, human-readable** JSON dump: every FIT message and every field, at native resolution. Nothing is downsampled or dropped.
3. **Analyze** — send a workout (plus your custom prompt) to the **GitHub Copilot CLI** or a **local LLM**, and keep the result in a searchable memory corpus for trend analysis.

> **What changed in 0.2:** older versions produced a compact, lossy "LLM-ready" JSON and called the OpenAI/GitHub Models API directly. Capable models no longer need pre-digested data, so fit2json now keeps a **lossless** archive and **orchestrates** analysis through Copilot / local models instead. See [Migrating from 0.1](#migrating-from-01).

---

## Installation

### Option 1: Docker (no Python required)

```bash
docker pull ghcr.io/kerem-ersoz/fit2json:latest
docker run --rm ghcr.io/kerem-ersoz/fit2json --version
```

> The Docker image covers `convert`, `fetch`, and serving the **FitSift web UI**
> (backend + frontend). The `analyze` command's `copilot` backend needs the Copilot CLI
> on the host, so run analysis outside the container (or point `--base-url` at a reachable
> local LLM). See [Docker usage](#docker-usage) and
> [FitSift web UI in a container](#fitsift-web-ui-in-a-container-pull-and-run).

### Option 2: Install from source

Requires **Python 3.9+**.

```bash
git clone https://github.com/kerem-ersoz/fitsift.git
cd fit2json
python3 -m venv .venv
source .venv/bin/activate
pip install -e .            # add ".[dev]" for tests
fit2json --version
```

### For the `analyze` command

Pick whichever backend you like — no API key required for any of these:

- **GitHub Copilot CLI** — install the [`copilot` CLI](https://github.com/github/copilot-cli) and sign in. Auto-detected if on your `PATH`.
- **Ollama** — [ollama.com](https://ollama.com), then `ollama pull llama3.1`.
- **LM Studio** — [lmstudio.ai](https://lmstudio.ai); start its local server and load a model.

---

## Quick Start

```bash
# Convert a single .fit file to lossless JSON (stdout)
fit2json convert my_run.fit -o run.json

# Convert a folder of .fit files → one JSON file per activity, into ./workouts/
fit2json convert ~/Downloads/garmin-export/ -o workouts/

# Pull the last 7 days from Garmin → ./workouts/
fit2json fetch garmin --days 7 -o workouts/

# Analyze one workout with your prompt (auto-detects Copilot CLI, else Ollama)
fit2json analyze run.json -p "How was my pacing strategy?"

# Analyze against a local model and build up training memory over time
fit2json analyze workouts/ -p "How is my fitness trending?" --backend ollama
```

---

## Continuous export (watch mode)

Export your workouts **automatically, shortly after they sync to Garmin Connect** — no
manual `fetch`, and no OS-specific scheduler. `fit2json fetch garmin --watch` runs a small
polling loop built into the CLI (default **every 15 minutes**) that downloads only new
activities and writes them to a local library. The same command works on macOS, Linux,
Windows, and inside a container.

> **Near-real-time, not instant.** The unofficial Garmin integration has no push/webhook,
> so this is **poll-based** (~15 min latency by default; tune with `--interval`).

### How it works

- **Built-in, cross-platform scheduler:** the loop lives in the CLI itself
  (`src/fit2json/watch.py`) — no cron, launchd, or Task Scheduler required.
- **Headless & non-blocking:** in `--watch` mode it never prompts (e.g. for MFA) and
  streams progress as it runs, so a parent process (a service supervisor or a GUI
  frontend) can spawn it in the background without being blocked.
- **Clean shutdown:** it stops promptly on `Ctrl-C` / `SIGTERM`, so `docker stop`,
  `systemctl stop`, or a frontend "stop" button shut it down gracefully — even mid-interval.
- **Resilient:** a failing cycle (network blip, expired token, daemon asleep) is logged and
  the loop keeps polling — one bad poll never tears down the daemon.
- **Session reuse:** every poll resumes the cached Garmin session instead of logging in
  fresh (which would quickly trigger Garmin CAPTCHA / rate limiting).
- **Incremental:** raw `.fit` files are a permanent archive; any activity already downloaded
  is skipped, so each poll only fetches what's new.

### 1. One-time login (seed the session; handles 2FA/MFA)

`--watch` is non-interactive and never prompts, so log in **once** interactively first to
cache your Garmin session tokens:

```bash
export GARMIN_EMAIL=you@example.com GARMIN_PASSWORD=yourpassword
fit2json fetch garmin --days 1 --raw-dir ~/.fit2json/fit -o ~/.fit2json/json
```

Enter the MFA code if prompted. Tokens are cached in the token dir (default
`~/.garminconnect`, or set `GARMINTOKENS` / `--token-dir`) so later `--watch` runs resume
the session without prompting.

### 2. Run it

```bash
fit2json fetch garmin --watch --interval 900 \
  --raw-dir ~/.fit2json/fit -o ~/.fit2json/json
```

Stop with `Ctrl-C` (or send `SIGTERM`). Useful flags: `--interval SECONDS` (default 900)
and `--max-runs N` (stop after N cycles — handy for testing). `fetch strava` accepts the
same `--watch` flags.

### Running it in the background

`--watch` is just a long-lived process that exits cleanly on `SIGTERM`, so any supervisor
works. A few examples:

**Docker** (survives reboots; `docker stop` shuts it down cleanly):

```bash
docker run -d --name fit2json-garmin --restart unless-stopped \
  --env-file ~/.fit2json.env \
  -e GARMINTOKENS=/tokens \
  -v ~/.fit2json/garmintokens:/tokens \
  -v ~/.fit2json/library:/data \
  ghcr.io/kerem-ersoz/fit2json:latest \
  fetch garmin --watch --interval 900 --raw-dir /data/fit -o /data/json
```

Seed the token cache once with the **same volumes** but interactively and without `--watch`:

```bash
docker run -it --rm \
  --env-file ~/.fit2json.env -e GARMINTOKENS=/tokens \
  -v ~/.fit2json/garmintokens:/tokens -v ~/.fit2json/library:/data \
  ghcr.io/kerem-ersoz/fit2json:latest \
  fetch garmin --days 1 --raw-dir /data/fit -o /data/json
```

**Linux — systemd user service** (`~/.config/systemd/user/fit2json.service`):

```ini
[Unit]
Description=fit2json Garmin auto-export
After=network-online.target

[Service]
Environment=GARMINTOKENS=%h/.fit2json/garmintokens
EnvironmentFile=%h/.fit2json.env
ExecStart=%h/.local/bin/fit2json fetch garmin --watch --interval 900 --raw-dir %h/.fit2json/fit -o %h/.fit2json/json
Restart=always

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now fit2json
```

**macOS / Windows:** run it in a terminal, or supervise the same command with launchd
(`KeepAlive`), `nssm`, or Windows Task Scheduler ("at log on", restart on failure).

### Where files land

You choose the layout via `--raw-dir` / `-o` (and volume mounts in Docker):

```
~/.fit2json/
├── fit/                # raw .fit archive (permanent)   → --raw-dir
└── json/               # one JSON per activity          → -o
<GARMINTOKENS dir>      # cached Garmin session (default ~/.garminconnect)
~/.fit2json.env         # Garmin credentials for the one-time seed / Docker --env-file
```

---

## Commands

### `fit2json convert`

Decode local `.fit` file(s) into lossless JSON.

```bash
fit2json convert activity.fit                     # → stdout
fit2json convert activity.fit -o out.json         # → single combined file
fit2json convert ./export/ -o workouts/           # → one file per activity
fit2json convert ./export/ -o workouts/ --gzip    # → .json.gz (≈25× smaller)
```

| Option | Description |
|--------|-------------|
| `-o, --output PATH` | A `.json`/`.json.gz` file (combined) or a **directory** (one file per activity). Default: stdout. |
| `--gzip` | Gzip the output. Recommended for archives — a long activity compresses to less than the original `.fit`. |
| `--indent INT` | JSON indentation (default: 2). |
| `--compact` | No indentation — smallest plain-text files. |

### `fit2json fetch garmin`

Download and decode recent Garmin Connect activities.

```bash
fit2json fetch garmin --days 30 -o workouts/
fit2json fetch garmin --days 7 --raw-dir ./raw-fits/ -o workouts/
```

| Option | Description |
|--------|-------------|
| `--days INT` | Days of history to fetch (default: 30). |
| `-o, --output PATH` | Output directory (default: `./workouts/`, one file per activity) or a `.json` file. |
| `--gzip` | Gzip the output. |
| `--email` / `--password` | Garmin credentials (or `GARMIN_EMAIL` / `GARMIN_PASSWORD`). |
| `--raw-dir PATH` | Keep the raw `.fit` files too (persistent archive — already-downloaded activities are skipped). |
| `--token-dir PATH` | Garmin session token-cache dir (or set `GARMINTOKENS`; default `~/.garminconnect`). Reuses a saved session instead of logging in fresh each run. |
| `--watch` | Poll continuously with a built-in cross-platform scheduler (no cron/launchd). Stops cleanly on `Ctrl-C` / `SIGTERM`. |
| `--interval SECONDS` | Seconds between polls in `--watch` mode (default: 900 = 15 min). |
| `--max-runs N` | In `--watch` mode, stop after N cycles (default: run until stopped). |

> **Session reuse & incremental fetch:** the first run logs in and caches the session tokens
> in the token dir; later runs resume from that cache (no fresh login, which avoids Garmin
> CAPTCHA / rate limiting). With a persistent `--raw-dir`, any activity whose `.fit` already
> exists is skipped, and `-o <dir>` writes one JSON per new activity — so frequent polling
> stays cheap. See [Continuous export (watch mode)](#continuous-export-watch-mode).

### `fit2json fetch strava`

Download and decode recent Strava activities.

> **Lower fidelity:** Strava's API returns processed time-series *streams*, not raw `.fit` files, so this path **cannot be truly lossless**. For full fidelity, use Strava's [bulk export](https://support.strava.com/hc/en-us/articles/216918437) and `fit2json convert` on the `.fit` files.

```bash
fit2json fetch strava --days 30 -o workouts/
```

Options mirror `fetch garmin`, with `--client-id` / `--client-secret` / `--refresh-token` (or the matching `STRAVA_*` env vars).

### `fit2json analyze`

Send a workout (and your prompt) to an LLM backend, using and updating training memory.

```bash
# Auto-detect backend (Copilot CLI if installed, else Ollama)
fit2json analyze run.json -p "Write a race report"

# Explicit backends
fit2json analyze run.json -p "Analyze my HR zones" --backend ollama --model llama3.1
fit2json analyze run.json -p "Any red flags?"       --backend lmstudio
fit2json analyze run.json -p "Coach me"             --backend copilot

# Copilot: pick a specific model and crank up reasoning for a deeper breakdown
fit2json analyze run.json -p "Coach me" --backend copilot --model claude-opus-4.8 --reasoning-effort max

# Any OpenAI-compatible endpoint
fit2json analyze run.json -p "Summarize" --base-url http://my-server:8080/v1

# A whole directory of workouts, or piped from convert
fit2json analyze workouts/ -p "Summarize my training week"
fit2json convert run.fit | fit2json analyze -p "Race report"
```

| Option | Description |
|--------|-------------|
| `SOURCE` | Workout JSON file or directory. Omit to read JSON from stdin. |
| `-p, --prompt TEXT` | **(Required)** Your analysis question. |
| `--backend` | `copilot`, `ollama`, or `lmstudio`. Auto-detected if omitted. |
| `--base-url TEXT` | Any OpenAI-compatible endpoint (overrides `--backend`). |
| `--model TEXT` | Model name (backend-specific). For `copilot`, omit to use the Copilot CLI's configured default model; pass e.g. `claude-opus-4.8` to force one. Local backends auto-pick if omitted. |
| `--reasoning-effort {none,minimal,low,medium,high,xhigh,max}` | Copilot backend only: how hard the model reasons. Needs an explicit `--model` (the `auto` router rejects it). |
| `--api-key TEXT` | Only for a custom `--base-url` that requires auth. |
| `--no-stream` | Disable streaming output. |
| `--max-chars INT` | Max workout JSON chars inlined for local models (default: 200K). Large activities are auto-thinned to fit. |
| `--memory PATH` | Memory corpus location (default: `./fit2json-memory/`). |
| `--no-memory` | Don't read or write memory for this run. |
| `--recall {auto,same-sport,all,none}` | Which past analyses to recall as context (default: `auto`). |
| `--recall-days INT` | Only recall memories within N days. |
| `--recall-limit INT` | Max memories to recall (default: 8). |
| `--profile PATH` | Athlete-profile JSON to personalize the analysis (default: `~/.fit2json/profile.json`). |
| `--no-profile` | Ignore the saved athlete profile for this run. |
| `--watch` | Watch a **directory** and analyze each *new* workout individually as it appears (built-in scheduler), skipping any already in memory. |
| `--interval SECONDS` | Seconds between polls in `--watch` mode (default: 900). |
| `--max-runs N` | In `--watch` mode, stop after N cycles (default: run until stopped). |

**How backends handle data:**

- **`copilot`** — the workout file(s) and the memory directory are passed **by path**; Copilot reads them with its own file tools, so even huge lossless files fit fine.
- **`ollama` / `lmstudio` / `--base-url`** — the workout JSON is inlined and automatically **thinned** to fit `--max-chars`; recalled memories are added as a compact digest.

**Personalization (the "You" profile):** if an athlete profile exists (height, weight, resting/max HR, LTHR, FTP, VO₂max, goals, …), a compact summary is injected into every analysis so the model can reason about your HR/power zones, calories, effort, and pacing. Edit it on the **You** tab of the web UI (`fit2json serve`), or point `--profile` at any profile JSON. Use `--no-profile` to opt out.

**Auto-analyze new workouts (watch mode):** point `analyze --watch` at your library
directory and it polls on the same built-in scheduler as `fetch --watch`, analyzing every
*new* workout on its own and saving it to the memory corpus — so an analysis is ready
shortly after a workout syncs. Already-analyzed workouts (matched by activity id in
`index.jsonl`) are skipped, so re-runs are cheap.

```bash
# Pair with `fetch garmin --watch`: as new workouts land, analyze each and save to memory.
fit2json analyze ~/.fit2json/library/json -p "Coach me on this workout." \
  --backend copilot --memory ~/.fit2json/memory --watch --interval 900
```

`--watch` needs a **directory** SOURCE and the memory corpus (not `--no-memory`). It runs
on the host (the `copilot` backend needs the Copilot CLI) and stops cleanly on
Ctrl-C / SIGTERM — supervise it with launchd/systemd just like the poller.

### `fit2json memory`

Inspect the training-memory corpus.

```bash
fit2json memory path                       # print the corpus location
fit2json memory list                       # list all analyses, newest first
fit2json memory list --sport running --days 30
fit2json memory show <entry_id>            # print one saved analysis
```

---

## Training memory

Every `analyze` run saves its result to a filesystem corpus (default `./fit2json-memory/`):

```
fit2json-memory/
├── running/
│   └── 2024-03-10T0730-00Z_2024-03-10_run_3195e283.md
├── cycling/
│   └── 2024-03-12T1800-00Z_2024-03-12_ride_982710f5.md
└── index.jsonl
```

- Each analysis is a Markdown file with a front-matter block (date, sport, key metrics, prompt, model) followed by the AI's write-up — readable on its own or by any LLM.
- `index.jsonl` is a one-line-per-analysis index for fast filtering by sport and date.
- Files are partitioned by sport and date-prefixed, so you can revisit **memories from different activity types and time ranges**.
- On each run, fit2json **recalls** the relevant past analyses (see `--recall*`) and feeds them back as context so the model can comment on progress and trends. With the `copilot` backend, Copilot browses the corpus directly with its file tools.

---

## Lossless JSON schema

The output is a faithful decode of the `.fit` file — every message type, every field, at native resolution:

```json
{
  "metadata": { "generated_at": "…", "tool_version": "0.2.0", "source": "local", "schema": "lossless-fit" },
  "activities": [
    {
      "source_file": "2024-03-10_run.fit",
      "sport": "running",
      "start_time": "2024-03-10T07:30:00+00:00",
      "message_counts": { "record": 2809, "lap": 4, "session": 1, "event": 7 },
      "field_units": { "distance": "m", "speed": "m/s", "heart_rate": "bpm" },
      "messages": {
        "session": [ { "sport": "running", "total_distance": 10234.0, "avg_heart_rate": 152, "…": "…" } ],
        "lap": [ { "total_distance": 1001.0, "avg_heart_rate": 145, "…": "…" } ],
        "record": [
          { "timestamp": "2024-03-10T07:30:00+00:00", "heart_rate": 120, "cadence": 84, "speed": 2.9, "distance": 0.02 }
        ]
      }
    }
  ]
}
```

- **Messages** are grouped by FIT message name; order is preserved within each group and every record keeps its `timestamp`.
- **Units** for each field are listed once in `field_units` to keep records readable.
- **Developer / unknown fields** are preserved (named where the file defines them, otherwise `unknown_<n>`).
- Values are decoded to human units (datetimes → ISO 8601, byte blobs → hex).

**File size:** a lossless dump is ~10× larger than the binary `.fit` (e.g. a 1 h ride ≈ 4 MB). Per-activity output keeps each file bounded, and `--gzip` shrinks it below the original `.fit`. For context-limited local models, `analyze` thins the data automatically.

---

## Docker usage

The container's working directory is `/data`. Mount your files in.

```bash
# Convert local .fit files
docker run --rm -v "$(pwd)":/data ghcr.io/kerem-ersoz/fit2json convert /data/my_run.fit -o /data/workouts/

# Fetch from Garmin
docker run --rm \
  -e GARMIN_EMAIL=you@email.com -e GARMIN_PASSWORD=yourpassword \
  -v "$(pwd)":/data \
  ghcr.io/kerem-ersoz/fit2json fetch garmin --days 7 -o /data/workouts/

# Analyze against a local LLM running on the host (Ollama / LM Studio)
docker run --rm --network host -v "$(pwd)":/data \
  ghcr.io/kerem-ersoz/fit2json analyze /data/workouts/ --backend ollama -p "Weekly summary"
```

> The `copilot` backend isn't available inside the image — run `fit2json analyze … --backend copilot` from a host install instead.

---

## FitSift web UI in a container (pull-and-run)

Run the **backend + frontend together** from the published image, reading your local
`~/.fit2json` data — no Python/Node toolchain needed. The image bundles the FastAPI API
and the built React SPA and defaults to `serve` on port 8000. A helper script,
`scripts/fitsift`, wraps `docker compose` so fetching the latest image and running it is
one command.

> **How it all fits together (with diagrams):** [ARCHITECTURE.md](ARCHITECTURE.md).

### Prerequisites

- Docker + Docker Compose v2.
- Your data in `~/.fit2json` (the default layout): `library/json/` (workouts),
  `memory/` (analyses), `profile.json`. The container mounts `~/.fit2json` at `/data`.
- If the GHCR package is private, log in once so images can be pulled:
  ```bash
  echo "$(gh auth token)" | docker login ghcr.io -u kerem-ersoz --password-stdin
  ```

### Start it

```bash
# First run (builds the image from source — use until the web-capable image is on GHCR,
# or whenever you want to run local changes):
./scripts/fitsift up --build

# Steady state — fetch the latest published image and (re)start:
./scripts/fitsift update

# → open http://localhost:8000
```

That's the automated pipeline: `update` pulls `ghcr.io/kerem-ersoz/fit2json:latest` and
recreates the container. Schedule it (cron/launchd) or use the built-in Watchtower
service (below) to keep the running UI on the latest image automatically.

### Start the whole pipeline in one shot

`up`/`update` run only the web UI. To bring up **everything** — the web UI, the Garmin
poller, and the auto-analyzer — in one command:

```bash
./scripts/fitsift all     # UI + poller (containers) + analyzer (host)
./scripts/fitsift stop    # stop all three
./scripts/fitsift status  # show every component
```

Because analysis needs the Copilot CLI (which can't run in the container), the poller and
UI run as **containers** while the analyzer runs as a **host** process (backgrounded, with
a PID + log under `~/.fit2json`). Prerequisites for the full pipeline:

- **Poller:** a seeded Garmin token cache (`~/.fit2json/garmintokens`) — do the one-time
  login once (see [watch mode](#continuous-export-watch-mode)); add `GARMIN_EMAIL` /
  `GARMIN_PASSWORD` to `.env` for token refresh.
- **Analyzer:** the Copilot CLI on the host (or set `ANALYZE_BACKEND=ollama` + a running
  server), and a host `fit2json` (this repo's `.venv`, a global install, or `FIT2JSON_BIN`).

Tune the analyzer via env / `.env`: `ANALYZE_BACKEND`, `ANALYZE_MODEL`, `ANALYZE_EFFORT`,
`ANALYZE_INTERVAL`, `ANALYZE_PROMPT`. On first start it backfills every workout not already
in the memory corpus.

### Local testing with Copilot (host mode)

The container's web UI can't offer the **Copilot** backend, because the Copilot CLI is a
host tool that can't run inside the Linux image (wrong OS/arch, and it needs an
authenticated sign-in). For local testing where you want Copilot live in the Analyze
picker, run everything as host processes instead:

```bash
./scripts/fitsift local     # web UI + Garmin poller + auto-analyzer, all on the host
./scripts/fitsift status    # web / poller / analyzer + containers
./scripts/fitsift stop      # stop everything
```

`local` is idempotent (per-service PID files + logs under `~/.fit2json`), serves the built
SPA via `fit2json serve` where Copilot is on `PATH`, and starts the poller and
auto-analyzer alongside it. It won't collide with the container stack: starting one stops
the other's web service on port 8000. Tune it with `FITSIFT_PORT`, `POLL_INTERVAL`, and the
`ANALYZE_*` knobs. The Garmin poller needs a valid token cache for this build; seed it once
with `fit2json fetch garmin --days 1 --token-dir ~/.fit2json/garmintokens` (enter MFA if
prompted), after which the poller resumes automatically.

On Windows, use the native launcher from PowerShell:

```powershell
.\FitSift.cmd              # start the services and open the UI
.\FitSift.cmd status
.\FitSift.cmd stop
.\FitSift.cmd install      # add FitSift to the Start menu
```

After installing the shortcut, search for **FitSift** in the Start menu, right-click it,
and select **Pin to taskbar**. The shortcut runs the current Windows checkout through the
existing Ubuntu/WSL Python environment, preserving its authenticated Copilot CLI, then opens
http://localhost:8000 when the API is ready. Launching it again stops the existing web,
poller, and analyzer processes before starting a fresh single instance. Set
`FITSIFT_WSL_DISTRO`, `FITSIFT_WSL_REPO`, or `FITSIFT_WSL_FIT2JSON` to override the
default WSL locations.

Interactive analyses are owned by the web server once accepted. Switching apps, locking
the device, navigating away, or losing the browser connection only detaches the live
view; reconnecting replays missed output without starting a second model call. Completed
chat responses and terminal errors are written to `~/.fit2json/chats`, while single-workout
analyses continue to land in the memory corpus. Durable run IDs also prevent an uncertain
request retry after a web-server restart from launching duplicate inference.

### Script commands

| Command | What it does |
|---------|--------------|
| `./scripts/fitsift all` | **Start everything:** UI + poller (containers) + analyzer (host). |
| `./scripts/fitsift stop` | Stop everything (containers + host analyzer). |
| `./scripts/fitsift up [--build]` | Start just the web UI at http://localhost:8000. `--build` builds from local source. |
| `./scripts/fitsift update` | Pull the latest image from GHCR, then restart the UI. |
| `./scripts/fitsift restart` / `down` | Restart the UI / stop-and-remove all containers (+ host analyzer). |
| `./scripts/fitsift logs [-f]` | Show (follow) web UI logs (or `logs analyzer`). |
| `./scripts/fitsift status` | Status of every component (containers + analyzer). |
| `./scripts/fitsift open` | Open the UI in your browser. |
| `./scripts/fitsift poller [up\|down]` | Garmin poller container (keeps the library fresh). |
| `./scripts/fitsift analyzer [up\|down]` | Host auto-analyzer — analyzes each new workout into memory. |
| `./scripts/fitsift autoupdate [up\|down]` | Watchtower — auto-pulls new images. |

### Configuration

The compose stack reads these (all optional) from the environment or a repo-root `.env`:

| Var | Default | Purpose |
|-----|---------|---------|
| `FIT2JSON_HOME` | `~/.fit2json` | Host data dir mounted at `/data`. |
| `FITSIFT_PORT` | `8000` | Host port for the UI. |
| `FITSIFT_BIND_HOST` | `0.0.0.0` | Docker host bind address; use `127.0.0.1` behind Tailscale Serve. |
| `FITSIFT_CORS_ORIGINS` | `*` | Comma-separated browser origins; set the exact remote frontend origin. |
| `POLL_INTERVAL` | `900` | Seconds between Garmin polls (poller service). |
| `WATCH_INTERVAL` | `3600` | Seconds between image-update checks (autoupdate). |

Reach it from your phone on the same Wi-Fi at `http://<your-laptop-ip>:8000` (the server
already binds all interfaces). For a GitHub Pages frontend with private tailnet access
to this local backend, follow [the frontend deployment guide](frontend/README.md#github-pages-frontend--private-phone-access).

### Keeping data fresh + the analysis caveat

- The optional **poller** service runs `fetch garmin --watch` in the container, writing
  new workouts into the same `~/.fit2json/library/json` the UI reads. Seed the Garmin
  token cache once on the host (see [watch mode](#continuous-export-watch-mode)), then:
  ```bash
  ./scripts/fitsift poller up      # needs GARMIN_EMAIL/GARMIN_PASSWORD in .env for refresh
  ```
- **Analysis generation runs on the host, not in the container** (the `copilot` backend
  needs the Copilot CLI; `ollama`/`lmstudio` resolve to `localhost`). Close the loop with
  the **auto-analyze watcher**, which watches the same library and writes analyses to
  `~/.fit2json/memory` — which the containerized UI then shows in its Memory tab:
  ```bash
  fit2json analyze ~/.fit2json/library/json -p "Coach me on this workout." \
    --backend copilot --memory ~/.fit2json/memory --watch --interval 900
  ```
  Full pipeline: **poller (container) → library → analyzer (host) → memory → UI (container)**,
  all coupled only through the shared `~/.fit2json` directory.

### Plain `docker run` (no compose)

```bash
docker run -d --name fitsift-web --restart unless-stopped \
  -p 8000:8000 -v ~/.fit2json:/data \
  ghcr.io/kerem-ersoz/fit2json:latest serve --host 0.0.0.0 --port 8000
```

### Publishing

`.github/workflows/docker-publish.yml` builds this image (multi-arch, linux/amd64 +
arm64) and pushes `ghcr.io/kerem-ersoz/fit2json:latest` on every push to `main`. Until
this change lands there, `:latest` on GHCR is CLI-only — use `./scripts/fitsift up --build`.

---

## Configuration

Create a `.env` file (see `.env.example`); it's loaded automatically from the current directory.

```bash
GARMIN_EMAIL=your@email.com          # for `fetch garmin`
GARMIN_PASSWORD=your_password

STRAVA_CLIENT_ID=your_client_id      # for `fetch strava`
STRAVA_CLIENT_SECRET=your_client_secret
STRAVA_REFRESH_TOKEN=your_refresh_token
```

The `analyze` command needs **no API key** for the Copilot CLI or local models. Only set `OPENAI_API_KEY` if you point `--base-url` at an OpenAI-compatible endpoint that requires auth.

<details>
<summary>Garmin Connect setup</summary>

Use your normal Garmin Connect email/password (via env vars or `--email`/`--password`). Garmin may require 2FA/CAPTCHA for unfamiliar logins — sign in on the website first, or use **Activities → ⚙️ → Export Original** and `fit2json convert`.
</details>

<details>
<summary>Strava API setup</summary>

1. Create an app at [strava.com/settings/api](https://www.strava.com/settings/api) (callback `http://localhost`); note the Client ID and Secret.
2. Authorize with `activity:read_all` scope and exchange the code for a **refresh token**:
   ```bash
   curl -X POST https://www.strava.com/oauth/token \
     -d client_id=YOUR_ID -d client_secret=YOUR_SECRET \
     -d code=AUTH_CODE -d grant_type=authorization_code
   ```
3. Set `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` / `STRAVA_REFRESH_TOKEN`.

For full-fidelity data, prefer the bulk `.fit` export + `fit2json convert`.
</details>

---

## Supported activity types

Sport is read directly from the FIT `session` message (e.g. `running`, `cycling`, `swimming`, `hiking`, `walking`, `rowing`, `strength_training`, `multi_sport`, …). Unrecognized values fall back to `sport_<n>`. Because the schema is lossless, **all** sports and every field are preserved regardless of type.

---

## Migrating from 0.1

- **`convert` output is now lossless**, not the old compact summary/lap/1-min schema. Downstream code that read `summary`/`time_series_1min` should read the `messages` tree instead.
- **`analyze` no longer calls the OpenAI or GitHub Models API directly.** Use `--backend copilot|ollama|lmstudio` or `--base-url`. `OPENAI_API_KEY`/`GITHUB_TOKEN` are no longer required.
- **Removed:** the `--deep` multi-pass mode and its checkpointing (Copilot's large context + per-activity files make it unnecessary).
- **`fetch`** now writes one JSON file per activity into a directory by default (`./workouts/`).

---

## Troubleshooting

- **"No .fit files found"** — point at a `.fit` file or a directory containing them (searched recursively).
- **"copilot CLI was not found"** — install the Copilot CLI and sign in, or use `--backend ollama|lmstudio`.
- **Ollama/LM Studio connection refused** — make sure the local server is running (`ollama serve`; LM Studio → *Local Server → Start*) on its default port (11434 / 1234).
- **Huge JSON files** — use `--gzip`, or per-activity output; for local-model analysis the data is thinned automatically to `--max-chars`.

---

## Development

```bash
pip install -e ".[dev]"
pytest -q
```

## License

MIT
