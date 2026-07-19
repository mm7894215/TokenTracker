-- Eliminate two production-only concurrency failures:
--
-- 1. account_usage_grouped_cached occasionally ran its probabilistic cleanup
--    in two cold-fill transactions at once. Both DELETEs selected the same
--    stale rows before taking tuple locks, then waited on each other and
--    deadlocked. Claim stale rows in deterministic SKIP LOCKED batches.
--
-- 2. A machine-anchored device can coexist with an older machine_id-less row
--    whose suffix is the machine id. Refreshing the canonical row to that
--    client default hit tokentracker_devices_active_unique every few minutes.
--    Converge that legacy row transactionally, preserving the most complete
--    whole hourly snapshot and any user-customized name.

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

  IF random() < 0.01 THEN
    WITH stale AS (
      SELECT stale.cache_key
      FROM public.tokentracker_account_usage_cache AS stale
      WHERE stale.fetched_at < clock_timestamp() - interval '5 minutes'
      ORDER BY stale.fetched_at, stale.cache_key
      FOR UPDATE SKIP LOCKED
      LIMIT 256
    )
    DELETE FROM public.tokentracker_account_usage_cache AS c
    USING stale
    WHERE c.cache_key = stale.cache_key;
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

CREATE OR REPLACE FUNCTION public.refresh_tokentracker_device_identity(
  p_user_id uuid,
  p_device_id uuid,
  p_device_name text,
  p_platform text
) RETURNS boolean
LANGUAGE plpgsql VOLATILE
SET search_path TO public, pg_temp
SET statement_timeout TO '15s'
AS $func$
DECLARE
  v_current_name text;
  v_name_customized boolean;
  v_current_default_name text;
  v_legacy_id uuid;
  v_legacy_name text;
  v_legacy_name_customized boolean;
  v_legacy_default_name text;
  v_target_name text;
  v_target_name_customized boolean;
  v_target_default_name text;
