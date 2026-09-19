"""Analysis orchestration harness.

Sends workout JSON plus a custom prompt to a pluggable backend:

* ``copilot``  — shells out to the GitHub Copilot CLI (`copilot -p ...`), passing the
  workout files (and the memory directory) by path so Copilot reads them with its own
  file tools. Sidesteps context-window limits for the large lossless schema.
* ``ollama`` / ``lmstudio`` — local OpenAI-compatible servers. Workout JSON is inlined
  (compacted to fit ``--max-chars``) since these can't read files themselves.
* ``--base-url`` — any other OpenAI-compatible endpoint.
"""

from __future__ import annotations

import json
import os
import queue
import re
import shutil
import signal
import subprocess
import sys
import threading
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Dict, Iterator, List, Optional

import click

if TYPE_CHECKING:
    from openai.types.chat import ChatCompletionMessageParam

SYSTEM_PROMPT = (
    "You are an expert running/cycling/fitness coach and data analyst. You analyze "
    "workout data provided as structured JSON (a faithful, lossless decode of the "
    "athlete's .fit files) and give specific, actionable feedback grounded in the actual "
    "numbers. When prior workout analyses are provided as memory/context, use them to "
    "comment on progress and trends over time. Use markdown for readability. Respond with "
    "only the final analysis — do not narrate your process, tool use, or file reads."
)

# Appended to the prompt (web UI only) to let the model draw bespoke, insightful charts
# instead of the basic graphs Garmin/Strava already show. Rendered client-side as Vega-Lite.
CHART_INSTRUCTIONS = (
    "\n\n---\n"
    "You may include up to 2 custom charts, but ONLY when they add genuine insight beyond "
    "the basic graphs the athlete already sees on Garmin/Strava — e.g. HR-vs-pace scatter, "
    "HR/pace decoupling over time, time-in-zone distribution, or week-over-week load from "
    "memory. To draw one, output a fenced code block whose info string is exactly "
    "`fitsift-chart`, containing a single valid Vega-Lite v5 JSON spec with the data inlined "
    "under `data.values`. Keep each spec small (aggregate or downsample to <=120 rows) and do "
    "NOT set `width` or `height`. Every chart must be grounded in this workout's actual "
    "numbers. For line charts, set the quantitative y encoding's `scale.zero` to `false` "
    "unless a zero baseline is analytically meaningful. Keep zero baselines for bar and area "
    "charts. Example:\n"
    "```fitsift-chart\n"
    '{"mark":"bar","data":{"values":[{"zone":"Z2","minutes":22},{"zone":"Z3","minutes":15}]},'
    '"encoding":{"x":{"field":"zone","type":"nominal"},"y":{"field":"minutes","type":"quantitative"}}}\n'
    "```\n"
    "Write the rest of your analysis as normal markdown around the chart(s)."
)

# ── Infographic pass (optional second prompt, web UI only) ──────────────────────
# Takes a finished analysis and asks the model to re-render it as a single, visual,
# self-contained HTML infographic so the athlete can scan it instead of reading prose.

