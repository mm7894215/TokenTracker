-- Share the hottest account aggregation results across Deno isolates and edge
-- functions. Each account-* function already keeps a 30-second in-process
-- cache, but production logs show that separate isolates still repeat the same
-- account_usage_grouped_v2 scan thousands of times. PostgreSQL is the only
-- process shared by every caller, so keep the same 30-second freshness contract
-- here and serialize cold fills per exact request key.

CREATE UNLOGGED TABLE public.tokentracker_account_usage_cache (
  cache_key text PRIMARY KEY,
  fetched_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  result jsonb NOT NULL
);

CREATE INDEX tokentracker_account_usage_cache_fetched_at_idx
  ON public.tokentracker_account_usage_cache (fetched_at);

ALTER TABLE public.tokentracker_account_usage_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tokentracker_account_usage_cache FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tokentracker_account_usage_cache TO project_admin;

CREATE OR REPLACE FUNCTION public.account_usage_grouped_cached(
  p_user_id uuid,
  p_device_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_trunc text,
  p_tz text,
  p_offset_min integer
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE
SET search_path TO public, pg_temp
SET statement_timeout TO '8s'
AS $func$
DECLARE
  v_cache_key text;
  v_result jsonb;
BEGIN
  -- Unit Separator avoids ambiguous concatenation without requiring pgcrypto.
  -- The version prefix lets a future semantic change invalidate old entries.
  v_cache_key := concat_ws(
    chr(31),
    'v1',
    p_user_id::text,
    COALESCE(p_device_id::text, ''),
    to_char(p_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    to_char(p_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    p_trunc,
    COALESCE(p_tz, ''),
    COALESCE(p_offset_min::text, '')
  );

  SELECT c.result
    INTO v_result
  FROM public.tokentracker_account_usage_cache c
  WHERE c.cache_key = v_cache_key
    AND c.fetched_at >= clock_timestamp() - interval '30 seconds';
  IF FOUND THEN
    RETURN v_result;
  END IF;

  -- Prevent a cold dashboard wave from making every Deno isolate execute the
  -- same expensive scan. A transaction-scoped lock is automatically released
  -- on success or error. Hash collisions only serialize unrelated fills; the
  -- full text key remains the correctness boundary in the cache table.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_cache_key, 0));

  SELECT c.result
    INTO v_result
  FROM public.tokentracker_account_usage_cache c
  WHERE c.cache_key = v_cache_key
    AND c.fetched_at >= clock_timestamp() - interval '30 seconds';
  IF FOUND THEN
    RETURN v_result;
  END IF;

  v_result := public.account_usage_grouped_v2(
    p_user_id,
    p_device_id,
    p_from,
    p_to,
    p_trunc,
    p_tz,
    p_offset_min
  );

  INSERT INTO public.tokentracker_account_usage_cache AS c (
    cache_key,
    fetched_at,
    result
  ) VALUES (
    v_cache_key,
    clock_timestamp(),
    v_result
  )
  ON CONFLICT (cache_key) DO UPDATE SET
    fetched_at = EXCLUDED.fetched_at,
    result = EXCLUDED.result;

  -- Bound cache growth without putting cleanup work on every hit. The index
  -- keeps this occasional, limited prune proportional to expired entries.
  IF random() < 0.01 THEN
    DELETE FROM public.tokentracker_account_usage_cache c
    WHERE c.cache_key IN (
      SELECT stale.cache_key
      FROM public.tokentracker_account_usage_cache stale
      WHERE stale.fetched_at < clock_timestamp() - interval '5 minutes'
      ORDER BY stale.fetched_at
      LIMIT 256
    );
  END IF;

  RETURN v_result;
END;
$func$;

REVOKE ALL ON FUNCTION public.account_usage_grouped_cached(
  uuid, uuid, timestamptz, timestamptz, text, text, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_usage_grouped_cached(
  uuid, uuid, timestamptz, timestamptz, text, text, integer
) TO project_admin;
