-- Leaderboard snapshot retention (backend review 2026-07-04).
--
-- tokentracker_leaderboard_snapshots grew unbounded: the refresh job writes a
-- fresh (from_day, to_day) window every run and nothing ever pruned the old
-- ones (86 total-period windows / 17.6k rows, oldest 2026-03-29). The read
-- path (tokentracker-leaderboard.ts) only ever queries the CURRENT window:
--   * week/month  -> the window it computes for "now"
--   * total       -> the row with MAX(to_day)
-- so every window except the newest per period is dead weight.
--
-- Keep the newest 3 windows per period (read path needs 1; 3 is slack for a
-- window boundary crossing mid-refresh). dense_rank on to_day DESC guarantees
-- the active window (rank 1) is always retained.
--
-- Idempotent. Rollback:
--   SELECT cron.unschedule('tokentracker-leaderboard-snapshot-retention');
--   DROP FUNCTION leaderboard_snapshots_prune(integer);

CREATE OR REPLACE FUNCTION public.leaderboard_snapshots_prune(p_keep integer DEFAULT 3)
RETURNS bigint
LANGUAGE plpgsql
SET statement_timeout TO '30s'
AS $func$
DECLARE
  v_deleted bigint;
BEGIN
  WITH ranked AS (
    SELECT ctid,
           dense_rank() OVER (PARTITION BY period ORDER BY to_day DESC) AS rnk
    FROM tokentracker_leaderboard_snapshots
  )
  DELETE FROM tokentracker_leaderboard_snapshots s
  USING ranked r
  WHERE s.ctid = r.ctid AND r.rnk > p_keep;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$func$;

-- Daily at 04:12 UTC (12:12 Beijing), off the refresh cadence.
-- SELECT cron.schedule(
--   'tokentracker-leaderboard-snapshot-retention',
--   '12 4 * * *',
--   'SELECT public.leaderboard_snapshots_prune(3)'
-- );
