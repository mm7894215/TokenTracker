-- Pricing sync health check for OpenRouter rows.
-- Run in InsForge SQL console or via admin tooling.

-- 1) Freshness check (expect is_fresh = true for 6h schedule, allow 12h drift).
select
  max(created_at) as last_created_at,
  (max(created_at) >= now() - interval '12 hours') as is_fresh
from tokentracker_pricing_profiles
where source = 'openrouter';

-- 2) Active rows for the latest effective date.
with latest as (
  select max(effective_from) as effective_from
  from tokentracker_pricing_profiles
  where source = 'openrouter' and active = true
)
select effective_from, count(*) as active_rows
from tokentracker_pricing_profiles
where source = 'openrouter'
  and active = true
  and effective_from = (select effective_from from latest)
group by effective_from;

-- 3) Default model presence (exact or suffix match).
select model, source, effective_from, active, created_at
from tokentracker_pricing_profiles
where source = 'openrouter'
  and (model = 'gpt-5.2-codex' or model like '%/gpt-5.2-codex')
order by effective_from desc, created_at desc
limit 1;

-- 4) Unmatched usage models (no pricing match and no alias).
with usage_models as (
  select distinct lower(trim(model)) as model
  from tokentracker_hourly
  where model is not null
    and trim(model) <> ''
    and lower(trim(model)) <> 'unknown'
    and hour_start >= now() - interval '30 days'
),
pricing_models as (
  select distinct lower(trim(model)) as model
  from tokentracker_pricing_profiles
  where source = 'openrouter' and active = true
),
aliases as (
  select distinct lower(trim(usage_model)) as usage_model
  from tokentracker_pricing_model_aliases
  where pricing_source = 'openrouter' and active = true
),
matches as (
  select u.model as usage_model,
         exists (
           select 1
           from pricing_models p
           where p.model = u.model
              or p.model like '%' || '/' || u.model
              or u.model like '%' || '/' || p.model
         ) as has_pricing,
         exists (
           select 1
           from aliases a
           where a.usage_model = u.model
         ) as has_alias
  from usage_models u
)
select usage_model
from matches
where has_pricing = false and has_alias = false
order by usage_model;
