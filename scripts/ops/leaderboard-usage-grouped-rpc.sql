-- ⚠️ SUPERSEDED (2026-07-04, issue #263): leaderboard-rollup-daily.sql replaces
-- this definition with a rollup-backed fast path for the total period.
-- Re-applying THIS file reverts prod to the full-scan version that times out
-- (>10s SDK limit). Kept only as rollback reference.
--
-- Server-side aggregation for the leaderboard refresh job (ALL users at once).
--
-- Motivation: tokentracker-leaderboard-refresh used to fetch raw
-- tokentracker_hourly rows in 1000-row PostgREST pages and aggregate them in
-- the edge. For the "total" period that scans EVERY user's ENTIRE history —
-- millions of rows — which exceeds the edge function's execution budget once
-- data grows (the leaderboard-refresh-total-6h schedule had been 500-ing in
-- ~5s for weeks; a manual invoke 504s at the 30s gateway). This RPC does the
-- whole scan + GROUP BY in Postgres (~seconds) and returns ONE jsonb array of
-- pre-aggregated {user_id, source, model, ...tokens} objects; the edge then
-- only derives cost (computeRowCost) and per-source snapshot columns in JS.
--
-- Returns jsonb (NOT SETOF): a SETOF result is capped by PostgREST's db-max-rows
-- (would silently truncate the leaderboard); jsonb_agg returns the full set in
-- one row, exactly like account_usage_grouped.
--
-- TWO-CLASS cross-device semantic (identical to account_usage_grouped):
--   * MACHINE-LEVEL sources (claude/codex/...): pick ONE canonical row per
--     (user, source, model, hour) across the user's ACTIVE devices (revoked_at
--     IS NULL), largest total_tokens wins, rather than summing. One machine
--     drifts across multiple device_ids (unstable fingerprint, name-family
--     splits, replay) and summing those double-counts the ranking (issue #187).
--     Two genuinely distinct machines on the SAME model+half-hour count once —
--     rare, far better than the systemic ~2x summing produced.
--   * ACCOUNT-LEVEL sources (cursor): a per-ACCOUNT cloud API, stored
--     identically on every device that synced it — keep ONE canonical whole
--     row per (user, source, model, hour) across ALL devices (dedup, not sum,
--     and NOT active-filtered since the data is device-independent).
-- The account-level source list MUST stay in sync with ACCOUNT_LEVEL_SOURCES in
-- src/lib/source-metadata.js, the account_usage_grouped RPC, and the two
-- leaderboard edge functions (parity: test/account-source-parity.test.js).
--
-- Whole-row canonical pick (DISTINCT ON ... ORDER BY total_tokens DESC) rather
-- than per-column MAX so cost (derived from the individual token columns) stays
-- internally consistent. Hour-grain dedup before the per-(user,source,model)
-- roll-up, matching account_usage_grouped.
--
-- SECURITY INVOKER (default): the refresh edge calls it with the service-role
-- token. Returns ALL users (no blocklist filter — the edge applies
-- BLOCKED_LEADERBOARD_USER_IDS, same as before).
--
-- Idempotent. Rollback: DROP FUNCTION leaderboard_usage_grouped(timestamptz, timestamptz).

DROP FUNCTION IF EXISTS leaderboard_usage_grouped(timestamptz, timestamptz);

CREATE FUNCTION leaderboard_usage_grouped(
  p_from timestamptz,
  p_to timestamptz
) RETURNS jsonb
LANGUAGE sql STABLE
-- The 'total' period DISTINCT-dedupes the entire hourly history in one pass;
-- the default 4 MB work_mem spills that hash to disk and the RPC creeps toward
-- the leaderboard-refresh edge's 30s budget. A larger work_mem keeps it in
-- memory (kept the whole-history refresh ~13-20s, comfortably under budget).
SET work_mem TO '256MB'
SET hash_mem_multiplier TO '4'
AS $func$
  WITH cfg AS (
    -- Keep in sync with src/lib/source-metadata.js ACCOUNT_LEVEL_SOURCES.
    SELECT ARRAY['cursor']::text[] AS account_sources
  ),
  -- Hour-grain canonical rows. TWO passes total (DISTINCT + the per_usm GROUP BY)
  -- so the whole-history 'total' refresh stays within the edge's 30s budget --
  -- an intermediate per-hour SUM would add a third pass and tip 'total' over.
  rows_hg AS (
    -- Machine-level: ONE canonical whole row per (user, source, model, hour)
    -- across the user's ACTIVE devices, largest total_tokens wins -- the SAME
    -- dedup as the account-level branch below, only the source/device filters
    -- differ. One physical machine accumulates several device_ids over time:
    -- identity drift (no-suffix name -> "#suffix" -> machine_id anchor), an
    -- UNSTABLE hardware fingerprint minting a fresh id (sandbox vs CLI username,
    -- or ioreg/reg failure -> randomUUID), the CLI vs dashboard name families
    -- that never adopt each other, plus PR #184's full-history replay. The
    -- previous SELECT DISTINCT only folded rows BYTE-IDENTICAL across all six
    -- token columns, so a machine whose duplicate devices diverged by even one
    -- boundary hour double-counted the ranking (the 2026-06 "2x token" reports,
    -- issue #187). Keying on the cumulative per-(hour,model) snapshot is immune
    -- to every split mode. Trade-off: two genuinely distinct machines running
    -- the SAME model in the SAME half-hour count once, not summed -- rare, and
    -- far better than the systemic ~2x. Mirrors account_usage_grouped.
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

    -- Account-level: ONE canonical whole row per (user, source, model, hour)
    -- across ALL devices.
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
  ),
  per_usm AS (
    SELECT
      rows_hg.user_id, rows_hg.source, rows_hg.model,
      SUM(rows_hg.total_tokens)::bigint                AS total_tokens,
      SUM(rows_hg.input_tokens)::bigint                AS input_tokens,
      SUM(rows_hg.output_tokens)::bigint               AS output_tokens,
      SUM(rows_hg.cached_input_tokens)::bigint         AS cached_input_tokens,
      SUM(rows_hg.cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
      SUM(rows_hg.reasoning_output_tokens)::bigint     AS reasoning_output_tokens
    FROM rows_hg
    GROUP BY rows_hg.user_id, rows_hg.source, rows_hg.model
  )
  SELECT COALESCE(
           jsonb_agg(to_jsonb(per_usm.*) ORDER BY per_usm.user_id, per_usm.source, per_usm.model),
           '[]'::jsonb
         )
  FROM per_usm
$func$;
