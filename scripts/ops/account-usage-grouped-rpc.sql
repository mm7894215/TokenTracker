-- Server-side aggregation for the cross-device account view.
--
-- Motivation: each tokentracker-account-* edge function used to fetch raw
-- tokentracker_hourly rows in 1000-row PostgREST pages and aggregate them in
-- the edge. Measured cost is ~300-600ms PER 1000-row page (PostgREST round-trip
-- + JSON serialization of 1000 rows), NOT the DB scan (which is ~7ms, indexed).
-- A heavy user's 52-week heatmap spanned ~7 pages (~3.2s) and every other
-- account-* function re-paginated its own range on top of that.
--
-- This function does the GROUP BY in Postgres and returns a SINGLE jsonb row
-- (jsonb_agg), which sidesteps PostgREST's 1000-row response cap entirely: one
-- round-trip, no pagination. The heaviest real user's 52-week heatmap dropped
-- from ~3.2s to ~137ms (827 grouped rows). SUM across the user's active devices
-- is byte-identical to the old in-edge aggregation; tz-local bucketing uses
-- `AT TIME ZONE` (same IANA tz database as the old JS Intl.DateTimeFormat path,
-- including DST — verified against the old functions across Asia/Shanghai,
-- America/New_York spanning a spring-forward, and a fixed UTC offset).
--
-- SECURITY INVOKER (the default): runs with the caller's privileges, so it
-- never exposes more than a direct SELECT on tokentracker_hourly would. The
-- edge functions call it with the service-role token AFTER verifying the user's
-- JWT and resolving p_user_id / p_device_ids server-side.
--
-- p_trunc: 'hour' | 'day' | 'month' | 'none' (none = group by source+model only)
-- p_tz:    IANA zone (e.g. 'Asia/Shanghai') or NULL
-- p_offset_min: fallback minutes east of UTC when p_tz is NULL (monthly passes
--               both NULL to bucket by UTC, matching the old hour_start slice).
--
-- Idempotent (CREATE OR REPLACE). Rollback: DROP FUNCTION account_usage_grouped.

CREATE OR REPLACE FUNCTION account_usage_grouped(
  p_user_id uuid,
  p_device_ids uuid[],
  p_from timestamptz,
  p_to timestamptz,
  p_trunc text,
  p_tz text,
  p_offset_min int
) RETURNS jsonb
LANGUAGE sql STABLE
AS $func$
  WITH loc AS (
    SELECT
      CASE
        WHEN p_tz IS NOT NULL AND p_tz <> '' THEN (h.hour_start AT TIME ZONE p_tz)
        WHEN p_offset_min IS NOT NULL THEN ((h.hour_start AT TIME ZONE 'UTC') + make_interval(mins => p_offset_min))
        ELSE (h.hour_start AT TIME ZONE 'UTC')
      END AS local_ts,
      h.source, h.model,
      h.total_tokens, h.input_tokens, h.output_tokens,
      h.cached_input_tokens, h.cache_creation_input_tokens,
      h.reasoning_output_tokens, h.conversations
    FROM tokentracker_hourly h
    WHERE h.user_id = p_user_id
      AND h.device_id = ANY(p_device_ids)
      AND h.hour_start >= p_from
      AND h.hour_start <  p_to
  ),
  grouped AS (
    SELECT
      CASE p_trunc
        WHEN 'hour'  THEN to_char(date_trunc('hour',  local_ts), 'YYYY-MM-DD"T"HH24:00:00')
        WHEN 'day'   THEN to_char(date_trunc('day',   local_ts), 'YYYY-MM-DD')
        WHEN 'month' THEN to_char(date_trunc('month', local_ts), 'YYYY-MM')
        ELSE ''
      END AS bucket,
      source, model,
      SUM(total_tokens)::bigint                AS total_tokens,
      SUM(input_tokens)::bigint                AS input_tokens,
      SUM(output_tokens)::bigint               AS output_tokens,
      SUM(cached_input_tokens)::bigint         AS cached_input_tokens,
      SUM(cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
      SUM(reasoning_output_tokens)::bigint     AS reasoning_output_tokens,
      SUM(conversations)::bigint               AS conversations
    FROM loc
    GROUP BY 1, source, model
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(grouped.*)), '[]'::jsonb) FROM grouped
$func$;