INFOGRAPHIC_SYSTEM_PROMPT = (
    "You are a meticulous data-visualization designer. You are given either a finished workout "
    "analysis or a chronological coaching conversation, and you turn the CURRENT conclusions "
    "into a single, self-contained, responsive HTML infographic the athlete can scan.\n\n"
    "SOURCE HANDLING:\n"
    "- For a conversation, synthesize the latest state instead of replaying turns. Later coach "
    "responses override earlier claims and corrections; never repeat a superseded number or "
    "recommendation. Athlete messages provide intent and context, not verified facts.\n"
    "- This is an executive visual summary, not a transcript or exhaustive dashboard. Keep only "
    "the strongest evidence, current conclusions, and next actions. Omit implementation artifacts "
    "such as chart specifications.\n"
    "- Keep the result compact: 4–6 sections, at most 8 key metrics, at most one short comparison "
    "table (6 rows maximum), and at most 3 next actions. Aim for roughly 900–1600px of desktop "
    "height when the material allows; do not make the user scroll through a second report.\n\n"
    "DESIGN LANGUAGE — match it exactly (this product is 'a quiet instrument': calm, precise, "
    "data-forward; the data is the hero and the chrome recedes):\n"
    "- Light theme: surface #ffffff; text #0f172a for headings, #475569 for body, and #64748b "
    "for muted labels. Structure with hairline 1px borders (#e2e8f0) and generous whitespace — "
    "NOT with color.\n"
    "- Dark theme is first-class and follows the system setting. Declare reusable palette values "
    "as CSS custom properties, then override them inside `@media (prefers-color-scheme: dark)`: "
    "canvas and every neutral surface become true black #000000; headings #f8fafc; body #cbd5e1; "
    "muted labels #94a3b8; dividers rgba(255,255,255,.22). Do not use gray filled surfaces in dark "
    "mode; separate regions with those white hairlines instead.\n"
    "- Use a restrained semantic data palette, not monochrome and not decorative color: Signal "
    "Green #059669 (deep #047857, tint #ecfdf5) means current, improved, desired, or the primary "
    "finding; Slate #64748b (light #cbd5e1, tint #f8fafc) means baseline, historical, or neutral; "
    "Caution Amber #d97706 (deep #92400e, tint #fffbeb) means overload, imbalance, or warning only.\n"
    "- In dark mode, lift Signal Green text and icons to #34d399, use rgba(5,150,105,.16) for its "
    "tint, and use dark translucent semantic tints for cautions. Keep the underlying surface black.\n"
    "- In every comparison visual, assign those roles consistently: baseline in slate, current or "
    "target in green, and a genuinely risky value in amber. Keep the text label and value visible "
    "so color is never the only cue. Use light role tints for at most one key surface per section; "
    "saturated color should remain under roughly 10% of the page. Add `baseline`, `current`, or "
    "`caution` to every bar-fill class so the runtime can preserve those semantics.\n"
    "- Flat. No drop shadows, no gradients, no gradient text, no glow. No tracked-uppercase "
    "eyebrow labels. No emoji. Rounded corners 8-12px on cards.\n"
    "- Font: the system stack "
    "font-family:Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif.\n\n"
    "STRUCTURE (adapt to the content — omit sections the analysis doesn't support):\n"
    "- A short headline and one-sentence takeaway. No kicker or eyebrow above it.\n"
    "- One compact key-metrics readout; avoid a repeated grid of identical cards.\n"
    "- CSS-only visuals where they add clarity: horizontal bar meters for zone / effort / time "
    "distribution, labeled progress bars, simple side-by-side comparison bars. Build every chart "
    "from plain <div>s with inline widths/percentages. Bar markup is strict: use a block-level "
    "track with a fixed height and overflow:hidden, then a direct block-level fill child with "
    "height:100% and a width between 0% and 100%. Never use an inline <span> as a fill. For a "
    "comparison, normalize every bar against the same stated maximum so lengths are comparable.\n"
    "- Give the primary metric or conclusion a pale green tint, and use a pale amber tint only "
    "around a real caution. Do not leave every metric, table, callout, and chart on identical white.\n"
    "- Compact callout cards for the key insights, and a short 'what to do next' list if the "
    "analysis implies next steps.\n\n"
    "HARD RULES:\n"
    "- Output ONE complete, valid HTML document beginning with <!doctype html>. Put ALL CSS in a "
    "single <style> in <head>. Use only inline/embedded CSS — no frameworks.\n"
    "- No JavaScript. No <img>, <svg> external refs, <iframe>, remote URLs, @import, or web fonts. "
    "It must render fully offline.\n"
    "- Use ONLY numbers and facts present in the provided analysis. Never invent data; if a value "
    "isn't stated, leave it out.\n"
    "- Accessible: body text contrast >=4.5:1 in both system themes. Fluid layout that works from "
    "~360px to ~900px wide (use flex-wrap / min-width, not fixed pixel columns).\n"
    "- Respond with ONLY the HTML — no markdown, no code fences, no commentary before or after."
)

