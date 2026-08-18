# Amplr Page Identity Test Lab

## Purpose

This extension build adds a **Page Identity Test Lab** for validating Facebook identity switching before any posting workflow is used. It is deliberately separated from the normal job queue and does not create a post, create a queue row, type text, attach media, add a comment, or click Facebook’s Post button.

## How to run the test

1. Load this folder as an unpacked Chrome extension, or install the packaged test build.
2. Sign in to Amplr and make sure you are already signed in to Facebook in the same Chrome profile.
3. Open the Amplr extension popup and select **Test Page Identity — No Post**.
4. Choose the expected Facebook Page or profile from the synchronized identity list.
5. Optionally enter a Facebook Group URL. This adds a deeper test: it opens the group composer, checks the acting identity that Facebook shows, and closes the composer without entering or submitting any content.
6. Select **Run identity-switch test**.

## Pass criteria

A switch-only test passes only when Facebook reports the selected identity as active after Amplr runs its existing switch workflow. A group-composer test passes only when the group composer independently verifies that same identity. A failed result is a safe stop condition; resolve it before creating a production posting job.

## Result fields

| Field | Meaning |
|---|---|
| Expected identity | The Page/profile selected for the test. |
| Facebook active identity | Identity reported by Facebook after the switch attempt. |
| Active identity matches | Whether the reported active identity matches the expected one. |
| Composer checked | Whether an optional group-composer test was requested. |
| Composer identity | The actor identified directly from the Facebook group composer. |
| Composer matches | Whether the composer verified the expected Page/profile. |

## Test isolation

The test page sends only `IDENTITY_TEST_LIST` and `IDENTITY_TEST_RUN` messages. The background-worker path uses the existing Facebook switch, active-identity read, and optional composer-probe messages. It does not invoke `POST_TO_PAGE` and does not reference or insert into `jsw_post_jobs`.

## Local validation

Run the following from the extension root:

```bash
node scripts/test-identity-test-lab.js
node --check background.js
node --check popup.js
node --check test-lab.js
```
