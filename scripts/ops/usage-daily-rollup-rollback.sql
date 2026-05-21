drop trigger if exists tokentracker_hourly_daily_rollup_trg on public.tokentracker_hourly;
drop function if exists public.tokentracker_apply_daily_rollup_delta();
drop function if exists public.tokentracker_rebuild_daily_rollup(date, date);
drop table if exists public.tokentracker_daily_rollup;
