-- Forward-only approval audit and admission gate. Existing schedules/jobs remain untouched.
BEGIN;

CREATE TABLE public.reachr_campaign_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES public.reachr_campaign_schedules(id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  message text NOT NULL,
  image_url text,
  first_comment text,
  groups jsonb NOT NULL CHECK (jsonb_typeof(groups) = 'array'),
  offer text NOT NULL CHECK (btrim(offer) <> ''),
  disclosures text NOT NULL CHECK (btrim(disclosures) <> ''),
  destination text NOT NULL CHECK (btrim(destination) <> ''),
  approver_name text NOT NULL CHECK (btrim(approver_name) <> ''),
  approved_by uuid NOT NULL REFERENCES auth.users(id),
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX reachr_campaign_approvals_current_idx
  ON public.reachr_campaign_approvals(schedule_id, approved_at DESC, id DESC);

-- Revocation is append-only rather than a mutation of an approval snapshot.
CREATE TABLE public.reachr_campaign_approval_revocations (
  approval_id uuid PRIMARY KEY REFERENCES public.reachr_campaign_approvals(id),
  revoked_by uuid NOT NULL REFERENCES auth.users(id),
  revoked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reason text NOT NULL CHECK (btrim(reason) <> '')
);

ALTER TABLE public.jsw_post_jobs
  ADD COLUMN approval_id uuid REFERENCES public.reachr_campaign_approvals(id);
CREATE INDEX jsw_post_jobs_approval_id_idx
  ON public.jsw_post_jobs(approval_id) WHERE approval_id IS NOT NULL;

ALTER TABLE public.reachr_campaign_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reachr_campaign_approval_revocations ENABLE ROW LEVEL SECURITY;
CREATE POLICY reachr_approval_read ON public.reachr_campaign_approvals FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY reachr_approval_revocation_read ON public.reachr_campaign_approval_revocations FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.reachr_campaign_approvals a WHERE a.id = approval_id AND a.user_id = auth.uid()));
REVOKE ALL ON TABLE public.reachr_campaign_approvals, public.reachr_campaign_approval_revocations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.reachr_campaign_approvals, public.reachr_campaign_approval_revocations TO authenticated;

CREATE FUNCTION reachr_private.reject_approval_audit_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'approval audit records are immutable';
END $$;
REVOKE ALL ON FUNCTION reachr_private.reject_approval_audit_mutation() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER reachr_approval_immutable
  BEFORE UPDATE OR DELETE ON public.reachr_campaign_approvals
  FOR EACH ROW EXECUTE FUNCTION reachr_private.reject_approval_audit_mutation();
CREATE TRIGGER reachr_approval_revocation_immutable
  BEFORE UPDATE OR DELETE ON public.reachr_campaign_approval_revocations
  FOR EACH ROW EXECUTE FUNCTION reachr_private.reject_approval_audit_mutation();

