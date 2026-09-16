#!/usr/bin/env python3
"""Approval persistence integration tests using only a disposable socket PostgreSQL cluster."""
import importlib.util
import getpass
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('fixture', ROOT / 'scripts/test-durable-scheduling.py')
assert spec is not None and spec.loader is not None
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
MIGRATIONS = (
    ROOT / 'supabase/migrations/20260915000000_durable_campaign_key.sql',
    ROOT / 'supabase/migrations/20260915010000_durable_source_campaign.sql',
    ROOT / 'supabase/migrations/20260916000000_campaign_approvals.sql',
)
OWNER_ID = '00000000-0000-0000-0000-000000000001'
OTHER_ID = '00000000-0000-0000-0000-000000000002'
SCHEDULE_ID = '10000000-0000-0000-0000-000000000001'


class CampaignApprovals(unittest.TestCase):
    owner: str
    env: dict

    @classmethod
    def setUpClass(cls):
        fixture.DurableScheduling.setUpClass.__func__(cls)
        # The shared fixture derives PGUSER from $USER, which can differ from
        # the local initdb superuser in isolated CI shells.
        cls.env['PGUSER'] = getpass.getuser()

    @classmethod
    def tearDownClass(cls):
        fixture.DurableScheduling.tearDownClass.__func__(cls)

    sql = classmethod(fixture.DurableScheduling.sql.__func__)
    tick = fixture.DurableScheduling.tick

    def setUp(self):
        fixture.DurableScheduling.setUp(self)
        for migration in MIGRATIONS:
            self.assertTrue(migration.exists(), f'missing migration: {migration.name}')
            self.sql(f'SET ROLE {self.owner}; ' + migration.read_text())
        self.sql(f"""
            INSERT INTO auth.users VALUES ('{OTHER_ID}');
            UPDATE public.reachr_campaign_schedules
               SET source_campaign_id='wildrose-rose-all-saved-daily',
                   groups='[{{"url":"https://www.facebook.com/groups/111/","name":"Reviewed group"}}]',
                   message='Reviewed server copy', image_url='https://cdn.example/creative.png',
                   first_comment='Reviewed first comment', enabled=true, max_runs=NULL
             WHERE id='{SCHEDULE_ID}';
        """)

    def approve(self, offer='20% off', disclosures='Terms apply', destination='https://example.com/offer', name='Jane Approver'):
        return self.sql(f"""
            SET ROLE authenticated;
            SET request.jwt.claim.sub='{OWNER_ID}';
            SELECT public.reachr_approve_campaign(
              '{SCHEDULE_ID}', '{offer}', '{disclosures}', '{destination}', '{name}');
        """)

    def test_tdd_missing_approval_blocks_schedule_admission(self):
        self.assertEqual(self.tick(), '0')
        self.assertEqual(self.sql('SELECT count(*) FROM public.jsw_post_jobs'), '0')
        self.assertEqual(self.sql('SELECT fired_count FROM public.reachr_campaign_schedules'), '0')

    def test_approval_captures_exact_server_snapshot_and_links_generated_job(self):
        approval_id = self.approve()
        self.assertRegex(approval_id, r'^[0-9a-f-]{36}$')
        self.assertEqual(self.sql(f"""
            SELECT message || '|' || image_url || '|' || first_comment || '|' || groups::text || '|'
              || offer || '|' || disclosures || '|' || destination || '|' || approver_name || '|'
              || approved_by::text || '|' || (approved_at IS NOT NULL)::text
            FROM public.reachr_campaign_approvals WHERE id='{approval_id}'
        """), "Reviewed server copy|https://cdn.example/creative.png|Reviewed first comment|[{\"url\": \"https://www.facebook.com/groups/111/\", \"name\": \"Reviewed group\"}]|20% off|Terms apply|https://example.com/offer|Jane Approver|00000000-0000-0000-0000-000000000001|true")
        self.assertEqual(self.tick(), '1')
        self.assertEqual(self.sql(f"SELECT approval_id::text FROM public.jsw_post_jobs WHERE approval_id='{approval_id}'"), approval_id)

    def test_changed_copy_creative_comment_or_targeting_requires_new_current_approval(self):
        self.approve()
        for assignment in (
            "message='Changed copy'", "image_url='https://cdn.example/changed.png'",
            "first_comment='Changed comment'", "groups='[{\"url\":\"https://www.facebook.com/groups/222/\"}]'",
        ):
            with self.subTest(assignment=assignment):
                self.sql('UPDATE public.reachr_campaign_schedules SET ' + assignment)
                self.assertEqual(self.tick(), '0')
                self.approve()
                self.assertEqual(self.tick('2026-09-20T10:00Z'), '1')
                self.sql("UPDATE public.jsw_post_jobs SET status='done'")

    def test_newer_or_revoked_approval_is_not_current_and_revocation_is_audited(self):
        first = self.approve(offer='old')
        second = self.approve(offer='new')
        self.assertNotEqual(first, second)
        self.assertEqual(self.tick(), '1')
        self.assertEqual(self.sql('SELECT approval_id::text FROM public.jsw_post_jobs'), second)
        self.sql("UPDATE public.jsw_post_jobs SET status='done'")
        self.sql(f"SET ROLE authenticated; SET request.jwt.claim.sub='{OWNER_ID}'; SELECT public.reachr_revoke_campaign_approval('{second}', 'Offer withdrawn')")
        self.assertEqual(self.sql(f"SELECT revoked_by::text || '|' || reason || '|' || (revoked_at IS NOT NULL)::text FROM public.reachr_campaign_approval_revocations WHERE approval_id='{second}'"), OWNER_ID + '|Offer withdrawn|true')
        self.assertEqual(self.tick(), '0')

    def test_records_are_append_only_and_owner_scoped_rpcs_are_acl_limited(self):
        approval_id = self.approve()
        self.sql(f"SET ROLE authenticated; SET request.jwt.claim.sub='{OWNER_ID}'; SELECT public.reachr_revoke_campaign_approval('{approval_id}', 'withdrawn')")
        for statement in (
            f"UPDATE public.reachr_campaign_approvals SET offer='tampered' WHERE id='{approval_id}'",
            f"DELETE FROM public.reachr_campaign_approvals WHERE id='{approval_id}'",
            f"UPDATE public.reachr_campaign_approval_revocations SET reason='tampered' WHERE approval_id='{approval_id}'",
        ):
            with self.subTest(statement=statement), self.assertRaisesRegex(AssertionError, 'immutable'):
                self.sql(statement)
        with self.assertRaisesRegex(AssertionError, 'permission denied|not owned'):
            self.sql(f"SET ROLE authenticated; SET request.jwt.claim.sub='{OTHER_ID}'; SELECT public.reachr_approve_campaign('{SCHEDULE_ID}', 'x', 'x', 'https://example.com/x', 'Other')")
        for role in ('anon', 'service_role', 'acl_probe'):
            for function in ('reachr_approve_campaign(uuid,text,text,text,text)', 'reachr_revoke_campaign_approval(uuid,text)'):
                self.assertEqual(self.sql(f"SELECT has_function_privilege('{role}', 'public.{function}', 'EXECUTE')"), 'f')
        self.assertEqual(self.sql("SELECT has_function_privilege('authenticated', 'public.reachr_approve_campaign(uuid,text,text,text,text)', 'EXECUTE')"), 't')
        for table in ('reachr_campaign_approvals', 'reachr_campaign_approval_revocations'):
            self.assertEqual(self.sql(f"SELECT has_table_privilege('authenticated', 'public.{table}', 'INSERT')"), 'f')
            self.assertEqual(self.sql(f"SELECT has_table_privilege('authenticated', 'public.{table}', 'UPDATE')"), 'f')


if __name__ == '__main__':
    unittest.main(verbosity=2)
