# Reachr smoke checks

The worker Mac handoff for the first test is in [`WORKER_MAC.md`](WORKER_MAC.md).

The JSON files in `fixtures/` describe expected outcomes for identity sync and Facebook group import. They are test inputs, not observations or permission to publish. Both use `mode: "no-submit"`. No group URL or post text is needed for this first stage.

`fixtures/wildrose-rose-campaign-draft.json` is a proposed one-time Rose campaign for review. Its 100-group target, copy, and time are proposals only. Fill the actual destination list from a complete Wildrose identity scan, review the destinations and copy, and keep the campaign as a draft until the owner explicitly approves activation.

## Run at a specific commit

1. Check out the requested commit in a clean copy of this repository and read both fixtures. Confirm the expected Pages are the intended accounts.
2. Run the existing source regression tests with `node --test tests/*.test.cjs` and `python3 tests/identity_contract_regression.py`. These tests do not open Facebook or publish a post.
3. In the Chrome profile running the Reachr extension, sign in to Reachr and Facebook. In the dashboard, run **Update profiles once**, then **Import groups once**. The extension may switch Facebook identities while it reads their group lists. It must not open a post composer or submit a post in this stage.
4. Compare the completed `__sync_identities__` job with each fixture's `expectedPage`. Compare the `__import_groups__` job's per-identity result with each fixture: its scan must have completed, and any saved groups must belong to that identity key. Report the scan strategy, source URL, group count, skipped Pages, and errors. Do not treat a successful overall job as proof that every Page was scanned.
5. Report the commit SHA, fixture paths, automated test results, and what the browser and job results actually showed. Record observations in the report, not in a fixture's `expected` fields. If an identity or source cannot be verified, mark that case unverified and stop before any posting workflow.

After groups have imported and been reviewed, add a separate no-submit composer fixture with one exact group URL and draft text. A fixture alone never authorizes publishing. A real post requires a separate explicit request naming the Page and destination, followed by independent verification before submission.

Keep passwords, cookies, tokens, and private customer data out of fixtures and Git history.
