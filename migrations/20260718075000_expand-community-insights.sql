-- Expand the singleton Global Metrics snapshot with useful, privacy-safe
-- dimensions. The public Edge Function keeps an O(1) read path; this hourly
-- refresh is the only operation that aggregates the canonical daily rollup.

ALTER TABLE public.tokentracker_community_stats
  ADD COLUMN IF NOT EXISTS provider_breakdown jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS daily_growth jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS token_mix jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS user_distribution jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS platform_distribution jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS active_developers_total integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS active_developers_30d integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tokens_30d bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS token_growth_pct numeric,
  ADD COLUMN IF NOT EXISTS developer_growth_pct numeric;

ALTER TABLE public.tokentracker_community_stats
  DROP CONSTRAINT IF EXISTS tokentracker_community_stats_provider_breakdown_check,
  ADD CONSTRAINT tokentracker_community_stats_provider_breakdown_check
    CHECK (jsonb_typeof(provider_breakdown) = 'array'),
  DROP CONSTRAINT IF EXISTS tokentracker_community_stats_daily_growth_check,
  ADD CONSTRAINT tokentracker_community_stats_daily_growth_check
    CHECK (jsonb_typeof(daily_growth) = 'array'),
  DROP CONSTRAINT IF EXISTS tokentracker_community_stats_token_mix_check,
  ADD CONSTRAINT tokentracker_community_stats_token_mix_check
    CHECK (jsonb_typeof(token_mix) = 'array'),
  DROP CONSTRAINT IF EXISTS tokentracker_community_stats_user_distribution_check,
  ADD CONSTRAINT tokentracker_community_stats_user_distribution_check
    CHECK (jsonb_typeof(user_distribution) = 'array'),
  DROP CONSTRAINT IF EXISTS tokentracker_community_stats_platform_distribution_check,
  ADD CONSTRAINT tokentracker_community_stats_platform_distribution_check
    CHECK (jsonb_typeof(platform_distribution) = 'array'),
  DROP CONSTRAINT IF EXISTS tokentracker_community_stats_developer_counts_check,
  ADD CONSTRAINT tokentracker_community_stats_developer_counts_check
    CHECK (
      active_developers_total >= 0
      AND active_developers_30d >= 0
      AND active_developers_30d <= active_developers_total
      AND tokens_30d >= 0
    );

CREATE OR REPLACE FUNCTION public.refresh_tokentracker_community_stats()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
SET work_mem TO '96MB'
SET hash_mem_multiplier TO '4'
SET statement_timeout TO '60s'
AS $func$
DECLARE
  v_through timestamptz;
  v_to timestamptz :=
    date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + interval '1 day';
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_total bigint := 0;
  v_top_models jsonb := '[]'::jsonb;
  v_providers jsonb := '[]'::jsonb;
  v_daily jsonb := '[]'::jsonb;
  v_token_mix jsonb := '[]'::jsonb;
  v_user_distribution jsonb := '[]'::jsonb;
  v_platforms jsonb := '[]'::jsonb;
  v_developers_total integer := 0;
  v_developers_30d integer := 0;
  v_tokens_30d bigint := 0;
  v_token_growth_pct numeric;
  v_developer_growth_pct numeric;
