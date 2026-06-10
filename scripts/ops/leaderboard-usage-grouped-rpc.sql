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
--   * MACHINE-LEVEL sources (claude/codex/...): real independent per-machine
--     work — SUM across the user's ACTIVE devices (revoked_at IS NULL),
--     dropping historic device churn.
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
AS $func$
  WITH cfg AS (
    -- Keep in sync with src/lib/source-metadata.js ACCOUNT_LEVEL_SOURCES.
    SELECT ARRAY['cursor']::text[] AS account_sources
  ),
  hourly AS (
    -- Machine-level: SUM across the user's ACTIVE devices, per (user, source,
    -- model, hour).
    SELECT h.user_id, h.source, h.model, h.hour_start,
      SUM(h.total_tokens)::bigint                AS total_tokens,
      SUM(h.input_tokens)::bigint                AS input_tokens,
      SUM(h.output_tokens)::bigint               AS output_tokens,
      SUM(h.cached_input_tokens)::bigint         AS cached_input_tokens,
      SUM(h.cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
      SUM(h.reasoning_output_tokens)::bigint     AS reasoning_output_tokens
    FROM tokentracker_hourly h
    CROSS JOIN cfg
    JOIN tokentracker_devices d
      ON d.id = h.device_id AND d.revoked_at IS NULL
    WHERE h.hour_start >= p_from AND h.hour_start < p_to
      AND NOT (h.source = ANY(cfg.account_sources))
    GROUP BY h.user_id, h.source, h.model, h.hour_start

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
      hourly.user_id, hourly.source, hourly.model,
      SUM(hourly.total_tokens)::bigint                AS total_tokens,
      SUM(hourly.input_tokens)::bigint                AS input_tokens,
      SUM(hourly.output_tokens)::bigint               AS output_tokens,
      SUM(hourly.cached_input_tokens)::bigint         AS cached_input_tokens,
      SUM(hourly.cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
      SUM(hourly.reasoning_output_tokens)::bigint     AS reasoning_output_tokens
    FROM hourly
    GROUP BY hourly.user_id, hourly.source, hourly.model
  )
  SELECT COALESCE(
           jsonb_agg(to_jsonb(per_usm.*) ORDER BY per_usm.user_id, per_usm.source, per_usm.model),
           '[]'::jsonb
         )
  FROM per_usm
$func$;