BEGIN
  SELECT d.device_name, d.name_customized, d.default_device_name
    INTO v_current_name, v_name_customized, v_current_default_name
  FROM public.tokentracker_devices AS d
  WHERE d.id = p_device_id
    AND d.user_id = p_user_id
    AND d.revoked_at IS NULL
    AND d.machine_id IS NOT NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT
    legacy.id,
    legacy.device_name,
    legacy.name_customized,
    legacy.default_device_name
  INTO
    v_legacy_id,
    v_legacy_name,
    v_legacy_name_customized,
    v_legacy_default_name
  FROM public.tokentracker_devices AS legacy
  WHERE legacy.user_id = p_user_id
    AND legacy.id <> p_device_id
    AND legacy.revoked_at IS NULL
    AND legacy.machine_id IS NULL
    AND legacy.platform IS NOT DISTINCT FROM p_platform
    AND (
      legacy.device_name = p_device_name
      OR legacy.default_device_name = p_device_name
    )
  ORDER BY
    CASE WHEN legacy.device_name = p_device_name THEN 0 ELSE 1 END,
    legacy.created_at,
    legacy.id
  LIMIT 1
  FOR UPDATE;

  IF v_legacy_id IS NOT NULL THEN
    INSERT INTO public.tokentracker_hourly AS canonical (
      user_id,
      device_id,
      source,
      model,
      hour_start,
      input_tokens,
      cached_input_tokens,
      cache_creation_input_tokens,
      output_tokens,
      reasoning_output_tokens,
      total_tokens,
      billable_total_tokens,
      conversations,
      created_at,
      updated_at,
      total_cost_usd
    )
    SELECT
      ranked.user_id,
      p_device_id,
      ranked.source,
      ranked.model,
      ranked.hour_start,
      ranked.input_tokens,
      ranked.cached_input_tokens,
      ranked.cache_creation_input_tokens,
      ranked.output_tokens,
      ranked.reasoning_output_tokens,
      ranked.total_tokens,
      ranked.billable_total_tokens,
      ranked.conversations,
      ranked.created_at,
      ranked.updated_at,
      ranked.total_cost_usd
    FROM (
      SELECT
        h.*,
        ROW_NUMBER() OVER (
          PARTITION BY h.user_id, h.source, h.model, h.hour_start
          ORDER BY h.total_tokens DESC, h.updated_at DESC, h.device_id = p_device_id DESC
        ) AS canonical_rank
      FROM public.tokentracker_hourly AS h
      WHERE h.user_id = p_user_id
        AND h.device_id IN (p_device_id, v_legacy_id)
    ) AS ranked
    WHERE ranked.canonical_rank = 1
    ON CONFLICT (user_id, device_id, source, model, hour_start) DO UPDATE SET
      input_tokens = EXCLUDED.input_tokens,
      cached_input_tokens = EXCLUDED.cached_input_tokens,
      cache_creation_input_tokens = EXCLUDED.cache_creation_input_tokens,
      output_tokens = EXCLUDED.output_tokens,
      reasoning_output_tokens = EXCLUDED.reasoning_output_tokens,
      total_tokens = EXCLUDED.total_tokens,
      billable_total_tokens = EXCLUDED.billable_total_tokens,
      conversations = EXCLUDED.conversations,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      total_cost_usd = EXCLUDED.total_cost_usd;

    DELETE FROM public.tokentracker_hourly
    WHERE user_id = p_user_id
      AND device_id = v_legacy_id;

    UPDATE public.tokentracker_device_tokens
    SET device_id = p_device_id
    WHERE user_id = p_user_id
      AND device_id = v_legacy_id;

    IF to_regclass('public.tokentracker_device_machine') IS NOT NULL THEN
      EXECUTE
        'DELETE FROM public.tokentracker_device_machine WHERE device_id = $1'
      USING v_legacy_id;
    END IF;

    UPDATE public.tokentracker_devices
    SET revoked_at = clock_timestamp()
    WHERE id = v_legacy_id
      AND user_id = p_user_id
      AND revoked_at IS NULL
      AND machine_id IS NULL;
  END IF;

  v_target_name := CASE
    WHEN v_name_customized THEN v_current_name
    WHEN COALESCE(v_legacy_name_customized, false) THEN v_legacy_name
    ELSE p_device_name
  END;
  v_target_name_customized :=
    v_name_customized OR COALESCE(v_legacy_name_customized, false);
  v_target_default_name := CASE
    WHEN v_name_customized THEN v_current_default_name
    WHEN COALESCE(v_legacy_name_customized, false)
      THEN COALESCE(v_legacy_default_name, p_device_name)
    ELSE v_current_default_name
  END;

  BEGIN
    UPDATE public.tokentracker_devices
    SET
      device_name = v_target_name,
      platform = p_platform,
      name_customized = v_target_name_customized,
      default_device_name = v_target_default_name
    WHERE id = p_device_id
      AND user_id = p_user_id
      AND revoked_at IS NULL;
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  RETURN true;
END;
$func$;

