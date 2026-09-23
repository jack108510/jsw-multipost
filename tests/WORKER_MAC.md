# Worker Mac: Reachr import smoke test

Use the exact commit SHA supplied with the test request. Read `tests/README.md` and both fixtures at that commit before starting. This first test checks identity discovery and group import only. It does not authorize a post.

1. In the Reachr dashboard, check for pending posting jobs before bringing the extension worker online. If any could run unexpectedly, stop and report them.
2. Use the Chrome window opened by the Amplr/Reachr runner. Sign in to the same Reachr account as the dashboard and confirm Facebook is signed in in that Chrome profile. Confirm the dashboard shows the Chrome helper connected.
3. Run **Update profiles** once. Wait for the `__sync_identities__` job to finish. Check that both **Wildrose Automations** and **Empty Slot** appear with distinct identity keys.
4. Run **Import groups** once. Wait for the `__import_groups__` job to finish. Check each Page's entry separately: `status: scanned`, `scan_complete: true`, `active_identity_verified: true`, its own identity key, and the expected joined-groups source URL. The first complete v3 scan records a baseline and does not remove older saved rows.
5. Review the first scan's per-Page counts and source URLs before running a second import. On the next complete scan, Reachr removes records missing for an identity only when its two full URL snapshots agree closely. A failed, incomplete, or inconsistent scan leaves its saved rows alone. Check `new_count`, `removed_count`, `pending_removal_count`, and `reconciliation` in each Page result. A successful overall job does not prove every Page succeeded.
6. Report the test commit SHA, source regression test results, worker connection status, both job IDs and final statuses, and for each Page its identity key, scan strategy, source URL, observed group count, and any error or skipped reason. Keep tokens, cookies, and customer data out of the report.

The extension may switch Facebook identities while reading group lists. Do not open a composer or submit a post for this test. If the active Page, scan source, or group ownership is uncertain, stop and report the uncertainty. Choose an exact imported group and draft for a later, separate no-submit composer test.