# Copilot's agentic prompt normally ends by asking for markdown to stdout; the infographic
# pass overrides that trailer so the CLI emits raw HTML and never touches files.
INFOGRAPHIC_FINAL_INSTRUCTION = (
    "Output ONLY the complete HTML document (starting with <!doctype html>) to stdout. "
    "Do not modify any files."
)


def build_infographic_user_prompt(analysis: str) -> str:
    """The user message for the infographic pass: an analysis or conversation to visualize."""
    return (
        "Turn the following source into a compact HTML infographic, following your design rules. "
        "Ground every number in this text, do not add data that isn't here, and apply any later "
        "corrections before deciding what to show.\n\n"
        "===== SOURCE =====\n"
        f"{analysis.strip()}\n"
        "===== END SOURCE =====\n\n"
        "Produce the complete HTML document now."
    )


# Local OpenAI-compatible backends: (base_url, default api key)
LOCAL_BACKENDS = {
    "ollama": ("http://localhost:11434/v1", "ollama"),
    "lmstudio": ("http://localhost:1234/v1", "lm-studio"),
}

# FitSift exposes these as explicit long-context presets in the model selector.
COPILOT_LONG_CONTEXT_MODELS = ("gpt-5.6-sol", "gpt-5.6-sol-fast", "claude-opus-5")


def copilot_available() -> bool:
    return shutil.which("copilot") is not None


# The reasoning-effort levels the Copilot CLI exposes. Discovered from the installed CLI
# (`--reasoning-effort` choices) so it matches exactly, with a known fallback.
REASONING_EFFORTS_FALLBACK = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
_effort_cache: Optional[List[str]] = None


def copilot_reasoning_efforts() -> List[str]:
    """The reasoning-effort choices the installed Copilot CLI accepts (parsed once, cached)."""
    global _effort_cache
    if _effort_cache is not None:
        return _effort_cache
    efforts = list(REASONING_EFFORTS_FALLBACK)
    if copilot_available():
        try:
            out = subprocess.run(
                ["copilot", "--help"], capture_output=True, text=True, timeout=10
            ).stdout
            match = re.search(r"reasoning effort level \(choices:\s*(.+?)\)", out, re.S)
            if match:
                found = re.findall(r'"([^"]+)"', match.group(1))
                if found:
                    efforts = found
        except Exception:
            pass
    _effort_cache = efforts
    return efforts


def resolve_backend(backend: Optional[str], base_url: Optional[str]) -> str:
    """Pick a backend name. Auto-detects copilot (if installed) else ollama."""
    if base_url:
        return "openai-compatible"
    if backend:
        return backend
    if copilot_available():
        return "copilot"
    return "ollama"


# ── Copilot CLI backend ────────────────────────────────────────────────────────


def _build_copilot_prompt(
    prompt: str,
    workout_paths: List[Path],
    memory_dir: Optional[Path],
    library_dir: Optional[Path] = None,
    athlete_profile: Optional[str] = None,
    system_prompt: Optional[str] = None,
    final_instruction: Optional[str] = None,
) -> str:
    lines = [system_prompt or SYSTEM_PROMPT, ""]
    if athlete_profile:
        lines += [athlete_profile, ""]
    if workout_paths:
        lines.append("Workout data to analyze (lossless FIT JSON), read these files:")
        lines += [f"  - {p}" for p in workout_paths]
        lines.append("")
    if library_dir is not None:
        lines.append(
            f"The athlete's full workout library (one lossless FIT JSON per activity) is under: "
            f"{library_dir}\n"
            "Filenames are date- and sport-stamped. Browse it to find the workouts relevant to the "
            "request, then read those files."
        )
        lines.append("")
    if memory_dir is not None:
        lines.append(
            f"Prior analyses are stored under: {memory_dir}\n"
            "Browse the relevant ones (by sport/date) to reason about progress and trends. "
            "The index.jsonl there lists every past analysis."
        )
        lines.append("")
    lines.append(f"Athlete's request:\n{prompt}")
    lines.append("")
    lines.append(final_instruction or "Write the analysis to stdout as markdown. Do not modify any files.")
    return "\n".join(lines)


