-- Fail-closed throttle + concurrency guard for leaderboard refresh (backend
-- review 2026-07-04, edge-fn P0).
--
-- The 2026-06-21 meltdown mechanism: the refresh edge throttled on
-- snapshots.generated_at, which only advances on a SUCCESSFUL upsert. Once the
-- RPC started timing out, generated_at never moved, so the 30s throttle
-- permanently opened and every cron tick (plus any caller) re-ran the full
-- refresh concurrently, burying PostgREST. There was also no concurrency guard
-- at all — N simultaneous callers all passed the stale-generated_at check.
--
-- This replaces both with ONE atomic claim keyed on last_attempt_at, which
-- advances on EVERY attempt (success OR failure). A caller that can't claim
-- (another attempt within the window) skips. Single statement, so the row lock
-- on ON CONFLICT serializes concurrent callers — only one wins the window.
-- Time-based, so a crashed holder self-heals after the interval (no stale lock).
--
-- Idempotent. Rollback:
--   DROP FUNCTION leaderboard_refresh_try_claim(text, integer);
--   DROP TABLE tokentracker_leaderboard_refresh_lock;

CREATE TABLE IF NOT EXISTS public.tokentracker_leaderboard_refresh_lock (
  period text PRIMARY KEY,
  last_attempt_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.tokentracker_leaderboard_refresh_lock ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tokentracker_leaderboard_refresh_lock FROM anon, authenticated;
GRANT ALL ON public.tokentracker_leaderboard_refresh_lock TO project_admin;

-- Returns true if the caller claimed the window (proceed with refresh), or
-- NULL if another attempt landed within p_min_interval_s (skip). The edge
-- treats anything other than true as "skip", and treats an RPC ERROR as
-- fail-open (proceed) so a lock-infra fault can never freeze refreshes —
-- acceptable because the RPC is now fast (rollup fast path, issue #263).
CREATE OR REPLACE FUNCTION public.leaderboard_refresh_try_claim(
  p_period text,
  p_min_interval_s integer DEFAULT 30
) RETURNS boolean
LANGUAGE sql
SET statement_timeout TO '5s'
AS $func$
  INSERT INTO public.tokentracker_leaderboard_refresh_lock (period, last_attempt_at)
  VALUES (p_period, now())
  ON CONFLICT (period) DO UPDATE
    SET last_attempt_at = now()
    WHERE public.tokentracker_leaderboard_refresh_lock.last_attempt_at
          < now() - make_interval(secs => p_min_interval_s)
  RETURNING true;
$func$;
