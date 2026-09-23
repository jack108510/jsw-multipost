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
    # The stored session writes userId before accessToken. Accept either key
    # order, and never log the tokens found in Chrome's LevelDB files.
    for match in re.finditer(r'\{[^{}]{0,8192}\}', raw):
        text = match.group(0)
        if '"accessToken"' not in text or '"userId"' not in text:
            continue
        try:
            obj = json.loads(text)
        except json.JSONDecodeError:
            continue
        if obj.get("accessToken") and obj.get("userId"):
            sessions.append(obj)
    return sessions


def latest_session(extension_id: str, chrome_user_data_dir: str, chrome_profile: str) -> dict | None:
    storage_root = (
        Path(chrome_user_data_dir).expanduser()
        / chrome_profile
        / "Local Extension Settings"
    )
    preferred = storage_root / extension_id
    sessions = find_sessions(strings_for_dir(preferred))
    if not sessions and storage_root.is_dir():
        # Unpacked extension IDs depend on the installed path when no manifest
        # key is set. Search other extension stores only if the expected ID has
        # no Reachr session.
        sessions = [session for path in storage_root.iterdir() if path.is_dir() and path != preferred
                    for session in find_sessions(strings_for_dir(path))]
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


def amplr_chrome_roots(ext_dir: str) -> list[int]:
    """Return only root Chrome browser processes launched with Amplr's extension path.

    Avoid pgrep -f because it can match helper shells/commands. Renderer/helper
    processes are children of the root and die with it.
    """
    result = run(["ps", "-axo", "pid=,ppid=,command="])
    roots: list[int] = []
    for line in result.stdout.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) < 3:
            continue
        try:
            pid = int(parts[0]); ppid = int(parts[1])
        except ValueError:
            continue
        cmd = parts[2]
        if (
            cmd.startswith("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome ")
            and f"--load-extension={ext_dir}" in cmd
        ):
            roots.append(pid)
    return roots


def chrome_running(ext_dir: str) -> bool:
    return bool(amplr_chrome_roots(ext_dir))


def terminate_chrome(ext_dir: str) -> None:
    pids = amplr_chrome_roots(ext_dir)
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.time() + 12
    while time.time() < deadline and any(pid in amplr_chrome_roots(ext_dir) for pid in pids):
        time.sleep(0.5)
    for pid in pids:
        if pid not in amplr_chrome_roots(ext_dir):
            continue
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    time.sleep(2)


def launch_chrome(chrome_app: str, chrome_user_data_dir: str, chrome_profile: str, ext_dir: str, dashboard_url: str, extension_id: str) -> None:
    chrome_bin = str(Path(chrome_app) / "Contents/MacOS/Google Chrome")
    subprocess.Popen(
        [
            chrome_bin,
            f"--user-data-dir={Path(chrome_user_data_dir).expanduser()}",
            f"--profile-directory={chrome_profile}",
            "--no-first-run",
            "--disable-features=Translate",
            "--remote-debugging-address=127.0.0.1",
            "--remote-debugging-port=9223",
            f"--load-extension={ext_dir}",
            dashboard_url,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def status_line(state: str, **fields: object) -> str:
    safe = {k: v for k, v in fields.items() if v is not None}
    details = " ".join(f"{k}={v}" for k, v in safe.items())
    return f"{state}" + (f" {details}" if details else "")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ext-dir", required=True)
    parser.add_argument("--chrome-app", default="/Applications/Google Chrome.app")
    parser.add_argument("--chrome-user-data-dir", default=str(Path.home() / "Library/Application Support/Amplr/ChromeProfile"))
    parser.add_argument("--chrome-profile", default="Default")
    parser.add_argument("--dashboard-url", default="https://jack108510.github.io/fb-autoposter/dashboard.html")
    parser.add_argument("--extension-id", default=DEFAULT_EXTENSION_ID)
    parser.add_argument("--stale-seconds", type=int, default=150)
    parser.add_argument("--restart-wait-seconds", type=int, default=70)
    parser.add_argument("--no-restart", action="store_true")
    args = parser.parse_args()

    ext_dir = str(Path(args.ext_dir).expanduser().resolve())
    now = utc_now()

    session = latest_session(args.extension_id, args.chrome_user_data_dir, args.chrome_profile)
    if not session:
        running = chrome_running(ext_dir)
        print(status_line("NO_SESSION", action="sign_in_to_reachr_in_runner_chrome", chrome_running=running))
        if not args.no_restart and not running:
            launch_chrome(args.chrome_app, args.chrome_user_data_dir, args.chrome_profile, ext_dir, args.dashboard_url, args.extension_id)
        return 2

    try:
        heartbeat_at, ext_status, _ = fetch_heartbeat(session)
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8", "replace")
        except Exception:
            body = ""
        if exc.code == 401 and ("JWT expired" in body or "PGRST303" in body):
            print(status_line("SESSION_EXPIRED", action="open_extension_popup_and_sign_in", chrome_running=chrome_running(ext_dir)))
            return 7
        print(status_line("CHECK_FAILED", error=f"HTTPError:{exc.code}", chrome_running=chrome_running(ext_dir)))
        return 3
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
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
    launch_chrome(args.chrome_app, args.chrome_user_data_dir, args.chrome_profile, ext_dir, args.dashboard_url, args.extension_id)
    time.sleep(args.restart_wait_seconds)

    session = latest_session(args.extension_id, args.chrome_user_data_dir, args.chrome_profile) or session
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