BEGIN
  SELECT m.through
  INTO v_through
  FROM public.tokentracker_leaderboard_rollup_meta m
  WHERE m.id = 1;

  v_through := COALESCE(v_through, '1970-01-01'::timestamptz);

  WITH usage_parts AS MATERIALIZED (
    SELECT
      r.user_id, trim(r.source) AS source, trim(r.model) AS model, r.day,
      r.total_tokens, r.input_tokens, r.output_tokens,
      r.cached_input_tokens, r.cache_creation_input_tokens,
      r.reasoning_output_tokens
    FROM public.tokentracker_leaderboard_rollup_daily r

    UNION ALL

    SELECT
      d.user_id, trim(d.source), trim(d.model),
      (d.hour_start AT TIME ZONE 'UTC')::date,
      d.total_tokens, d.input_tokens, d.output_tokens,
      d.cached_input_tokens, d.cache_creation_input_tokens,
      d.reasoning_output_tokens
    FROM public.leaderboard_hourly_dedup(v_through, v_to) d
  ),
  usage AS MATERIALIZED (
    SELECT
      p.user_id, p.source, p.model, p.day,
      SUM(p.total_tokens)::bigint AS total_tokens,
      SUM(p.input_tokens)::bigint AS input_tokens,
      SUM(p.output_tokens)::bigint AS output_tokens,
      SUM(p.cached_input_tokens)::bigint AS cached_input_tokens,
      SUM(p.cache_creation_input_tokens)::bigint AS cache_creation_input_tokens,
      SUM(p.reasoning_output_tokens)::bigint AS reasoning_output_tokens
    FROM usage_parts p
    WHERE p.model <> ''
      AND lower(p.model) <> 'auto'
    GROUP BY p.user_id, p.source, p.model, p.day
  ),
  totals AS MATERIALIZED (
    SELECT
      COALESCE(SUM(u.total_tokens), 0)::bigint AS total_tokens,
      COALESCE(SUM(u.input_tokens), 0)::bigint AS input_tokens,
      COALESCE(SUM(u.output_tokens), 0)::bigint AS output_tokens,
      COALESCE(SUM(u.cached_input_tokens), 0)::bigint AS cached_input_tokens,
      COALESCE(SUM(u.cache_creation_input_tokens), 0)::bigint AS cache_creation_input_tokens,
      COALESCE(SUM(u.reasoning_output_tokens), 0)::bigint AS reasoning_output_tokens,
      COUNT(DISTINCT u.user_id)::integer AS developers_total,
      COUNT(DISTINCT u.user_id) FILTER (
        WHERE u.day >= v_today - 29
      )::integer AS developers_30d,
      COALESCE(SUM(u.total_tokens) FILTER (
        WHERE u.day >= v_today - 29
      ), 0)::bigint AS tokens_30d
    FROM usage u
  ),
  model_totals AS MATERIALIZED (
    SELECT u.model, SUM(u.total_tokens)::bigint AS tokens
    FROM usage u
    GROUP BY u.model
  ),
  provider_totals AS MATERIALIZED (
    SELECT
      u.source,
      SUM(u.total_tokens)::bigint AS tokens,
      COUNT(DISTINCT u.user_id)::integer AS developers
    FROM usage u
    WHERE u.source <> ''
    GROUP BY u.source
  ),
  user_totals AS MATERIALIZED (
    SELECT u.user_id, SUM(u.total_tokens)::bigint AS tokens
    FROM usage u
    GROUP BY u.user_id
  ),
  daily_raw AS MATERIALIZED (
    SELECT
      u.day,
      SUM(u.total_tokens)::bigint AS tokens,
      COUNT(DISTINCT u.user_id)::integer AS active_developers
    FROM usage u
    WHERE u.day >= v_today - 29
    GROUP BY u.day
  ),
  daily_filled AS MATERIALIZED (
    SELECT
      days.day::date AS day,
      COALESCE(d.tokens, 0)::bigint AS tokens,
      COALESCE(d.active_developers, 0)::integer AS active_developers
    FROM generate_series(v_today - 29, v_today, interval '1 day') days(day)
    LEFT JOIN daily_raw d ON d.day = days.day::date
  ),
  daily_windowed AS MATERIALIZED (
    SELECT
      d.day, d.tokens, d.active_developers,
      ROUND(AVG(d.tokens::numeric) OVER (
        ORDER BY d.day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
      ))::bigint AS tokens_7d_avg
    FROM daily_filled d
  ),
  week_compare AS MATERIALIZED (
    SELECT
      COALESCE(SUM(d.tokens) FILTER (
        WHERE d.day >= v_today - 6
      ), 0)::numeric AS current_tokens,
      COALESCE(SUM(d.tokens) FILTER (
        WHERE d.day BETWEEN v_today - 13 AND v_today - 7
      ), 0)::numeric AS previous_tokens,
      COALESCE(AVG(d.active_developers) FILTER (
        WHERE d.day >= v_today - 6
      ), 0)::numeric AS current_developers,
      COALESCE(AVG(d.active_developers) FILTER (
        WHERE d.day BETWEEN v_today - 13 AND v_today - 7
      ), 0)::numeric AS previous_developers
    FROM daily_filled d
  ),
  top_models_value AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'name', x.model,
        'tokens', x.tokens,
        'share', CASE WHEN t.total_tokens > 0
          THEN round((x.tokens::numeric / t.total_tokens) * 1000) / 10
          ELSE 0 END
      ) ORDER BY x.tokens DESC
    ), '[]'::jsonb) AS value
    FROM (
      SELECT m.model, m.tokens
      FROM model_totals m
      ORDER BY m.tokens DESC
      LIMIT 15
    ) x
    CROSS JOIN totals t
  ),
  providers_value AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'name', p.source,
        'tokens', p.tokens,
        'developers', p.developers,
        'share', CASE WHEN t.total_tokens > 0
          THEN round((p.tokens::numeric / t.total_tokens) * 1000) / 10
          ELSE 0 END
      ) ORDER BY p.tokens DESC
    ), '[]'::jsonb) AS value
    FROM provider_totals p
    CROSS JOIN totals t
  ),
  daily_value AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'day', d.day,
        'tokens', d.tokens,
        'tokens_7d_avg', d.tokens_7d_avg,
        'active_developers', d.active_developers
      ) ORDER BY d.day
    ), '[]'::jsonb) AS value
    FROM daily_windowed d
  ),
  token_mix_rows AS MATERIALIZED (
    SELECT * FROM (VALUES
      (1, 'input', (SELECT input_tokens FROM totals)),
      (2, 'cache_read', (SELECT cached_input_tokens FROM totals)),
      (3, 'cache_write', (SELECT cache_creation_input_tokens FROM totals)),
      (4, 'output', (SELECT output_tokens FROM totals)),
      (5, 'reasoning', (SELECT reasoning_output_tokens FROM totals))
    ) AS mix(sort_order, key, tokens)
  ),
  token_mix_value AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'key', m.key,
        'tokens', m.tokens,
        'share', CASE WHEN sums.tokens > 0
          THEN round((m.tokens::numeric / sums.tokens) * 1000) / 10
          ELSE 0 END
      ) ORDER BY m.sort_order
    ), '[]'::jsonb) AS value
    FROM token_mix_rows m
    CROSS JOIN (
      SELECT COALESCE(SUM(tokens), 0)::numeric AS tokens FROM token_mix_rows
    ) sums
  ),
  user_band_rows AS MATERIALIZED (
    SELECT
      CASE
        WHEN u.tokens < 1000000 THEN 1
        WHEN u.tokens < 10000000 THEN 2
        WHEN u.tokens < 100000000 THEN 3
        WHEN u.tokens < 1000000000 THEN 4
        ELSE 5
      END AS sort_order,
      CASE
        WHEN u.tokens < 1000000 THEN 'lt_1m'
        WHEN u.tokens < 10000000 THEN '1m_10m'
        WHEN u.tokens < 100000000 THEN '10m_100m'
        WHEN u.tokens < 1000000000 THEN '100m_1b'
        ELSE '1b_plus'
      END AS key,
      COUNT(*)::integer AS developers,
      SUM(u.tokens)::bigint AS tokens
    FROM user_totals u
    GROUP BY 1, 2
  ),
  user_distribution_value AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'key', b.key,
        'developers', b.developers,
        'tokens', b.tokens,
        'developer_share', CASE WHEN t.developers_total > 0
          THEN round((b.developers::numeric / t.developers_total) * 1000) / 10
          ELSE 0 END,
        'token_share', CASE WHEN t.total_tokens > 0
          THEN round((b.tokens::numeric / t.total_tokens) * 1000) / 10
          ELSE 0 END
      ) ORDER BY b.sort_order
    ), '[]'::jsonb) AS value
    FROM user_band_rows b
    CROSS JOIN totals t
  ),
  latest_platform AS MATERIALIZED (
    SELECT DISTINCT ON (td.machine_hash)
      td.machine_hash,
      lower(trim(td.platform)) AS platform
    FROM public.tokentracker_telemetry_daily td
    WHERE td.day >= v_today - 29
      AND trim(td.platform) <> ''
    ORDER BY td.machine_hash, td.last_seen_at DESC
  ),
  platform_rows AS MATERIALIZED (
    SELECT lp.platform, COUNT(*)::integer AS machines
    FROM latest_platform lp
    GROUP BY lp.platform
  ),
  platform_value AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'name', p.platform,
        'machines', p.machines,
        'share', CASE WHEN totals.machines > 0
          THEN round((p.machines::numeric / totals.machines) * 1000) / 10
          ELSE 0 END
      ) ORDER BY p.machines DESC
    ), '[]'::jsonb) AS value
    FROM platform_rows p
    CROSS JOIN (
      SELECT COALESCE(SUM(machines), 0)::integer AS machines FROM platform_rows
    ) totals
  )
  SELECT
    t.total_tokens,
    models.value,
    providers.value,
    daily.value,
    mix.value,
    bands.value,
    platforms.value,
    t.developers_total,
    t.developers_30d,
    t.tokens_30d,
    CASE WHEN w.previous_tokens > 0
      THEN round(((w.current_tokens - w.previous_tokens) / w.previous_tokens) * 1000) / 10
      ELSE NULL END,
    CASE WHEN w.previous_developers > 0
      THEN round(((w.current_developers - w.previous_developers) / w.previous_developers) * 1000) / 10
      ELSE NULL END
  INTO
    v_total, v_top_models, v_providers, v_daily, v_token_mix,
    v_user_distribution, v_platforms, v_developers_total,
    v_developers_30d, v_tokens_30d, v_token_growth_pct,
    v_developer_growth_pct
  FROM totals t
  CROSS JOIN top_models_value models
  CROSS JOIN providers_value providers
  CROSS JOIN daily_value daily
  CROSS JOIN token_mix_value mix
  CROSS JOIN user_distribution_value bands
  CROSS JOIN platform_value platforms
  CROSS JOIN week_compare w;

  INSERT INTO public.tokentracker_community_stats (
    id, total_tokens, top_models, from_day, to_day, generated_at,
    provider_breakdown, daily_growth, token_mix, user_distribution,
    platform_distribution, active_developers_total,
    active_developers_30d, tokens_30d, token_growth_pct,
    developer_growth_pct
  ) VALUES (
    'total', v_total, v_top_models, DATE '1970-01-01',
    (v_to - interval '1 day')::date, now(), v_providers, v_daily,
    v_token_mix, v_user_distribution, v_platforms, v_developers_total,
    v_developers_30d, v_tokens_30d, v_token_growth_pct,
    v_developer_growth_pct
  )
  ON CONFLICT (id) DO UPDATE SET
    total_tokens = EXCLUDED.total_tokens,
    top_models = EXCLUDED.top_models,
    from_day = EXCLUDED.from_day,
    to_day = EXCLUDED.to_day,
    generated_at = EXCLUDED.generated_at,
    provider_breakdown = EXCLUDED.provider_breakdown,
    daily_growth = EXCLUDED.daily_growth,
    token_mix = EXCLUDED.token_mix,
    user_distribution = EXCLUDED.user_distribution,
    platform_distribution = EXCLUDED.platform_distribution,
    active_developers_total = EXCLUDED.active_developers_total,
    active_developers_30d = EXCLUDED.active_developers_30d,
    tokens_30d = EXCLUDED.tokens_30d,
    token_growth_pct = EXCLUDED.token_growth_pct,
    developer_growth_pct = EXCLUDED.developer_growth_pct;

  RETURN jsonb_build_object(
    'total_tokens', v_total,
    'model_count', jsonb_array_length(v_top_models),
    'provider_count', jsonb_array_length(v_providers),
    'days', jsonb_array_length(v_daily),
    'active_developers_30d', v_developers_30d
  );
END
$func$;

REVOKE ALL ON FUNCTION public.refresh_tokentracker_community_stats()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_tokentracker_community_stats()
  TO project_admin;
