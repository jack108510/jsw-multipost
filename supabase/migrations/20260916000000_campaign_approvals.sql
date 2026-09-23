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
  identity_name text NOT NULL,
  identity_key text NOT NULL,
  identity_type text,
  identity_url text,
  delay integer NOT NULL,
  ai_enabled boolean NOT NULL,
  ai_prompt text,
  timezone text NOT NULL,
  local_time time NOT NULL,
  days integer[] NOT NULL,
  max_runs integer,
  ends_at timestamptz,
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
    (schedule_id,user_id,message,image_url,first_comment,groups,identity_name,identity_key,identity_type,identity_url,delay,ai_enabled,ai_prompt,timezone,local_time,days,max_runs,ends_at,offer,disclosures,destination,approver_name,approved_by)
  SELECT s.id,s.user_id,s.message,s.image_url,s.first_comment,s.groups,
    s.identity_name,s.identity_key,s.identity_type,s.identity_url,s.delay,s.ai_enabled,s.ai_prompt,s.timezone,s.local_time,s.days,s.max_runs,s.ends_at,
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
DECLARE c public.reachr_campaign_schedules; oid uuid; jid uuid; aid uuid; run_id uuid; admitted integer := 0;
  next_slot timestamptz; batch_number integer; batch_count integer; batch_groups jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  -- A worker that was offline should not publish an old campaign unexpectedly.
  -- Move missed slots forward and leave a count for the dashboard to display.
  UPDATE public.reachr_campaign_schedules s SET
    next_at = (
      SELECT candidate.at_time FROM generate_series(0,366) n
      CROSS JOIN LATERAL (SELECT (((p_now AT TIME ZONE s.timezone)::date + n + s.local_time)
        AT TIME ZONE s.timezone) AS at_time) candidate
      WHERE extract(dow FROM ((p_now AT TIME ZONE s.timezone)::date + n))::integer = ANY(s.days)
        AND candidate.at_time > p_now
      ORDER BY candidate.at_time LIMIT 1
    ),
    missed_count = s.missed_count + 1,
    updated_at = p_now
  WHERE s.user_id = auth.uid() AND s.enabled AND s.next_at < p_now - interval '15 minutes';
  UPDATE public.reachr_campaign_schedules s SET status='paused', enabled=false, updated_at=p_now
  WHERE s.user_id=auth.uid() AND s.enabled AND
    ((s.ends_at IS NOT NULL AND (p_now > s.ends_at OR s.next_at > s.ends_at))
      OR (s.max_runs IS NOT NULL AND s.fired_count >= s.max_runs));
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
          AND a.identity_name IS NOT DISTINCT FROM s.identity_name
          AND a.identity_key IS NOT DISTINCT FROM s.identity_key
          AND a.identity_type IS NOT DISTINCT FROM s.identity_type
          AND a.identity_url IS NOT DISTINCT FROM s.identity_url
          AND a.delay IS NOT DISTINCT FROM s.delay
          AND a.ai_enabled IS NOT DISTINCT FROM s.ai_enabled
          AND a.ai_prompt IS NOT DISTINCT FROM s.ai_prompt
          AND a.timezone IS NOT DISTINCT FROM s.timezone
          AND a.local_time IS NOT DISTINCT FROM s.local_time
          AND a.days IS NOT DISTINCT FROM s.days
          AND a.max_runs IS NOT DISTINCT FROM s.max_runs
          AND a.ends_at IS NOT DISTINCT FROM s.ends_at
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
        AND a.identity_name IS NOT DISTINCT FROM c.identity_name
        AND a.identity_key IS NOT DISTINCT FROM c.identity_key
        AND a.identity_type IS NOT DISTINCT FROM c.identity_type
        AND a.identity_url IS NOT DISTINCT FROM c.identity_url
        AND a.delay IS NOT DISTINCT FROM c.delay
        AND a.ai_enabled IS NOT DISTINCT FROM c.ai_enabled
        AND a.ai_prompt IS NOT DISTINCT FROM c.ai_prompt
        AND a.timezone IS NOT DISTINCT FROM c.timezone
        AND a.local_time IS NOT DISTINCT FROM c.local_time
        AND a.days IS NOT DISTINCT FROM c.days
        AND a.max_runs IS NOT DISTINCT FROM c.max_runs
        AND a.ends_at IS NOT DISTINCT FROM c.ends_at
        AND NOT EXISTS (SELECT 1 FROM public.reachr_campaign_approval_revocations r WHERE r.approval_id=a.id);
    IF aid IS NULL THEN CONTINUE; END IF;
    SELECT ((c.next_at AT TIME ZONE c.timezone)::date + n + c.local_time) AT TIME ZONE c.timezone
      INTO next_slot FROM generate_series(1,366) n
      WHERE extract(dow FROM ((c.next_at AT TIME ZONE c.timezone)::date + n))::integer = ANY(c.days)
      ORDER BY n LIMIT 1;
    batch_count := ceil(jsonb_array_length(c.groups)::numeric / 8)::integer;
    run_id := gen_random_uuid();
    FOR batch_number IN 1..batch_count LOOP
      SELECT jsonb_agg(item.value ORDER BY item.ordinality) INTO batch_groups
      FROM jsonb_array_elements(c.groups) WITH ORDINALITY AS item(value, ordinality)
      WHERE item.ordinality > (batch_number - 1) * 8 AND item.ordinality <= batch_number * 8;
      oid := gen_random_uuid(); jid := gen_random_uuid();
      INSERT INTO public.jsw_post_jobs(id,user_id,message,image_url,groups,delay,ai_enabled,ai_prompt,first_comment,status,scheduled_for,identity_name,identity_key,identity_type,identity_url,occurrence_id,result,approval_id)
      VALUES(jid,c.user_id,c.message,c.image_url,batch_groups,c.delay,c.ai_enabled,c.ai_prompt,c.first_comment,'pending',c.next_at,c.identity_name,c.identity_key,c.identity_type,c.identity_url,oid,
        jsonb_build_object('campaign_id',c.source_campaign_id,'run_id',run_id,'batch_index',batch_number,'batch_count',batch_count,'total_target_count',jsonb_array_length(c.groups)),aid);
      INSERT INTO public.reachr_schedule_occurrences(id,campaign_id,scheduled_for,batch_index,job_id)
      VALUES(oid,c.id,c.next_at,batch_number,jid);
    END LOOP;
    UPDATE public.reachr_campaign_schedules SET next_at=next_slot, fired_count=fired_count+1,
      enabled = CASE WHEN (c.max_runs IS NOT NULL AND c.fired_count + 1 >= c.max_runs)
        OR (c.ends_at IS NOT NULL AND next_slot > c.ends_at) THEN false ELSE true END,
      status = CASE WHEN (c.max_runs IS NOT NULL AND c.fired_count + 1 >= c.max_runs)
        OR (c.ends_at IS NOT NULL AND next_slot > c.ends_at) THEN 'paused' ELSE 'active' END,
      updated_at=p_now WHERE id=c.id;
    admitted := admitted + 1;
  END LOOP;
  RETURN admitted;
END $$;
REVOKE ALL ON FUNCTION reachr_private.schedule_tick_at(timestamptz) FROM PUBLIC, anon, authenticated, service_role;
COMMIT;
