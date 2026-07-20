-- Growth comparisons must not treat the current partial UTC day as if it were
-- a completed day. Normalize the two growth fields whenever the hourly
-- snapshot is refreshed, using the last seven completed days against the
-- preceding seven completed days.

CREATE OR REPLACE FUNCTION public.normalize_tokentracker_community_growth()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $func$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_current_tokens numeric := 0;
  v_previous_tokens numeric := 0;
  v_current_developers numeric := 0;
  v_previous_developers numeric := 0;
BEGIN
  SELECT
    COALESCE(SUM(d.tokens) FILTER (
      WHERE d.day BETWEEN v_today - 7 AND v_today - 1
    ), 0),
    COALESCE(SUM(d.tokens) FILTER (
      WHERE d.day BETWEEN v_today - 14 AND v_today - 8
    ), 0),
    COALESCE(AVG(d.active_developers) FILTER (
      WHERE d.day BETWEEN v_today - 7 AND v_today - 1
    ), 0),
    COALESCE(AVG(d.active_developers) FILTER (
      WHERE d.day BETWEEN v_today - 14 AND v_today - 8
    ), 0)
  INTO
    v_current_tokens,
    v_previous_tokens,
    v_current_developers,
    v_previous_developers
  FROM jsonb_to_recordset(COALESCE(NEW.daily_growth, '[]'::jsonb)) AS d(
    day date,
    tokens numeric,
    active_developers numeric
  );

  NEW.token_growth_pct := CASE WHEN v_previous_tokens > 0
    THEN round(((v_current_tokens - v_previous_tokens) / v_previous_tokens) * 1000) / 10
    ELSE NULL END;
  NEW.developer_growth_pct := CASE WHEN v_previous_developers > 0
    THEN round(((v_current_developers - v_previous_developers) / v_previous_developers) * 1000) / 10
    ELSE NULL END;

  RETURN NEW;
END
$func$;

REVOKE ALL ON FUNCTION public.normalize_tokentracker_community_growth()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS normalize_tokentracker_community_growth
  ON public.tokentracker_community_stats;
CREATE TRIGGER normalize_tokentracker_community_growth
BEFORE INSERT OR UPDATE OF daily_growth
ON public.tokentracker_community_stats
FOR EACH ROW
EXECUTE FUNCTION public.normalize_tokentracker_community_growth();

-- Correct the snapshot produced by the migration immediately. Future hourly
-- refreshes are normalized by the trigger above.
UPDATE public.tokentracker_community_stats
SET daily_growth = daily_growth
WHERE id = 'total';
