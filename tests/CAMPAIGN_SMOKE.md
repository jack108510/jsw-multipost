# Durable campaign smoke test

Use the dashboard and extension commits from the same review. The Supabase migrations in `supabase/migrations/20260915000000_durable_campaign_schedules.sql` through `20260917000000_campaign_tick_rpc.sql` must be applied once before this feature can run. Installing the extension alone does not install database tables.

1. Run the extension's local regression tests. Confirm the extension version in Chrome matches the reviewed manifest and the Reachr dashboard shows that worker as connected.
2. In the dashboard, create a campaign draft with a synced Facebook identity, one verified group, draft text, and a future schedule. Choose **Save draft**. Confirm the campaign appears as **Draft** and no `jsw_post_jobs` row is created.
3. Close every Reachr dashboard tab. Keep Chrome and the extension running. Confirm the draft remains unsent after its scheduled time; a draft has no approval and must never post.
4. To test activation later, use an explicitly authorized test campaign with the exact Page, group, text, and time. Review the approval details and activate it. Close the dashboard, then verify that the extension creates and executes one occurrence at the chosen time. Do not use this step with a production group or unapproved text.
5. Pause the campaign and confirm pending jobs for it are cancelled. A job already processing may finish; inspect its result before making another change.

Report the dashboard and extension commit SHAs, campaign ID, scheduled time and time zone, approval ID (if activated), occurrence/job IDs and final statuses, and any errors. Keep credentials and private customer data out of the report.
