# Reachr smoke checks

The JSON files in `fixtures/` describe exact browser checks for one Facebook Page, group, and draft. They are test inputs and expected outcomes, not observations or permission to publish. Keep `mode` set to `no-submit` unless a separate, explicit request authorizes a real post to a named destination.

## Prepare a fixture

Replace `REPLACE_WITH_GROUP_ID` and `REPLACE_WITH_EXACT_DRAFT_TEXT` with the exact group URL and draft supplied for that test. Do not run a browser check while either placeholder remains. Keep passwords, cookies, tokens, and private customer data out of the fixture and Git history. Use a new commit for each change so the test input is unambiguous.

## Run at a specific commit

1. Check out the requested commit in a clean copy of this repository and read the selected fixture. Confirm its `mode` is `no-submit` and its Page, group, and draft are the intended test data.
2. Run the existing source regression tests with `node --test tests/*.test.cjs` and `python3 tests/identity_contract_regression.py`. These tests do not open Facebook or publish a post.
3. If a browser check was requested, use the Chrome profile that runs the Reachr extension. Open the fixture's group, select `expectedPage`, and enter `postText` in the composer. Verify the active Page and composer actor against the fixture's `expected` fields. **Stop before clicking Post, Publish, or any equivalent submit control.**
4. Report the commit SHA, fixture path, automated test results, and what the browser actually showed. Record observations in the test report, not in the fixture's `expected` fields. If the Page or composer actor cannot be verified, stop and report that uncertainty.

A fixture alone never authorizes publishing. A real post requires a separate explicit request naming the Page and destination, followed by independent verification of both actors before submission.
