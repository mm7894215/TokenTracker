-- Incremental "total" leaderboard aggregation (issue #263).
--
-- Problem: leaderboard_usage_grouped re-deduped the ENTIRE tokentracker_hourly
-- history on every total refresh. At 739k rows that scan takes ~24s — past the
-- InsForge SDK's 10s HTTP timeout (edge runtime updated ~2026-06-24), so every
-- hourly total refresh 500'd at rpc_aggregate and the total snapshot froze at
-- 2026-06-24 (issue #263). week/month ranges are small and still worked.
--
-- Fix (pure DB layer — no edge redeploy, mirrors the 2026-06-21 remediation):
--   1. tokentracker_leaderboard_rollup_daily — the SAME two-class cross-device
--      dedup (issue #187) pre-aggregated per (user, source, model, UTC day).
--   2. leaderboard_rollup_daily_rebuild() — full rebuild up to today's UTC
--      midnight, run ONCE nightly off-peak by pg_cron (job name
--      tokentracker-leaderboard-rollup-rebuild, '47 19 * * *' UTC = 03:47
--      Beijing). Full rebuild, not incremental deltas: dedup picks can change
--      retroactively (device revocation, history replay), so any drift
--      self-heals within 24h.
--   3. leaderboard_usage_grouped keeps its signature but gains a fast path:
--      a total-range call returns rollup sums + a live-deduped tail covering
--      [watermark, p_to) — ≤2 days of hourly rows, ~1-2s, far under every
--      timeout. week/month/custom ranges keep the exact live scan.
--
-- Correctness: dedup granularity is the (user, source, model, hour_start)
-- bucket and the watermark sits on a UTC midnight, so no bucket ever spans the
-- base/tail cut — base + tail is EXACTLY equivalent to the full-range scan
-- (modulo ≤24h revocation/replay drift in base, healed by the nightly rebuild).
--
-- leaderboard_hourly_dedup() is the single source of truth for the two-class
-- semantic; both the rebuild and the RPC consume it. The account-level source
-- list MUST stay in sync with ACCOUNT_LEVEL_SOURCES in
-- src/lib/source-metadata.js and account_usage_grouped
-- (test/account-source-parity.test.js).
--
-- NOTE: scripts/ops/leaderboard-usage-grouped-rpc.sql contains the PREVIOUS
-- full-scan definition of leaderboard_usage_grouped — re-applying that file
-- would revert this fix. This file supersedes it.
--
-- Idempotent. Rollback: re-apply leaderboard-usage-grouped-rpc.sql, then
--   SELECT cron.unschedule('tokentracker-leaderboard-rollup-rebuild');
--   DROP FUNCTION leaderboard_rollup_daily_rebuild();
--   DROP FUNCTION leaderboard_hourly_dedup(timestamptz, timestamptz);
--   DROP TABLE tokentracker_leaderboard_rollup_daily, tokentracker_leaderboard_rollup_meta;

-- ── 1. Rollup table + watermark ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tokentracker_leaderboard_rollup_daily (
  user_id uuid NOT NULL,
  source text NOT NULL,
  model text NOT NULL,
  day date NOT NULL,
  total_tokens bigint NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cached_input_tokens bigint NOT NULL DEFAULT 0,
  cache_creation_input_tokens bigint NOT NULL DEFAULT 0,
  reasoning_output_tokens bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, source, model, day)
);

CREATE TABLE IF NOT EXISTS public.tokentracker_leaderboard_rollup_meta (
  id int PRIMARY KEY CHECK (id = 1),
  -- Rollup covers hour_start < through (a UTC midnight). The RPC's live tail
  -- starts here.
  through timestamptz NOT NULL,
  rebuilt_at timestamptz NOT NULL DEFAULT now()
);

-- Same security model as tokentracker_leaderboard_snapshots / _hourly:
-- RLS on, zero policies (only project_admin/superuser reach it — the tables
-- are internal, never read by anon PostgREST clients).
ALTER TABLE public.tokentracker_leaderboard_rollup_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokentracker_leaderboard_rollup_meta ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.tokentracker_leaderboard_rollup_daily TO project_admin;
GRANT ALL ON public.tokentracker_leaderboard_rollup_meta TO project_admin;
-- InsForge auto-grants anon/authenticated CRUD on new public tables; RLS
-- backstops but the deny-all baseline wants the grants gone too. Revoke so a
-- rebuild doesn't leave the grant layer open (2026-07-04 hygiene sweep).
REVOKE ALL ON public.tokentracker_leaderboard_rollup_daily FROM anon, authenticated;
REVOKE ALL ON public.tokentracker_leaderboard_rollup_meta FROM anon, authenticated;

-- Narrow range index for the live tail ([watermark, now) is 1-2 days of rows;
-- without it the "fast" path still seq-scans all of tokentracker_hourly).
CREATE INDEX IF NOT EXISTS tokentracker_hourly_hour_start_idx
  ON public.tokentracker_hourly (hour_start);

-- ── 2. Shared two-class dedup (single source of truth) ──────────────────────
-- Verbatim rows_hg from the previous leaderboard_usage_grouped, parameterized.
-- Plain SQL, no SET clauses, so the planner can inline it at each call site;
-- work_mem/timeouts live on the callers.

CREATE OR REPLACE FUNCTION public.leaderboard_hourly_dedup(
  p_from timestamptz,
  p_to timestamptz
) RETURNS TABLE (
  user_id uuid,
  source text,
  model text,
  hour_start timestamptz,
  total_tokens bigint,
  input_tokens bigint,
  output_tokens bigint,
  cached_input_tokens bigint,
  cache_creation_input_tokens bigint,
  reasoning_output_tokens bigint
)
LANGUAGE sql STABLE
AS $func$
  WITH cfg AS (
    -- Keep in sync with src/lib/source-metadata.js ACCOUNT_LEVEL_SOURCES.
    SELECT ARRAY['cursor']::text[] AS account_sources
  )
  -- Machine-level: ONE canonical whole row per (user, source, model, hour)
  -- across the user's ACTIVE devices, largest total_tokens wins (issue #187).
  SELECT mac.user_id, mac.source, mac.model, mac.hour_start,
    mac.total_tokens, mac.input_tokens, mac.output_tokens,
    mac.cached_input_tokens, mac.cache_creation_input_tokens, mac.reasoning_output_tokens
  FROM (
    SELECT DISTINCT ON (h.user_id, h.source, h.model, h.hour_start)
      h.user_id, h.source, h.model, h.hour_start,
      h.total_tokens::bigint                AS total_tokens,
      h.input_tokens::bigint                AS input_tokens,
      h.output_tokens::bigint               AS output_tokens,
      h.cached_input_tokens::bigint         AS cached_input_tokens,
      h.cache_creation_input_tokens::bigint AS cache_creation_input_tokens,
      h.reasoning_output_tokens::bigint     AS reasoning_output_tokens
    FROM tokentracker_hourly h
    CROSS JOIN cfg
    JOIN tokentracker_devices d
      ON d.id = h.device_id AND d.revoked_at IS NULL
    WHERE h.hour_start >= p_from AND h.hour_start < p_to
      AND NOT (h.source = ANY(cfg.account_sources))
    ORDER BY h.user_id, h.source, h.model, h.hour_start, h.total_tokens DESC, h.updated_at DESC
  ) mac

  UNION ALL

  -- Account-level (cursor): ONE canonical whole row per (user, source, model,
  -- hour) across ALL devices — device-independent cloud data, not active-filtered.
  SELECT acct.user_id, acct.source, acct.model, acct.hour_start,
    acct.total_tokens, acct.input_tokens, acct.output_tokens,
    acct.cached_input_tokens, acct.cache_creation_input_tokens, acct.reasoning_output_tokens
  FROM (
    SELECT DISTINCT ON (h.user_id, h.source, h.model, h.hour_start)
      h.user_id, h.source, h.model, h.hour_start,
      h.total_tokens::bigint                AS total_tokens,
      h.input_tokens::bigint                AS input_tokens,
      h.output_tokens::bigint               AS output_tokens,
      h.cached_input_tokens::bigint         AS cached_input_tokens,
      h.cache_creation_input_tokens::bigint AS cache_creation_input_tokens,
      h.reasoning_output_tokens::bigint     AS reasoning_output_tokens
    FROM tokentracker_hourly h CROSS JOIN cfg
    WHERE h.hour_start >= p_from AND h.hour_start < p_to
      AND h.source = ANY(cfg.account_sources)
    ORDER BY h.user_id, h.source, h.model, h.hour_start, h.total_tokens DESC, h.updated_at DESC
  ) acct
$func$;

-- ── 3. Nightly rebuild ───────────────────────────────────────────────────────
-- The one remaining whole-history scan (~24s at 739k rows), now 1×/day at
-- 03:47 Beijing instead of 24×/day on the hot path. 96MB work_mem per the
-- 2026-06-21 remediation (256MB × concurrency was a meltdown amplifier).

CREATE OR REPLACE FUNCTION public.leaderboard_rollup_daily_rebuild()
RETURNS void
LANGUAGE plpgsql
SET work_mem TO '96MB'
SET hash_mem_multiplier TO '4'
SET statement_timeout TO '180s'
AS $func$
DECLARE
  v_through timestamptz := date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
BEGIN
  -- Single transaction: RPC readers keep a consistent MVCC snapshot during
  -- the swap; there is no window where the table is empty.
  DELETE FROM tokentracker_leaderboard_rollup_daily;
  INSERT INTO tokentracker_leaderboard_rollup_daily (
    user_id, source, model, day,
    total_tokens, input_tokens, output_tokens,
    cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens
  )
  SELECT
    d.user_id, d.source, d.model,
    (d.hour_start AT TIME ZONE 'UTC')::date AS day,
    SUM(d.total_tokens), SUM(d.input_tokens), SUM(d.output_tokens),
    SUM(d.cached_input_tokens), SUM(d.cache_creation_input_tokens), SUM(d.reasoning_output_tokens)
  FROM leaderboard_hourly_dedup('-infinity'::timestamptz, v_through) d
  GROUP BY d.user_id, d.source, d.model, (d.hour_start AT TIME ZONE 'UTC')::date;

  INSERT INTO tokentracker_leaderboard_rollup_meta (id, through, rebuilt_at)
  VALUES (1, v_through, now())
  ON CONFLICT (id) DO UPDATE SET through = EXCLUDED.through, rebuilt_at = EXCLUDED.rebuilt_at;
END
$func$;

-- ── 4. RPC: same signature, fast total path ──────────────────────────────────
-- Total calls (p_from is the 1970 sentinel) merge the rollup with a live tail;
-- everything else (week/month/custom) keeps the exact live scan. If rebuilds
-- ever stop, the tail range just grows — the path degrades gradually instead
-- of hitting a timeout cliff.

CREATE OR REPLACE FUNCTION public.leaderboard_usage_grouped(
  p_from timestamptz,
  p_to timestamptz
) RETURNS jsonb
LANGUAGE plpgsql STABLE
SET work_mem TO '96MB'
SET hash_mem_multiplier TO '4'
SET statement_timeout TO '25s'
AS $func$
DECLARE
  v_through timestamptz;
  v_result jsonb;
BEGIN
  SELECT m.through INTO v_through
  FROM tokentracker_leaderboard_rollup_meta m
  WHERE m.id = 1;

  IF v_through IS NOT NULL AND p_from < '1980-01-01'::timestamptz AND p_to >= v_through THEN
    SELECT jsonb_agg(to_jsonb(per_usm.*) ORDER BY per_usm.user_id, per_usm.source, per_usm.model)
    INTO v_result
    FROM (
      SELECT
        u.user_id, u.source, u.model,
        SUM(u.total_tokens)::bigint                AS total_tokens,
        SUM(u.input_tokens)::bigint                AS input_tokens,
        SUM(u.output_tokens)::bigint               AS output_tokens,
        SUM(u.cached_input_tokens)::bigint         AS cached_input_tokens,
        SUM(u.cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
        SUM(u.reasoning_output_tokens)::bigint     AS reasoning_output_tokens
      FROM (
        SELECT r.user_id, r.source, r.model,
          r.total_tokens, r.input_tokens, r.output_tokens,
          r.cached_input_tokens, r.cache_creation_input_tokens, r.reasoning_output_tokens
        FROM tokentracker_leaderboard_rollup_daily r
        UNION ALL
        SELECT t.user_id, t.source, t.model,
          t.total_tokens, t.input_tokens, t.output_tokens,
          t.cached_input_tokens, t.cache_creation_input_tokens, t.reasoning_output_tokens
        FROM leaderboard_hourly_dedup(v_through, p_to) t
      ) u
      GROUP BY u.user_id, u.source, u.model
    ) per_usm;
  ELSE
    SELECT jsonb_agg(to_jsonb(per_usm.*) ORDER BY per_usm.user_id, per_usm.source, per_usm.model)
    INTO v_result
    FROM (
      SELECT
        d.user_id, d.source, d.model,
        SUM(d.total_tokens)::bigint                AS total_tokens,
        SUM(d.input_tokens)::bigint                AS input_tokens,
        SUM(d.output_tokens)::bigint               AS output_tokens,
        SUM(d.cached_input_tokens)::bigint         AS cached_input_tokens,
        SUM(d.cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
        SUM(d.reasoning_output_tokens)::bigint     AS reasoning_output_tokens
      FROM leaderboard_hourly_dedup(p_from, p_to) d
      GROUP BY d.user_id, d.source, d.model
    ) per_usm;
  END IF;

  RETURN COALESCE(v_result, '[]'::jsonb);
END
$func$;

-- ── 5. Schedule (run once via CLI after applying the above) ──────────────────
-- SELECT cron.schedule(
--   'tokentracker-leaderboard-rollup-rebuild',
--   '47 19 * * *',
--   'SELECT public.leaderboard_rollup_daily_rebuild()'
-- );
