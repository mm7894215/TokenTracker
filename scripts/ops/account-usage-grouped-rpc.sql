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
-- from ~3.2s to ~137ms server-side. tz-local bucketing uses `AT TIME ZONE`
-- (same IANA tz database as the old JS Intl.DateTimeFormat path, including DST
-- — verified against the old functions across Asia/Shanghai, America/New_York
-- spanning a spring-forward, and a fixed UTC offset).
--
-- CROSS-DEVICE SEMANTIC (GitHub Discussion #101) — two source classes:
--   * MACHINE-LEVEL sources (claude/codex/gemini/...) come from each machine's
--     LOCAL logs. Two real machines do independent work, so they must add up:
--     SUM across the user's ACTIVE devices.
--   * ACCOUNT-LEVEL sources (cursor) come from a per-ACCOUNT cloud API, NOT
--     machine logs. Every device that syncs them stores an IDENTICAL copy, so
--     SUMming across devices multiplies one account's usage by its device
--     count (the v0.42.0 bug: a 2-machine user's Cursor total was double). For
--     these, pick ONE canonical row per (hour, source, model) across ALL the
--     user's devices — dedup, do not add.
-- The account-level source list MUST stay in sync with ACCOUNT_LEVEL_SOURCES in
-- src/lib/source-metadata.js (parity asserted by test/account-source-parity.test.js).
--
-- Whole-row (not per-column MAX) canonical pick: a per-column MAX would synth a
-- row that never existed and inflate cost, which is derived from the individual
-- token columns (src/lib/pricing computeRowCost), not total_tokens. DISTINCT ON
-- keeps the columns of one real row internally consistent.
--
-- Hour-grain dedup BEFORE tz bucketing: account-level data is per-hour, so the
-- canonical pick happens at the raw hour_start grain; only then is it truncated
-- to the tz-local hour/day/month. Deduping at a coarser (e.g. daily) bucket
-- would collapse many real hours into one and under-count.
--
-- SECURITY INVOKER (the default): runs with the caller's privileges, so it
-- never exposes more than a direct SELECT on tokentracker_hourly would. The
-- edge functions call it with the service-role token AFTER verifying the user's
-- JWT and resolving p_user_id / p_device_ids server-side.
--
-- Determinism (Codex review): jsonb_agg is ordered by (bucket, source, model)
-- so the array — and therefore the model-breakdown `sources` ordering and the
-- per-bucket `models` object key order built in the edge — is stable across
-- query plans, mirroring the old `.order("hour_start")` behavior.
--
-- Invalid timezone (Codex review): an unrecognized p_tz would make
-- `AT TIME ZONE p_tz` raise and 500 the endpoint. The old JS caught the
-- Intl.DateTimeFormat throw and fell back to the offset. The tzr CTE validates
-- p_tz against pg_timezone_names once; an unknown zone falls back to
-- p_offset_min, then UTC — matching the old precedence.
--
-- p_trunc: 'hour' | 'day' | 'month' | 'none' (none = group by source+model only)
-- p_tz:    IANA zone (e.g. 'Asia/Shanghai') or NULL
-- p_offset_min: fallback minutes east of UTC when p_tz is NULL/invalid (monthly
--               passes both NULL to bucket by UTC, matching the old slice).
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
  WITH tzr AS (
    -- Validate p_tz once; fall back to offset/UTC on an unknown zone instead of
    -- raising (mirrors the old JS Intl.DateTimeFormat try/catch fallback).
    SELECT CASE
             WHEN p_tz IS NOT NULL AND p_tz <> ''
                  AND EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_tz)
             THEN p_tz
             ELSE NULL
           END AS tz
  ),
  -- Account-level source list — keep in sync with src/lib/source-metadata.js.
  cfg AS (
    SELECT ARRAY['cursor']::text[] AS account_sources
  ),
  -- Stage 1: canonicalize to the raw hour grain.
  hourly AS (
    -- Machine-level: SUM across the user's ACTIVE devices.
    SELECT h.hour_start, h.source, h.model,
      SUM(h.total_tokens)::bigint                AS total_tokens,
      SUM(h.input_tokens)::bigint                AS input_tokens,
      SUM(h.output_tokens)::bigint               AS output_tokens,
      SUM(h.cached_input_tokens)::bigint         AS cached_input_tokens,
      SUM(h.cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
      SUM(h.reasoning_output_tokens)::bigint     AS reasoning_output_tokens,
      SUM(h.conversations)::bigint               AS conversations
    FROM tokentracker_hourly h CROSS JOIN cfg
    WHERE h.user_id = p_user_id
      AND h.hour_start >= p_from
      AND h.hour_start <  p_to
      AND NOT (h.source = ANY(cfg.account_sources))
      AND h.device_id = ANY(p_device_ids)
    GROUP BY h.hour_start, h.source, h.model

    UNION ALL

    -- Account-level: ONE canonical whole row per (hour, source, model) across
    -- ALL devices (NOT active-filtered — the data is device-independent and an
    -- active-only filter would drop it if last synced by a since-revoked one).
    SELECT acct.hour_start, acct.source, acct.model,
      acct.total_tokens, acct.input_tokens, acct.output_tokens,
      acct.cached_input_tokens, acct.cache_creation_input_tokens,
      acct.reasoning_output_tokens, acct.conversations
    FROM (
      SELECT DISTINCT ON (h.hour_start, h.source, h.model)
        h.hour_start, h.source, h.model,
        h.total_tokens::bigint                AS total_tokens,
        h.input_tokens::bigint                AS input_tokens,
        h.output_tokens::bigint               AS output_tokens,
        h.cached_input_tokens::bigint         AS cached_input_tokens,
        h.cache_creation_input_tokens::bigint AS cache_creation_input_tokens,
        h.reasoning_output_tokens::bigint     AS reasoning_output_tokens,
        h.conversations::bigint               AS conversations
      FROM tokentracker_hourly h CROSS JOIN cfg
      WHERE h.user_id = p_user_id
        AND h.hour_start >= p_from
        AND h.hour_start <  p_to
        AND h.source = ANY(cfg.account_sources)
      ORDER BY h.hour_start, h.source, h.model, h.total_tokens DESC, h.updated_at DESC
    ) acct
  ),
  -- Stage 2: bucket the canonical hour rows to tz-local trunc, then aggregate.
  loc AS (
    SELECT
      CASE p_trunc
        WHEN 'hour'  THEN to_char(date_trunc('hour',  lt.local_ts), 'YYYY-MM-DD"T"HH24:00:00')
        WHEN 'day'   THEN to_char(date_trunc('day',   lt.local_ts), 'YYYY-MM-DD')
        WHEN 'month' THEN to_char(date_trunc('month', lt.local_ts), 'YYYY-MM')
        ELSE ''
      END AS bucket,
      hourly.source, hourly.model,
      hourly.total_tokens, hourly.input_tokens, hourly.output_tokens,
      hourly.cached_input_tokens, hourly.cache_creation_input_tokens,
      hourly.reasoning_output_tokens, hourly.conversations
    FROM hourly CROSS JOIN tzr
    CROSS JOIN LATERAL (
      SELECT CASE
               WHEN tzr.tz IS NOT NULL THEN (hourly.hour_start AT TIME ZONE tzr.tz)
               WHEN p_offset_min IS NOT NULL THEN ((hourly.hour_start AT TIME ZONE 'UTC') + make_interval(mins => p_offset_min))
               ELSE (hourly.hour_start AT TIME ZONE 'UTC')
             END AS local_ts
    ) lt
  ),
  grouped AS (
    SELECT
      bucket, source, model,
      SUM(total_tokens)::bigint                AS total_tokens,
      SUM(input_tokens)::bigint                AS input_tokens,
      SUM(output_tokens)::bigint               AS output_tokens,
      SUM(cached_input_tokens)::bigint         AS cached_input_tokens,
      SUM(cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
      SUM(reasoning_output_tokens)::bigint     AS reasoning_output_tokens,
      SUM(conversations)::bigint               AS conversations
    FROM loc
    GROUP BY bucket, source, model
  )
  SELECT COALESCE(
           jsonb_agg(to_jsonb(grouped.*) ORDER BY grouped.bucket, grouped.source, grouped.model),
           '[]'::jsonb
         )
  FROM grouped
$func$;
