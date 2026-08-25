#!/usr/bin/env python3
"""
No-side-effect regression checks for Amplr/Reachr Facebook posting identity safety.

These tests intentionally inspect the extension/dashboard source instead of driving Facebook.
They protect the exact failure Jack reported: posting from whatever Facebook actor happens
to be logged in instead of the selected profile/Page.
"""
from pathlib import Path
import re
import sys
from typing import NoReturn

ROOT = Path(__file__).resolve().parents[1]
BACKGROUND = (ROOT / "background.js").read_text()
CONTENT = (ROOT / "content.js").read_text()
DASHBOARD = (ROOT / "dashboard.html").read_text()
DASHBOARD_BRIDGE = (ROOT / "dashboard_bridge.js").read_text()
MANIFEST = (ROOT / "manifest.json").read_text()


def fail(msg: str) -> NoReturn:
    print(f"FAIL: {msg}")
    sys.exit(1)


def assert_true(condition: bool, msg: str) -> None:
    if not condition:
        fail(msg)


def function_body(source: str, name: str) -> str:
    marker = f"function {name}"
    start = source.find(marker)
    if start < 0:
        marker = f"async function {name}"
        start = source.find(marker)
    assert_true(start >= 0, f"missing function {name}")
    paren = source.find("(", start)
    assert_true(paren >= 0, f"missing parameter list for {name}")
    depth = 0
    close_paren = -1
    for i in range(paren, len(source)):
        if source[i] == "(":
            depth += 1
        elif source[i] == ")":
            depth -= 1
            if depth == 0:
                close_paren = i
                break
    assert_true(close_paren >= 0, f"missing close paren for {name}")
    brace = source.find("{", close_paren)
    assert_true(brace >= 0, f"missing function body opener for {name}")
    depth = 0
    for i in range(brace, len(source)):
        ch = source[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return source[brace + 1:i]
    fail(f"missing closing brace for {name}")


def test_legacy_popup_posting_path_is_disabled() -> None:
    body = function_body(BACKGROUND, "runPostingQueue")
    return_idx = body.find("return;")
    assert_true("posting_disabled_identity_verified_queue_required" in body,
                "legacy popup queue must explicitly report posting disabled")
    assert_true(return_idx >= 0,
                "legacy popup queue must return before doing any work")
    assert_true("POST_TO_PAGE" not in body and "chrome.tabs.create" not in body,
                "legacy popup queue must contain no fallback Facebook posting code")


def test_dashboard_requires_identity_before_inserting_job() -> None:
    body = function_body(DASHBOARD, "createPostJob")
    guard_idx = body.find("Choose/sync a valid posting identity")
    insert_idx = body.find("jsw_post_jobs')")
    assert_true(guard_idx >= 0, "dashboard createPostJob must guard missing identity")
    assert_true(insert_idx >= 0, "dashboard createPostJob must insert into jsw_post_jobs")
    assert_true(guard_idx < insert_idx, "identity guard must happen before jsw_post_jobs insert")
    assert_true("selectedIdentityKey=identityKey(identity)" in body,
                "dashboard must require a real selected identity key")


def test_dashboard_group_targets_carry_identity_metadata() -> None:
    body = function_body(DASHBOARD, "getSelectedGroups")
    for field in ["identity_name", "identity_key", "identity_type", "identity_url"]:
        assert_true(field in body, f"selected group target must carry {field}")


def test_worker_skips_missing_or_forbidden_identity_before_opening_facebook_tab() -> None:
    body = function_body(BACKGROUND, "executeDashJob")
    guard_idx = body.find("identity_required")
    tab_idx = body.find("chrome.tabs.create")
    assert_true(guard_idx >= 0, "worker must record identity_required for ambiguous jobs")
    assert_true(tab_idx >= 0, "worker opens Facebook tabs for valid jobs")
    assert_true(guard_idx < tab_idx, "worker must reject missing identity before opening Facebook")


def test_worker_counts_success_only_after_composer_identity_verified() -> None:
    assert_true("response?.success && response?.composerIdentityVerified === true" in BACKGROUND,
                "worker must not count POST_TO_PAGE success unless composer identity was verified")
    for field in ["identity_used", "active_identity", "composer_identity", "composer_identity_verified", "identity_switched"]:
        assert_true(field in BACKGROUND, f"worker result must persist {field}")


def test_content_script_missing_identity_never_matches_current_account() -> None:
    body = function_body(CONTENT, "identityMatches")
    assert_true("if (!expected) return false" in body,
                "identityMatches must not treat missing expected identity as a match")


def test_content_script_composer_identity_gate_fails_closed() -> None:
    body = function_body(CONTENT, "verifyComposerIdentity")
    assert_true("identity_required" in body, "composer gate must throw identity_required with no expected identity")
    assert_true("identity_not_verified" in body, "composer gate must throw identity_not_verified on mismatch")
    assert_true("identityMatches(composerIdentity, expectedName)" in body,
                "composer gate must verify direct composer identity evidence")
    assert_true("dialogText.includes" not in body and ".includes(expectedName)" not in body,
                "composer gate must not verify using broad dialog text includes")


def test_page_identity_type_flows_to_content_script_switch_probe_and_post() -> None:
    assert_true("function isManagedPageIdentity(identityUrl, identityType=null)" in CONTENT,
                "content script must treat Page type as a managed Page even when URL shape changes")
    assert_true("isManagedPageIdentity(identityUrl, identityType)" in CONTENT,
                "post/probe path must use Page identity type, not only profile.php URL")
    assert_true("const identityType = target.identity_type || job.identity_type || storedIdentity?.type || null" in BACKGROUND,
                "worker must derive identityType for each target")
    post_message = re.search(r"chrome\.tabs\.sendMessage\(tab\.id, \{[\s\S]*?type: 'POST_TO_PAGE'[\s\S]*?\}\);", BACKGROUND)
    assert_true(post_message is not None and "identityType" in post_message.group(0),
                "worker must pass identityType to POST_TO_PAGE")
    probe_message = re.search(r"PROBE_GROUP_COMPOSER_IDENTITY'[\s\S]*?\}\)", BACKGROUND)
    assert_true(probe_message is not None and "identityType" in probe_message.group(0),
                "composer probe must pass identityType so Page probes use Page rules")


def test_managed_page_switch_uses_exact_page_fallback_not_stale_current_page() -> None:
    body = function_body(CONTENT, "switchManagedPageFromPagesManager")
    assert_true("expectedUrl = null" in CONTENT,
                "managed Page switch helper must accept the saved Page URL/ID")
    assert_true("expectedId" in body and "href.includes(expectedId)" in body,
                "managed Page switch must match the exact saved Page ID when available")
    assert_true("findPageLink" in body and "opened_page_link" in body,
                "managed Page switch must fall back to opening the exact Page link from Pages manager")
    assert_true("Manage Page" in body and "Comment as" in body,
                "managed Page switch must verify Page-owner signals before success")
    assert_true("body.toLowerCase().includes(normalizeText(expectedName).toLowerCase())" in body,
                "Page-owner verification must check the expected name inside page body text")
    bg = function_body(BACKGROUND, "runGlobalIdentitySwitchProbeJob")
    assert_true("identityUrl: identity.url" in bg,
                "global Page probe must pass identityUrl into the content-script switch helper")
    assert_true("direct_page_probe" in bg and "pages/?category=your_pages" in bg,
                "global Page probe must fall back to Pages manager when direct Page URL is wrong")


def test_group_import_uses_verified_switch_then_joined_groups_not_page_tab_first() -> None:
    body = function_body(BACKGROUND, "importFacebookGroupsForJob")
    switch_idx = body.find("SWITCH_FACEBOOK_IDENTITY")
    joins_idx = body.find("await chrome.tabs.update(tab.id, { url: joinedGroupsUrl")
    assert_idx = body.find("assertFacebookActiveIdentity")
    groups_tab_idx = body.find("facebookPageGroupsUrl")
    assert_true("verified_profile_switch_then_joined_groups" in body,
                "group import must expose the verified profile switch /groups/joins strategy")
    assert_true(switch_idx >= 0 and joins_idx >= 0 and assert_idx >= 0,
                "group import must switch actor, open /groups/joins, then verify active identity")
    assert_true(switch_idx < joins_idx < assert_idx,
                "group import order must be switcher -> /groups/joins -> active identity verifier")
    assert_true(groups_tab_idx < 0 or groups_tab_idx > assert_idx,
                "Page Groups tab must not be the first/default import route")


def test_page_generic_joined_groups_proof_allows_verified_switch_strategy() -> None:
    assert_true("['verified_profile_switch_then_joined_groups','pages_manager_switch_then_joined_groups'].includes" in BACKGROUND,
                "account-level overlap guard must trust verified /groups/joins actor proof for the profile-switch strategy")
    assert_true("joined_groups_identity_verified" in BACKGROUND,
                "group import results must persist actor verification proof")


def test_dashboard_group_sync_payload_and_history_show_joined_groups_route() -> None:
    selected = function_body(DASHBOARD, "syncGroupsForSelectedIdentity")
    all_sync = function_body(DASHBOARD, "syncGroupsForAllIdentities")
    label = function_body(DASHBOARD, "groupSyncRouteLabel")
    for body in [selected, all_sync]:
        assert_true("group_sync_strategy: 'verified_profile_switch_then_joined_groups'" in body,
                    "dashboard-created import jobs must request verified profile switch /groups/joins route")
        assert_true("scan_source_url: 'https://www.facebook.com/groups/joins/?nav_source=tab'" in body,
                    "dashboard-created import jobs must document the exact joined-groups URL")
    assert_true("verified profile switch → /groups/joins" in label,
                "dashboard must render the proven group-sync route in job/history rows")


def test_supabase_outage_has_local_fallback_queue_contract() -> None:
    for needle in [
        "LOCAL_FALLBACK_JOB_QUEUE_KEY",
        "QUEUE_LOCAL_FALLBACK_JOB",
        "pollLocalFallbackJobs",
        "saveLocalFallbackJob",
        "local_fallback: true",
        "local_fallback_synced",
    ]:
        assert_true(needle in BACKGROUND, f"background missing local fallback queue contract: {needle}")
    poll = function_body(BACKGROUND, "pollPendingJobs")
    assert_true("pollLocalFallbackJobs()" in poll, "normal poll must fall back to local queue when Supabase poll fails")


def test_dashboard_queues_local_fallback_when_supabase_insert_fails() -> None:
    body = function_body(DASHBOARD, "createPostJob")
    assert_true("queueLocalFallbackJob(payload" in body, "dashboard must queue a local fallback job when Supabase insert fails")
    assert_true("Supabase is temporarily down" in body, "dashboard must explain local fallback mode to the operator")
    for needle in ["function queueLocalFallbackJob", "amplr_local_fallback_jobs", "QUEUE_LOCAL_FALLBACK_JOB", "sendAmplrBridgeMessage"]:
        assert_true(needle in DASHBOARD, f"dashboard missing fallback helper: {needle}")
    for needle in ["amplr-dashboard-page", "amplr-dashboard-bridge", "QUEUE_LOCAL_FALLBACK_JOB", "GET_LOCAL_FALLBACK_JOB"]:
        assert_true(needle in DASHBOARD_BRIDGE, f"dashboard bridge missing extension relay: {needle}")


def test_manifest_version_bumped_for_reload_visibility() -> None:
    m = re.search(r'"version"\s*:\s*"(\d+)\.(\d+)\.(\d+)"', MANIFEST)
    if m is None:
        fail("manifest must expose a semantic extension version")
    version = tuple(int(part) for part in m.groups())
    assert_true(version >= (2, 2, 98),
                f"manifest version should stay at or above 2.2.98 for reload visibility, got {'.'.join(map(str, version))}")


def main() -> None:
    tests = [name for name in globals() if name.startswith("test_")]
    for name in tests:
        globals()[name]()
        print(f"PASS: {name}")
    print(f"\n{len(tests)} identity-contract regression checks passed.")


if __name__ == "__main__":
    main()
