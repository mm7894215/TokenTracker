-- Privacy-safe, period-aware model leaderboard snapshots.
--
-- Each row is one atomic JSON snapshot for a week/month/lifetime range. The
-- refresh edge only includes aggregate model rows used by at least three
-- developers, so custom or one-off model identifiers are never published.

CREATE TABLE IF NOT EXISTS public.tokentracker_model_leaderboard_snapshots (
  period text NOT NULL,
  from_day date NOT NULL,
  to_day date NOT NULL,
  entries jsonb NOT NULL DEFAULT '[]'::jsonb,
  total_models integer NOT NULL DEFAULT 0,
  generated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (period, from_day, to_day),
  CONSTRAINT tokentracker_model_leaderboard_period
    CHECK (period IN ('week', 'month', 'total')),
  CONSTRAINT tokentracker_model_leaderboard_entries_array
    CHECK (jsonb_typeof(entries) = 'array'),
  CONSTRAINT tokentracker_model_leaderboard_entries_limit
    CHECK (jsonb_array_length(entries) <= 500),
  CONSTRAINT tokentracker_model_leaderboard_total_matches
    CHECK (total_models = jsonb_array_length(entries))
);

CREATE INDEX IF NOT EXISTS tokentracker_model_leaderboard_latest_idx
  ON public.tokentracker_model_leaderboard_snapshots (period, to_day DESC);

ALTER TABLE public.tokentracker_model_leaderboard_snapshots ENABLE ROW LEVEL SECURITY;

-- Public browsers read through the leaderboard Edge function. Direct table
-- access stays disabled so deployment cannot accidentally expose unfinished
-- or malformed snapshots.
REVOKE ALL ON public.tokentracker_model_leaderboard_snapshots
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.tokentracker_model_leaderboard_snapshots TO project_admin;
