CREATE TABLE IF NOT EXISTS public.tokentracker_leaderboard_rollup_daily_v2 (
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

CREATE TABLE IF NOT EXISTS public.tokentracker_leaderboard_rollup_meta_v2 (
  id int PRIMARY KEY CHECK (id = 1),
  through timestamptz NOT NULL,
  repair_from date NOT NULL,
  rebuilt_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tokentracker_leaderboard_rollup_daily_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tokentracker_leaderboard_rollup_meta_v2 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tokentracker_leaderboard_rollup_daily_v2 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.tokentracker_leaderboard_rollup_meta_v2 FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.tokentracker_leaderboard_rollup_daily_v2 TO project_admin;
GRANT ALL ON public.tokentracker_leaderboard_rollup_meta_v2 TO project_admin;

CREATE OR REPLACE FUNCTION public.leaderboard_hourly_dedup_v2(
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
    SELECT ARRAY['cursor']::text[] AS account_sources
  )
  -- Deduplicate device-id drift/replays inside one physical machine cluster,
  -- then add genuinely distinct machines for the same user/hour/model.
  SELECT mac.user_id, mac.source, mac.model, mac.hour_start,
    SUM(mac.total_tokens)::bigint                AS total_tokens,
    SUM(mac.input_tokens)::bigint                AS input_tokens,
    SUM(mac.output_tokens)::bigint               AS output_tokens,
    SUM(mac.cached_input_tokens)::bigint         AS cached_input_tokens,
    SUM(mac.cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
    SUM(mac.reasoning_output_tokens)::bigint     AS reasoning_output_tokens
  FROM (
    SELECT DISTINCT ON (
      h.user_id,
      COALESCE(dm.machine_cluster_id, h.device_id::text),
      h.source,
      h.model,
      h.hour_start
    )
      h.user_id,
      COALESCE(dm.machine_cluster_id, h.device_id::text) AS machine_cluster_id,
      h.source, h.model, h.hour_start,
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
    LEFT JOIN tokentracker_device_machine dm
      ON dm.device_id = h.device_id
    WHERE h.hour_start >= p_from AND h.hour_start < p_to
      AND NOT (h.source = ANY(cfg.account_sources))
    ORDER BY
      h.user_id,
      COALESCE(dm.machine_cluster_id, h.device_id::text),
      h.source,
      h.model,
      h.hour_start,
      h.total_tokens DESC,
      h.updated_at DESC
  ) mac
  GROUP BY mac.user_id, mac.source, mac.model, mac.hour_start

  UNION ALL

  -- Account-level sources are device-independent cloud totals and still keep
  -- one canonical whole row across every device.
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

REVOKE ALL ON FUNCTION public.leaderboard_hourly_dedup_v2(timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leaderboard_hourly_dedup_v2(timestamptz, timestamptz)
  TO project_admin;

CREATE OR REPLACE FUNCTION public.leaderboard_rollup_daily_replace_v2(
  p_from timestamptz,
  p_to timestamptz
)
RETURNS void
LANGUAGE plpgsql
SET work_mem TO '16MB'
SET hash_mem_multiplier TO '2'
SET statement_timeout TO '25s'
AS $func$
DECLARE
  v_day timestamptz;
BEGIN
  v_day := date_trunc('day', p_from AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  WHILE v_day < p_to LOOP
    DELETE FROM public.tokentracker_leaderboard_rollup_daily_v2
    WHERE day = (v_day AT TIME ZONE 'UTC')::date;

    INSERT INTO public.tokentracker_leaderboard_rollup_daily_v2 (
      user_id, source, model, day,
      total_tokens, input_tokens, output_tokens,
      cached_input_tokens, cache_creation_input_tokens, reasoning_output_tokens
    )
    SELECT
      d.user_id, d.source, d.model,
      (d.hour_start AT TIME ZONE 'UTC')::date AS day,
      SUM(d.total_tokens), SUM(d.input_tokens), SUM(d.output_tokens),
      SUM(d.cached_input_tokens), SUM(d.cache_creation_input_tokens), SUM(d.reasoning_output_tokens)
    FROM public.leaderboard_hourly_dedup_v2(v_day, v_day + interval '1 day') d
    GROUP BY d.user_id, d.source, d.model, (d.hour_start AT TIME ZONE 'UTC')::date;

    v_day := v_day + interval '1 day';
  END LOOP;

END
$func$;

REVOKE ALL ON FUNCTION public.leaderboard_rollup_daily_replace_v2(timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leaderboard_rollup_daily_replace_v2(timestamptz, timestamptz)
  TO project_admin;

CREATE OR REPLACE FUNCTION public.leaderboard_rollup_daily_advance_v2()
RETURNS void
LANGUAGE plpgsql
SET work_mem TO '16MB'
SET hash_mem_multiplier TO '2'
SET statement_timeout TO '25s'
AS $func$
DECLARE
  v_from timestamptz;
  v_target timestamptz := date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_until timestamptz;
  v_min_day date;
  v_repair_from date;
BEGIN
  SELECT
    (date_trunc('day', MIN(h.hour_start) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::date
  INTO v_min_day
  FROM public.tokentracker_hourly h;
  v_min_day := COALESCE(v_min_day, (v_target AT TIME ZONE 'UTC')::date);

  SELECT m.through, m.repair_from INTO v_from, v_repair_from
  FROM public.tokentracker_leaderboard_rollup_meta_v2 m
  WHERE m.id = 1
  FOR UPDATE;

  IF v_from IS NULL THEN
    v_from := v_min_day::timestamp AT TIME ZONE 'UTC';
    v_repair_from := v_min_day;
    INSERT INTO public.tokentracker_leaderboard_rollup_meta_v2 (
      id, through, repair_from, rebuilt_at
    ) VALUES (1, v_from, v_repair_from, now());
  END IF;

  IF v_from < v_target THEN
    -- Bootstrap/catch-up: advance at most seven closed days per request.
    v_until := LEAST(v_target, v_from + interval '7 days');
    PERFORM public.leaderboard_rollup_daily_replace_v2(v_from, v_until);
    UPDATE public.tokentracker_leaderboard_rollup_meta_v2
    SET through = v_until,
        rebuilt_at = now()
    WHERE id = 1;
    RETURN;
  END IF;

  -- Once caught up, continuously repair seven historical days per scheduled
  -- total refresh. Late history uploads, device revocations, and cluster-map
  -- changes therefore self-heal without another whole-history memory spike.
  IF v_repair_from >= (v_target AT TIME ZONE 'UTC')::date THEN
    v_repair_from := v_min_day;
  END IF;
  v_until := LEAST(
    v_target,
    (v_repair_from::timestamp AT TIME ZONE 'UTC') + interval '7 days'
  );
  PERFORM public.leaderboard_rollup_daily_replace_v2(
    v_repair_from::timestamp AT TIME ZONE 'UTC',
    v_until
  );
  UPDATE public.tokentracker_leaderboard_rollup_meta_v2
  SET repair_from = CASE
        WHEN v_until >= v_target THEN v_min_day
        ELSE (v_until AT TIME ZONE 'UTC')::date
      END,
      rebuilt_at = now()
  WHERE id = 1;
END
$func$;

REVOKE ALL ON FUNCTION public.leaderboard_rollup_daily_advance_v2()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leaderboard_rollup_daily_advance_v2()
  TO project_admin;

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
  FROM public.tokentracker_leaderboard_rollup_meta_v2 m
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
        FROM public.tokentracker_leaderboard_rollup_daily_v2 r
        UNION ALL
        SELECT t.user_id, t.source, t.model,
          t.total_tokens, t.input_tokens, t.output_tokens,
          t.cached_input_tokens, t.cache_creation_input_tokens, t.reasoning_output_tokens
        FROM public.leaderboard_hourly_dedup_v2(v_through, p_to) t
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
      FROM public.leaderboard_hourly_dedup_v2(p_from, p_to) d
      GROUP BY d.user_id, d.source, d.model
    ) per_usm;
  END IF;

  RETURN COALESCE(v_result, '[]'::jsonb);
END
$func$;