def run_copilot(
    prompt: str,
    workout_paths: List[Path],
    memory_dir: Optional[Path] = None,
    model: Optional[str] = None,
    stream: bool = True,
    silent: bool = True,
    reasoning_effort: Optional[str] = None,
    athlete_profile: Optional[str] = None,
) -> str:
    """Run analysis via the GitHub Copilot CLI subprocess.

    Thin wrapper over :func:`stream_copilot` that collects the streamed chunks and
    (optionally) echoes them to stdout, preserving the original CLI behavior.
    """
    chunks: List[str] = []
    for chunk in stream_copilot(
        prompt,
        workout_paths,
        memory_dir,
        model,
        silent=silent,
        reasoning_effort=reasoning_effort,
        athlete_profile=athlete_profile,
    ):
        chunks.append(chunk)
        if stream:
            sys.stdout.write(chunk)
            sys.stdout.flush()
    return "".join(chunks)


def _kill_windows_process_tree(proc: subprocess.Popen) -> None:
    """Force-stop one Windows process tree by exact PID."""
    try:
        result = subprocess.run(
            ["taskkill.exe", "/PID", str(proc.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    except OSError:
        result = None
    if result is None or (result.returncode != 0 and proc.poll() is None):
        proc.kill()


def _terminate_process_group(proc: subprocess.Popen) -> None:
    """Stop Copilot and any child process it spawned."""
    if proc.poll() is not None:
        return

    try:
        if os.name == "nt":
            proc.send_signal(getattr(signal, "CTRL_BREAK_EVENT", signal.SIGTERM))
        else:
            os.killpg(proc.pid, signal.SIGTERM)
    except (OSError, ValueError):
        try:
            if os.name == "nt":
                _kill_windows_process_tree(proc)
            else:
                proc.terminate()
        except OSError:
            return

    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        try:
            if os.name == "nt":
                _kill_windows_process_tree(proc)
            else:
                os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            return
        proc.wait()


def stream_copilot(
    prompt: str,
    workout_paths: List[Path],
    memory_dir: Optional[Path] = None,
    model: Optional[str] = None,
    silent: bool = True,
    reasoning_effort: Optional[str] = None,
    library_dir: Optional[Path] = None,
    athlete_profile: Optional[str] = None,
    system_prompt: Optional[str] = None,
    final_instruction: Optional[str] = None,
    event_handler: Optional[Callable[[dict], None]] = None,
    keepalive_interval: Optional[float] = None,
) -> Iterator[str]:
    """Yield analysis text chunks from the GitHub Copilot CLI subprocess.

    Streams the CLI's stdout line by line so callers (CLI or web) can consume it
    incrementally. Raises ``click.ClickException`` if the CLI is missing or fails.

    When ``silent`` is True, passes ``--silent`` so text-mode output contains only the
    final agent response — no tool-call trace or stats footer. Structured mode still
    receives JSON events, then filters durable answer text itself. ``library_dir`` grants
    the agent access to the whole workout library so it can find relevant workouts itself
    (freeform mode).

    ``system_prompt``/``final_instruction`` override the default coach persona and the
    "write markdown to stdout" trailer — used by the infographic pass to request raw HTML.

    When ``event_handler`` is provided, the CLI emits JSONL session events. Display-safe
    intent, reasoning, and message events are passed to the handler while this iterator
    yields only completed root-agent answer text. Tool-call narration stays out of saved
    analyses even though the web UI can preview and later discard it.

    ``--model`` is only passed when ``model`` is given, so an unset model falls back to
    the user's *configured* Copilot default (e.g. Opus). Forcing ``--model auto`` here
    would silently override that default with the auto-router's coding-tuned pick and
    produce terse, barebones coaching output — and ``auto`` also rejects
    ``--reasoning-effort`` outright.
    """
    if not copilot_available():
        raise click.ClickException(
            "The 'copilot' CLI was not found on PATH. Install GitHub Copilot CLI, or use "
            "--backend ollama|lmstudio (or --base-url) for a local model."
        )

    if reasoning_effort and (model or "").strip().lower() == "auto":
        raise click.ClickException(
            "The 'auto' model does not support --reasoning-effort. Pass an explicit "
            "--model (e.g. a Claude/GPT model) to use reasoning effort, or omit "
            "--reasoning-effort."
        )

    full_prompt = _build_copilot_prompt(
        prompt, workout_paths, memory_dir, library_dir, athlete_profile,
        system_prompt=system_prompt, final_instruction=final_instruction,
    )

    cmd = [
        "copilot",
        "-p", full_prompt,
        "--allow-all-tools",
        "--no-color",
        "--log-level", "none",
    ]
    if model:
        cmd += ["--model", model]
        if model.strip().lower() in COPILOT_LONG_CONTEXT_MODELS:
            cmd += ["--context", "long_context"]
    if silent:
        cmd.append("--silent")
    if event_handler is not None:
        cmd += [
            "--output-format", "json",
            "--stream", "on",
            "--enable-reasoning-summaries",
        ]
    if reasoning_effort:
        cmd += ["--reasoning-effort", reasoning_effort]
    allow_dirs = {str(p.parent.resolve()) for p in workout_paths}
    if memory_dir is not None:
        allow_dirs.add(str(Path(memory_dir).resolve()))
    if library_dir is not None:
        allow_dirs.add(str(Path(library_dir).resolve()))
    for d in sorted(allow_dirs):
        cmd += ["--add-dir", d]

    group_kwargs: Dict[str, Any]
    if os.name == "nt":
        group_kwargs = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    else:
        group_kwargs = {"start_new_session": True}

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        **group_kwargs,
    )
    stdout = proc.stdout
    assert stdout is not None
    completed = False
    reader: Optional[threading.Thread] = None
    heartbeat = keepalive_interval if keepalive_interval and keepalive_interval > 0 else None
    stream_error = ""

    def process_stdout_line(line: str) -> Optional[str]:
        nonlocal stream_error
        if event_handler is None:
            return line

        try:
            event = json.loads(line)
        except json.JSONDecodeError as exc:
            raise click.ClickException(f"copilot CLI emitted invalid JSONL: {exc}") from exc
        if not isinstance(event, dict):
            return None

        event_type = event.get("type")
        data = event.get("data")
        if event_type == "session.error" and isinstance(data, dict):
            stream_error = str(data.get("message") or "Copilot session failed")

        # Sub-agent output belongs in traces, not the athlete-facing answer/thinking panel.
        if event.get("agentId") or not isinstance(data, dict):
            return None
        if event_type in {
            "assistant.intent",
            "assistant.reasoning",
            "assistant.reasoning_delta",
            "assistant.message_delta",
            "assistant.message",
        }:
            event_handler(event)

        # A completed message with tools is an intermediate tool-call turn. Only no-tool,
        # response-phase messages are durable answer text.
        if event_type == "assistant.message":
            phase = str(data.get("phase") or "")
            has_tools = bool(data.get("toolRequests"))
            content = str(data.get("content") or "")
            if content and not has_tools and phase not in {"thinking", "commentary"}:
                return content
            # Hand control back to the SSE adapter so it can discard any provisional
            # message deltas immediately.
            return ""
        elif event_type in {
            "assistant.intent",
            "assistant.reasoning",
            "assistant.reasoning_delta",
            "assistant.message_delta",
        }:
            return ""
        return None

    try:
        if heartbeat is None:
            for line in stdout:
                output = process_stdout_line(line)
                if output is not None:
                    yield output
        else:
            messages: queue.Queue = queue.Queue()

            def read_stdout() -> None:
                try:
                    for line in stdout:
                        messages.put(("line", line))
                except (OSError, ValueError) as exc:
                    messages.put(("error", exc))
                finally:
                    messages.put(("end", None))

            reader = threading.Thread(
                target=read_stdout,
                name="fit2json-copilot-stdout",
                daemon=True,
            )
            reader.start()

            while True:
                try:
                    kind, value = messages.get(timeout=heartbeat)
                except queue.Empty:
                    # Empty chunks are transport keepalives. CLI callers ignore them; web
                    # routes translate them into SSE ping events.
                    yield ""
                    continue
                if kind == "line":
                    output = process_stdout_line(value)
                    if output is not None:
                        yield output
                elif kind == "error":
                    raise value
                else:
                    break

        returncode = proc.wait()
        completed = True
        if returncode != 0:
            err = proc.stderr.read() if proc.stderr else ""
            raise click.ClickException(f"copilot CLI failed (exit {returncode}): {err.strip()}")
        if stream_error:
            raise click.ClickException(stream_error)
    finally:
        if not completed:
            _terminate_process_group(proc)
        if reader is not None:
            reader.join(timeout=1)


# ── OpenAI-compatible backend (Ollama / LM Studio / custom) ─────────────────────


def _make_client(base_url: str, api_key: str):
    try:
        from openai import OpenAI
    except ImportError as exc:  # pragma: no cover
        raise click.ClickException("openai package required. Install with: pip install openai") from exc
    return OpenAI(base_url=base_url, api_key=api_key)


def _first_available_model(client) -> Optional[str]:
    try:
        models = client.models.list()
        data = list(getattr(models, "data", []) or [])
        if data:
            return data[0].id
    except Exception:
        return None
    return None


def _build_openai_messages(
    prompt: str,
    workout_json: str,
    memory_digest: Optional[str],
    max_chars: int,
    athlete_profile: Optional[str] = None,
    system_prompt: Optional[str] = None,
) -> "List[ChatCompletionMessageParam]":
    """Build the system+user chat messages, compacting the workout JSON to fit."""
    workout_json = compact_workout_json(workout_json, max_chars)

    user_parts = []
    if athlete_profile:
        user_parts.append(athlete_profile)
    if memory_digest:
        user_parts.append(
            "Prior workout analyses (memory, for trend context):\n" + memory_digest
        )
    if workout_json:
        user_parts.append("Workout data (lossless FIT JSON):\n```json\n" + workout_json + "\n```")
    user_parts.append("Athlete's request:\n" + prompt)

    messages: "List[ChatCompletionMessageParam]" = [
        {"role": "system", "content": system_prompt or SYSTEM_PROMPT},
        {"role": "user", "content": "\n\n".join(user_parts)},
    ]
    return messages


def stream_openai_compatible(
    prompt: str,
    workout_json: str,
    base_url: str,
    api_key: str,
    memory_digest: Optional[str] = None,
    model: Optional[str] = None,
    max_chars: int = 200_000,
    athlete_profile: Optional[str] = None,
    system_prompt: Optional[str] = None,
    keepalive_interval: Optional[float] = None,
) -> Iterator[str]:
    """Yield analysis text chunks from an OpenAI-compatible chat endpoint."""
    client = _make_client(base_url, api_key)
    messages = _build_openai_messages(
        prompt, workout_json, memory_digest, max_chars, athlete_profile, system_prompt
    )

    resp = None
    reader: Optional[threading.Thread] = None
    response_holder: Dict[str, Any] = {}
    cancelled = threading.Event()
    heartbeat = keepalive_interval if keepalive_interval and keepalive_interval > 0 else None

    def event_text(event) -> Optional[str]:
        return event.choices[0].delta.content if event.choices else None

    try:
        if heartbeat is None:
            resolved_model = model or _first_available_model(client) or "local-model"
            resp = client.chat.completions.create(
                model=resolved_model,
                messages=messages,
                stream=True,
            )
            for event in resp:
                delta = event_text(event)
                if delta:
                    yield delta
        else:
            messages_queue: queue.Queue = queue.Queue()

            def read_events() -> None:
                try:
                    if cancelled.is_set():
                        return
                    resolved_model = model or _first_available_model(client) or "local-model"
                    if cancelled.is_set():
                        return
                    response = client.chat.completions.create(
                        model=resolved_model,
                        messages=messages,
                        stream=True,
                    )
                    response_holder["response"] = response
                    if cancelled.is_set():
                        close_response = getattr(response, "close", None)
                        if close_response is not None:
                            close_response()
                        return
                    for event in response:
                        if cancelled.is_set():
                            break
                        messages_queue.put(("event", event))
                except Exception as exc:
                    messages_queue.put(("error", exc))
                finally:
                    messages_queue.put(("end", None))

            reader = threading.Thread(
                target=read_events,
                name="fit2json-openai-stream",
                daemon=True,
            )
            reader.start()

            while True:
                try:
                    kind, value = messages_queue.get(timeout=heartbeat)
                except queue.Empty:
                    yield ""
                    continue
                if kind == "event":
                    delta = event_text(value)
                    if delta:
                        yield delta
                elif kind == "error":
                    raise value
                else:
                    break
    finally:
        cancelled.set()
        response = resp if resp is not None else response_holder.get("response")
        try:
            close_response = getattr(response, "close", None)
            if close_response is not None:
                close_response()
        finally:
            try:
                close_client = getattr(client, "close", None)
                if close_client is not None:
                    close_client()
            finally:
                if reader is not None:
                    reader.join(timeout=1)
                late_response = response_holder.get("response")
                if late_response is not None and late_response is not response:
                    close_late_response = getattr(late_response, "close", None)
                    if close_late_response is not None:
                        close_late_response()


def run_openai_compatible(
    prompt: str,
    workout_json: str,
    base_url: str,
    api_key: str,
    memory_digest: Optional[str] = None,
    model: Optional[str] = None,
    stream: bool = True,
    max_chars: int = 200_000,
    athlete_profile: Optional[str] = None,
) -> str:
    """Run analysis against a local/remote OpenAI-compatible chat endpoint."""
    if stream:
        collected: List[str] = []
        for delta in stream_openai_compatible(
            prompt, workout_json, base_url, api_key, memory_digest, model, max_chars, athlete_profile
        ):
            collected.append(delta)
            sys.stdout.write(delta)
            sys.stdout.flush()
        sys.stdout.write("\n")
        return "".join(collected)

    client = _make_client(base_url, api_key)
    resolved_model = model or _first_available_model(client) or "local-model"
    messages = _build_openai_messages(prompt, workout_json, memory_digest, max_chars, athlete_profile)
    resp = client.chat.completions.create(model=resolved_model, messages=messages)
    text = resp.choices[0].message.content or ""
    sys.stdout.write(text + "\n")
    return text


# ── Compaction for context-limited local models ────────────────────────────────


def compact_workout_json(json_data: str, max_chars: int) -> str:
    """Shrink lossless workout JSON to fit a local model's context window.

    Progressively thins the largest per-sample arrays (records first) rather than
    dropping whole activities, so summaries/laps survive.
    """
    if len(json_data) <= max_chars:
        return json_data
    try:
        doc = json.loads(json_data)
    except json.JSONDecodeError:
        return json_data[:max_chars] + "\n... (truncated)"

    activities = doc.get("activities") if isinstance(doc, dict) else None
    if activities is None:
        activities = [doc] if isinstance(doc, dict) else []

    def size() -> int:
        return len(json.dumps(doc, separators=(",", ":"), ensure_ascii=False))

    # 1) Stride-thin record arrays with increasing factor until it fits.
    for stride in (2, 4, 8, 16, 32, 64):
        for act in activities:
            msgs = act.get("messages", {})
            records = msgs.get("record")
            if isinstance(records, list) and len(records) > 60:
                msgs["record"] = records[::stride]
                act.setdefault("_note", f"records thinned (every {stride}th sample)")
        if size() <= max_chars:
            break

    # 2) Still too big: drop record arrays entirely, keep sessions/laps.
    if size() > max_chars:
        for act in activities:
            act.get("messages", {}).pop("record", None)
            act["_note"] = "per-second records omitted to fit context"

    compact = json.dumps(doc, separators=(",", ":"), ensure_ascii=False)
    if len(compact) > max_chars:
        compact = compact[:max_chars] + "... (truncated)"
    return compact