CREATE OR REPLACE FUNCTION public.reachr_approve_campaign(
  p_schedule_id uuid, p_offer text, p_disclosures text, p_destination text, p_approver_name text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_user_id uuid := auth.uid(); v_approval_id uuid;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  -- The lock serializes approval/revocation with schedule admission.
  PERFORM 1 FROM public.reachr_campaign_schedules s
    WHERE s.id = p_schedule_id AND s.user_id = v_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'schedule not owned by authenticated user'; END IF;
  INSERT INTO public.reachr_campaign_approvals
    (schedule_id,user_id,message,image_url,first_comment,groups,offer,disclosures,destination,approver_name,approved_by)
  SELECT s.id,s.user_id,s.message,s.image_url,s.first_comment,s.groups,
    p_offer,p_disclosures,p_destination,p_approver_name,v_user_id
  FROM public.reachr_campaign_schedules s WHERE s.id=p_schedule_id
  RETURNING id INTO v_approval_id;
  RETURN v_approval_id;
END $$;
REVOKE ALL ON FUNCTION public.reachr_approve_campaign(uuid,text,text,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reachr_approve_campaign(uuid,text,text,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.reachr_revoke_campaign_approval(p_approval_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  PERFORM 1 FROM public.reachr_campaign_approvals a
    JOIN public.reachr_campaign_schedules s ON s.id=a.schedule_id
    WHERE a.id=p_approval_id AND a.user_id=v_user_id AND s.user_id=v_user_id FOR UPDATE OF s;
  IF NOT FOUND THEN RAISE EXCEPTION 'approval not owned by authenticated user'; END IF;
  INSERT INTO public.reachr_campaign_approval_revocations(approval_id,revoked_by,reason)
  VALUES(p_approval_id,v_user_id,p_reason);
END $$;
REVOKE ALL ON FUNCTION public.reachr_revoke_campaign_approval(uuid,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reachr_revoke_campaign_approval(uuid,text) TO authenticated;

CREATE OR REPLACE FUNCTION reachr_private.schedule_tick_at(p_now timestamptz)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE c public.reachr_campaign_schedules; oid uuid; jid uuid; aid uuid; admitted integer := 0; next_slot timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  FOR c IN SELECT s.* FROM public.reachr_campaign_schedules s
    WHERE s.user_id = auth.uid() AND s.enabled AND s.next_at <= p_now
      AND s.source_campaign_id IS NOT NULL
      AND (s.ends_at IS NULL OR (p_now <= s.ends_at AND s.next_at <= s.ends_at))
      AND (s.max_runs IS NULL OR s.fired_count < s.max_runs)
      AND NOT EXISTS (SELECT 1 FROM public.reachr_schedule_occurrences o JOIN public.jsw_post_jobs j ON j.id=o.job_id
        WHERE o.campaign_id=s.id AND j.status NOT IN ('done','cancelled','canceled'))
      -- Only the newest append-only approval can be current, and it must exactly
      -- match the server-side copy/creative/comment/targeting now being admitted.
      AND EXISTS (SELECT 1 FROM public.reachr_campaign_approvals a
        WHERE a.schedule_id=s.id
          AND a.id = (SELECT newest.id FROM public.reachr_campaign_approvals newest
            WHERE newest.schedule_id=s.id ORDER BY newest.approved_at DESC, newest.id DESC LIMIT 1)
          AND a.message IS NOT DISTINCT FROM s.message
          AND a.image_url IS NOT DISTINCT FROM s.image_url
          AND a.first_comment IS NOT DISTINCT FROM s.first_comment
          AND a.groups IS NOT DISTINCT FROM s.groups
          AND NOT EXISTS (SELECT 1 FROM public.reachr_campaign_approval_revocations r WHERE r.approval_id=a.id))
    ORDER BY s.next_at, s.id LIMIT 20 FOR UPDATE OF s SKIP LOCKED
  LOOP
    SELECT a.id INTO aid FROM public.reachr_campaign_approvals a
      WHERE a.schedule_id=c.id
        AND a.id = (SELECT newest.id FROM public.reachr_campaign_approvals newest
          WHERE newest.schedule_id=c.id ORDER BY newest.approved_at DESC, newest.id DESC LIMIT 1)
        AND a.message IS NOT DISTINCT FROM c.message
        AND a.image_url IS NOT DISTINCT FROM c.image_url
        AND a.first_comment IS NOT DISTINCT FROM c.first_comment
        AND a.groups IS NOT DISTINCT FROM c.groups
        AND NOT EXISTS (SELECT 1 FROM public.reachr_campaign_approval_revocations r WHERE r.approval_id=a.id);
    IF aid IS NULL THEN CONTINUE; END IF;
    SELECT ((c.next_at AT TIME ZONE c.timezone)::date + n + c.local_time) AT TIME ZONE c.timezone
      INTO next_slot FROM generate_series(1,7) n
      WHERE extract(dow FROM (c.next_at AT TIME ZONE c.timezone)::date + n)::integer = ANY(c.days)
      ORDER BY n LIMIT 1;
    oid := gen_random_uuid(); jid := gen_random_uuid();
    INSERT INTO public.jsw_post_jobs(id,user_id,message,image_url,groups,delay,ai_enabled,ai_prompt,first_comment,status,scheduled_for,identity_name,identity_key,identity_type,identity_url,occurrence_id,result,approval_id)
    VALUES(jid,c.user_id,c.message,c.image_url,c.groups,c.delay,c.ai_enabled,c.ai_prompt,c.first_comment,'pending',c.next_at,c.identity_name,c.identity_key,c.identity_type,c.identity_url,oid,jsonb_build_object('campaign_id',c.source_campaign_id),aid);
    INSERT INTO public.reachr_schedule_occurrences(id,campaign_id,scheduled_for,job_id) VALUES(oid,c.id,c.next_at,jid);
    UPDATE public.reachr_campaign_schedules SET next_at=next_slot, fired_count=fired_count+1 WHERE id=c.id;
    admitted := admitted + 1;
  END LOOP;
  RETURN admitted;
END $$;
REVOKE ALL ON FUNCTION reachr_private.schedule_tick_at(timestamptz) FROM PUBLIC, anon, authenticated, service_role;
COMMIT;