REVOKE ALL ON FUNCTION public.refresh_tokentracker_device_identity(
  uuid, uuid, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_tokentracker_device_identity(
  uuid, uuid, text, text
) TO project_admin;

-- Snapshot the exact rows affected by the one-time convergence so this data
-- rewrite remains recoverable after the migration transaction commits.
CREATE TABLE public.tt_device_conflict_pairs_20260719 AS
WITH candidates AS (
  SELECT
    m.user_id,
    m.id AS machine_device_id,
    l.id AS legacy_device_id,
    l.device_name AS client_device_name,
    m.platform,
    COUNT(*) OVER (PARTITION BY l.id) AS machine_candidates
  FROM public.tokentracker_devices AS m
  JOIN public.tokentracker_devices AS l
    ON l.user_id = m.user_id
   AND l.platform IS NOT DISTINCT FROM m.platform
   AND l.revoked_at IS NULL
   AND l.machine_id IS NULL
   AND l.id <> m.id
  WHERE m.revoked_at IS NULL
    AND m.machine_id IS NOT NULL
    AND right(l.device_name, 9) = '#' || left(m.machine_id, 8)
)
SELECT
  user_id,
  machine_device_id,
  legacy_device_id,
  client_device_name,
  platform
FROM candidates
WHERE machine_candidates = 1;

ALTER TABLE public.tt_device_conflict_pairs_20260719 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tt_device_conflict_pairs_20260719 FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.tt_device_conflict_pairs_20260719 TO project_admin;

CREATE TABLE public.tt_device_conflict_devices_backup_20260719 AS
SELECT d.*
FROM public.tokentracker_devices AS d
JOIN public.tt_device_conflict_pairs_20260719 AS p
  ON d.id IN (p.machine_device_id, p.legacy_device_id);

ALTER TABLE public.tt_device_conflict_devices_backup_20260719 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tt_device_conflict_devices_backup_20260719 FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.tt_device_conflict_devices_backup_20260719 TO project_admin;

CREATE TABLE public.tt_hourly_conflict_backup_20260719 AS
SELECT h.*
FROM public.tokentracker_hourly AS h
JOIN public.tt_device_conflict_pairs_20260719 AS p
  ON h.user_id = p.user_id
 AND h.device_id IN (p.machine_device_id, p.legacy_device_id);

ALTER TABLE public.tt_hourly_conflict_backup_20260719 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tt_hourly_conflict_backup_20260719 FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.tt_hourly_conflict_backup_20260719 TO project_admin;

CREATE TABLE public.tt_device_token_conflict_backup_20260719 AS
SELECT t.id, t.user_id, t.device_id
FROM public.tokentracker_device_tokens AS t
JOIN public.tt_device_conflict_pairs_20260719 AS p
  ON t.user_id = p.user_id
 AND t.device_id = p.legacy_device_id;

ALTER TABLE public.tt_device_token_conflict_backup_20260719 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tt_device_token_conflict_backup_20260719 FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.tt_device_token_conflict_backup_20260719 TO project_admin;

DO $backfill$
DECLARE
  v_pair record;
BEGIN
  FOR v_pair IN
    SELECT *
    FROM public.tt_device_conflict_pairs_20260719
    ORDER BY user_id, machine_device_id
  LOOP
    IF NOT public.refresh_tokentracker_device_identity(
      v_pair.user_id,
      v_pair.machine_device_id,
      v_pair.client_device_name,
      v_pair.platform
    ) THEN
      RAISE EXCEPTION 'device identity convergence lost canonical row %',
        v_pair.machine_device_id;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM public.tt_device_conflict_pairs_20260719 AS p
    JOIN public.tokentracker_devices AS legacy
      ON legacy.id = p.legacy_device_id
    WHERE legacy.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'device identity convergence left an active legacy row';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.tt_device_conflict_pairs_20260719 AS p
    JOIN public.tokentracker_hourly AS h
      ON h.user_id = p.user_id
     AND h.device_id = p.legacy_device_id
  ) THEN
    RAISE EXCEPTION 'device identity convergence left legacy hourly rows';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.tt_device_conflict_pairs_20260719 AS p
    JOIN public.tokentracker_device_tokens AS t
      ON t.user_id = p.user_id
     AND t.device_id = p.legacy_device_id
  ) THEN
    RAISE EXCEPTION 'device identity convergence left legacy token bindings';
  END IF;

  IF EXISTS (
    WITH expected AS (
      SELECT
        p.user_id,
        p.machine_device_id,
        h.source,
        h.model,
        h.hour_start,
        MAX(h.total_tokens) AS total_tokens
      FROM public.tt_device_conflict_pairs_20260719 AS p
      JOIN public.tt_hourly_conflict_backup_20260719 AS h
        ON h.user_id = p.user_id
       AND h.device_id IN (p.machine_device_id, p.legacy_device_id)
      GROUP BY
        p.user_id,
        p.machine_device_id,
        h.source,
        h.model,
        h.hour_start
    )
    SELECT 1
    FROM expected AS e
    LEFT JOIN public.tokentracker_hourly AS h
      ON h.user_id = e.user_id
     AND h.device_id = e.machine_device_id
     AND h.source = e.source
     AND h.model = e.model
     AND h.hour_start = e.hour_start
    WHERE h.device_id IS NULL
       OR h.total_tokens <> e.total_tokens
  ) THEN
    RAISE EXCEPTION 'device identity convergence failed whole-row canonicalization';
  END IF;
END;
$backfill$;
