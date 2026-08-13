#!/usr/bin/env python3
"""
Amplr heartbeat watchdog for the macOS Chrome extension runner.

Checks the real backend extension heartbeat. If stale, restarts only the Chrome
instance launched with the Amplr extension path, then waits for the heartbeat to
advance. Designed to be called from scripts/amplr-runner.sh.

No secrets are printed. Access tokens are read from Chrome extension local
storage only to query the user's own heartbeat/status rows.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SB_URL = "https://xacehhtgvubcqdoltazg.supabase.co"
SB_ANON_KEY = "sb_publishable_1TNu5hqotJ7GGQXfjliivQ_ttK51EAA"
DEFAULT_EXTENSION_ID = "nglcanaclcaahancoecenliekemolfgp"


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def parse_iso(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = dt.datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.timezone.utc)
        return parsed.astimezone(dt.timezone.utc)
    except ValueError:
        return None


def run(cmd: list[str], *, timeout: int = 20, check: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, text=True, capture_output=True, timeout=timeout, check=check)


def strings_for_dir(path: Path) -> str:
    if not path.is_dir():
        return ""
    chunks: list[str] = []
    for child in path.iterdir():
        if not child.is_file():
            continue
        try:
            result = run(["strings", str(child)], timeout=10)
            if result.stdout:
                chunks.append(result.stdout)
        except Exception:
            continue
    return "\n".join(chunks)


def find_sessions(raw: str) -> list[dict]:
    sessions: list[dict] = []
    # Chrome LevelDB strings can contain leading/trailing bytes; find compact JSON
    # objects containing accessToken + userId. Tokens are never logged.
    for match in re.finditer(r'\{[^{}]*"accessToken"[^{}]*"userId"[^{}]*\}', raw):
        text = match.group(0)
        try:
            obj = json.loads(text)
        except json.JSONDecodeError:
            continue
        if obj.get("accessToken") and obj.get("userId"):
            sessions.append(obj)
    return sessions


def latest_session(extension_id: str, chrome_profile: str) -> dict | None:
    storage_dir = (
        Path.home()
        / "Library/Application Support/Google/Chrome"
        / chrome_profile
        / "Local Extension Settings"
        / extension_id
    )
    raw = strings_for_dir(storage_dir)
    sessions = find_sessions(raw)
    if not sessions:
        return None
    return max(sessions, key=lambda s: (int(s.get("expiresAt") or 0), float(s.get("refreshedAt") or 0)))


def sb_get(path_and_query: str, access_token: str) -> list[dict]:
    url = f"{SB_URL}{path_and_query}"
    req = urllib.request.Request(
        url,
        headers={"apikey": SB_ANON_KEY, "Authorization": f"Bearer {access_token}"},
    )
    with urllib.request.urlopen(req, timeout=15) as res:
        return json.loads(res.read().decode("utf-8"))


def fetch_heartbeat(session: dict) -> tuple[dt.datetime | None, str | None, dict | None]:
    user_id = urllib.parse.quote(str(session["userId"]))
    access_token = session["accessToken"]

    settings_at: dt.datetime | None = None
    status_at: dt.datetime | None = None
    status_value: dict | None = None

    settings = sb_get(
        f"/rest/v1/jsw_settings?user_id=eq.{user_id}&select=ext_heartbeat",
        access_token,
    )
    if settings:
        settings_at = parse_iso(settings[0].get("ext_heartbeat"))

    status_rows = sb_get(
        f"/rest/v1/amplr_data?user_id=eq.{user_id}&key=eq.extension_status&select=value,updated_at",
        access_token,
    )
    if status_rows:
        status_value = status_rows[0].get("value") or {}
        status_at = parse_iso(status_value.get("last_seen")) or parse_iso(status_rows[0].get("updated_at"))

    candidates = [x for x in [settings_at, status_at] if x]
    latest = max(candidates) if candidates else None
    status = None
    if isinstance(status_value, dict):
        status = status_value.get("status")
    return latest, status, status_value


def chrome_pattern(ext_dir: str) -> str:
    return f"Google Chrome.*--load-extension={ext_dir}"


def chrome_running(ext_dir: str) -> bool:
    return run(["pgrep", "-f", chrome_pattern(ext_dir)]).returncode == 0


def terminate_chrome(ext_dir: str) -> None:
    result = run(["pgrep", "-f", chrome_pattern(ext_dir)])
    pids = [int(x) for x in result.stdout.split() if x.strip().isdigit()]
    own_pid = os.getpid()
    for pid in pids:
        if pid == own_pid:
            continue
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    time.sleep(3)
    for pid in pids:
        if pid == own_pid:
            continue
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            continue
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def launch_chrome(chrome_app: str, chrome_profile: str, ext_dir: str, dashboard_url: str, extension_id: str) -> None:
    popup_url = f"chrome-extension://{extension_id}/popup.html"
    run(
        [
            "open",
            "-na",
            chrome_app,
            "--args",
            f"--user-data-dir={Path.home() / 'Library/Application Support/Google/Chrome'}",
            f"--profile-directory={chrome_profile}",
            "--no-first-run",
            "--disable-features=Translate",
            f"--load-extension={ext_dir}",
            popup_url,
            dashboard_url,
        ],
        timeout=20,
    )


def status_line(state: str, **fields: object) -> str:
    safe = {k: v for k, v in fields.items() if v is not None}
    details = " ".join(f"{k}={v}" for k, v in safe.items())
    return f"{state}" + (f" {details}" if details else "")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ext-dir", required=True)
    parser.add_argument("--chrome-app", default="/Applications/Google Chrome.app")
    parser.add_argument("--chrome-profile", default="Default")
    parser.add_argument("--dashboard-url", default="https://jack108510.github.io/jsw-multipost/dashboard.html")
    parser.add_argument("--extension-id", default=DEFAULT_EXTENSION_ID)
    parser.add_argument("--stale-seconds", type=int, default=150)
    parser.add_argument("--restart-wait-seconds", type=int, default=70)
    parser.add_argument("--no-restart", action="store_true")
    args = parser.parse_args()

    ext_dir = str(Path(args.ext_dir).expanduser().resolve())
    now = utc_now()

    session = latest_session(args.extension_id, args.chrome_profile)
    if not session:
        print(status_line("NO_SESSION", chrome_running=chrome_running(ext_dir)))
        if not args.no_restart:
            launch_chrome(args.chrome_app, args.chrome_profile, ext_dir, args.dashboard_url, args.extension_id)
        return 2

    try:
        heartbeat_at, ext_status, _ = fetch_heartbeat(session)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as exc:
        print(status_line("CHECK_FAILED", error=type(exc).__name__, chrome_running=chrome_running(ext_dir)))
        return 3

    age = int((now - heartbeat_at).total_seconds()) if heartbeat_at else None
    running = chrome_running(ext_dir)
    if running and heartbeat_at and age is not None and age <= args.stale_seconds and ext_status != "offline":
        print(status_line("OK", heartbeat_age_seconds=age, status=ext_status, chrome_running=True))
        return 0

    previous_heartbeat_at = heartbeat_at
    print(status_line("STALE", heartbeat_age_seconds=age, status=ext_status, chrome_running=running))
    if args.no_restart:
        return 4

    terminate_chrome(ext_dir)
    launch_chrome(args.chrome_app, args.chrome_profile, ext_dir, args.dashboard_url, args.extension_id)
    time.sleep(args.restart_wait_seconds)

    session = latest_session(args.extension_id, args.chrome_profile) or session
    try:
        heartbeat_at, ext_status, _ = fetch_heartbeat(session)
    except Exception as exc:
        print(status_line("RECOVERY_CHECK_FAILED", error=type(exc).__name__, chrome_running=chrome_running(ext_dir)))
        return 5
    age = int((utc_now() - heartbeat_at).total_seconds()) if heartbeat_at else None
    heartbeat_advanced = bool(heartbeat_at and previous_heartbeat_at and heartbeat_at > previous_heartbeat_at)
    heartbeat_fresh = bool(heartbeat_at and age is not None and age <= args.stale_seconds)
    if chrome_running(ext_dir) and (heartbeat_fresh or heartbeat_advanced) and ext_status != "offline":
        print(status_line(
            "RECOVERED",
            heartbeat_age_seconds=age,
            status=ext_status,
            chrome_running=True,
            heartbeat_advanced=heartbeat_advanced,
        ))
        return 0

    print(status_line("RECOVERY_FAILED", heartbeat_age_seconds=age, status=ext_status, chrome_running=chrome_running(ext_dir)))
    return 6


if __name__ == "__main__":
    raise SystemExit(main())
