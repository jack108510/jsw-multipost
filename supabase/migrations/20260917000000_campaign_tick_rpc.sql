-- The paired extension invokes this with the signed-in account JWT. The
-- private function admits only campaigns with a current approval snapshot.
BEGIN;

CREATE FUNCTION public.reachr_schedule_tick_approved()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  RETURN reachr_private.schedule_tick_at(clock_timestamp());
END $$;
REVOKE ALL ON FUNCTION public.reachr_schedule_tick_approved() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reachr_schedule_tick_approved() TO authenticated;

-- Existing workers may still call the old RPC. Route it through the same
-- approval gate so upgrading the database cannot leave an unsafe path open.
CREATE OR REPLACE FUNCTION public.reachr_schedule_tick()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  RETURN reachr_private.schedule_tick_at(clock_timestamp());
END $$;
REVOKE ALL ON FUNCTION public.reachr_schedule_tick() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reachr_schedule_tick() TO authenticated;

COMMIT;
