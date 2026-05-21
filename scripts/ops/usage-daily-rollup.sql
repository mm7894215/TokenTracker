create table if not exists public.tokentracker_daily_rollup (
  user_id uuid not null,
  day date not null,
  source text not null,
  model text not null,
  total_tokens bigint not null default 0,
  input_tokens bigint not null default 0,
  cached_input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  reasoning_output_tokens bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, day, source, model)
);

create index if not exists tokentracker_daily_rollup_user_day_idx
  on public.tokentracker_daily_rollup (user_id, day);

create index if not exists tokentracker_daily_rollup_user_source_model_day_idx
  on public.tokentracker_daily_rollup (user_id, source, model, day);

create or replace function public.tokentracker_apply_daily_rollup_delta()
returns trigger as $$
declare
  v_day date;
  v_user_id uuid;
  v_source text;
  v_model text;
  d_total bigint := 0;
  d_input bigint := 0;
  d_cached bigint := 0;
  d_output bigint := 0;
  d_reasoning bigint := 0;
begin
  if (tg_op = 'INSERT') then
    v_day := (new.hour_start at time zone 'UTC')::date;
    v_user_id := new.user_id;
    v_source := new.source;
    v_model := new.model;
    d_total := coalesce(new.total_tokens, 0);
    d_input := coalesce(new.input_tokens, 0);
    d_cached := coalesce(new.cached_input_tokens, 0);
    d_output := coalesce(new.output_tokens, 0);
    d_reasoning := coalesce(new.reasoning_output_tokens, 0);
  elsif (tg_op = 'DELETE') then
    v_day := (old.hour_start at time zone 'UTC')::date;
    v_user_id := old.user_id;
    v_source := old.source;
    v_model := old.model;
    d_total := -coalesce(old.total_tokens, 0);
    d_input := -coalesce(old.input_tokens, 0);
    d_cached := -coalesce(old.cached_input_tokens, 0);
    d_output := -coalesce(old.output_tokens, 0);
    d_reasoning := -coalesce(old.reasoning_output_tokens, 0);
  else
    if (old.user_id != new.user_id
        or old.source != new.source
        or old.model != new.model
        or old.hour_start != new.hour_start) then
      v_day := (old.hour_start at time zone 'UTC')::date;
      v_user_id := old.user_id;
      v_source := old.source;
      v_model := old.model;
      d_total := -coalesce(old.total_tokens, 0);
      d_input := -coalesce(old.input_tokens, 0);
      d_cached := -coalesce(old.cached_input_tokens, 0);
      d_output := -coalesce(old.output_tokens, 0);
      d_reasoning := -coalesce(old.reasoning_output_tokens, 0);

      insert into public.tokentracker_daily_rollup (
        user_id, day, source, model,
        total_tokens, input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, updated_at
      ) values (
        v_user_id, v_day, v_source, v_model,
        d_total, d_input, d_cached, d_output, d_reasoning, now()
      ) on conflict (user_id, day, source, model)
      do update set
        total_tokens = public.tokentracker_daily_rollup.total_tokens + excluded.total_tokens,
        input_tokens = public.tokentracker_daily_rollup.input_tokens + excluded.input_tokens,
        cached_input_tokens = public.tokentracker_daily_rollup.cached_input_tokens + excluded.cached_input_tokens,
        output_tokens = public.tokentracker_daily_rollup.output_tokens + excluded.output_tokens,
        reasoning_output_tokens = public.tokentracker_daily_rollup.reasoning_output_tokens + excluded.reasoning_output_tokens,
        updated_at = now();

      v_day := (new.hour_start at time zone 'UTC')::date;
      v_user_id := new.user_id;
      v_source := new.source;
      v_model := new.model;
      d_total := coalesce(new.total_tokens, 0);
      d_input := coalesce(new.input_tokens, 0);
      d_cached := coalesce(new.cached_input_tokens, 0);
      d_output := coalesce(new.output_tokens, 0);
      d_reasoning := coalesce(new.reasoning_output_tokens, 0);

      insert into public.tokentracker_daily_rollup (
        user_id, day, source, model,
        total_tokens, input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, updated_at
      ) values (
        v_user_id, v_day, v_source, v_model,
        d_total, d_input, d_cached, d_output, d_reasoning, now()
      ) on conflict (user_id, day, source, model)
      do update set
        total_tokens = public.tokentracker_daily_rollup.total_tokens + excluded.total_tokens,
        input_tokens = public.tokentracker_daily_rollup.input_tokens + excluded.input_tokens,
        cached_input_tokens = public.tokentracker_daily_rollup.cached_input_tokens + excluded.cached_input_tokens,
        output_tokens = public.tokentracker_daily_rollup.output_tokens + excluded.output_tokens,
        reasoning_output_tokens = public.tokentracker_daily_rollup.reasoning_output_tokens + excluded.reasoning_output_tokens,
        updated_at = now();

      return null;
    end if;

    v_day := (new.hour_start at time zone 'UTC')::date;
    v_user_id := new.user_id;
    v_source := new.source;
    v_model := new.model;
    d_total := coalesce(new.total_tokens, 0) - coalesce(old.total_tokens, 0);
    d_input := coalesce(new.input_tokens, 0) - coalesce(old.input_tokens, 0);
    d_cached := coalesce(new.cached_input_tokens, 0) - coalesce(old.cached_input_tokens, 0);
    d_output := coalesce(new.output_tokens, 0) - coalesce(old.output_tokens, 0);
    d_reasoning := coalesce(new.reasoning_output_tokens, 0) - coalesce(old.reasoning_output_tokens, 0);
  end if;

  insert into public.tokentracker_daily_rollup (
    user_id, day, source, model,
    total_tokens, input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, updated_at
  ) values (
    v_user_id, v_day, v_source, v_model,
    d_total, d_input, d_cached, d_output, d_reasoning, now()
  ) on conflict (user_id, day, source, model)
  do update set
    total_tokens = public.tokentracker_daily_rollup.total_tokens + excluded.total_tokens,
    input_tokens = public.tokentracker_daily_rollup.input_tokens + excluded.input_tokens,
    cached_input_tokens = public.tokentracker_daily_rollup.cached_input_tokens + excluded.cached_input_tokens,
    output_tokens = public.tokentracker_daily_rollup.output_tokens + excluded.output_tokens,
    reasoning_output_tokens = public.tokentracker_daily_rollup.reasoning_output_tokens + excluded.reasoning_output_tokens,
    updated_at = now();

  return null;
end;
$$ language plpgsql;

drop trigger if exists tokentracker_hourly_daily_rollup_trg on public.tokentracker_hourly;
create trigger tokentracker_hourly_daily_rollup_trg
after insert or update or delete on public.tokentracker_hourly
for each row execute function public.tokentracker_apply_daily_rollup_delta();
