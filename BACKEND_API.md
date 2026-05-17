# VibeUsage Backend API (InsForge Edge Functions)

This document describes the public Edge Function endpoints used by the VibeUsage tracker (CLI) and dashboard.

## Source of truth (important)

- Author source code lives in `insforge-src/`.
- Deployable artifacts live in `insforge-functions/` and are generated (single-file).
- Do not hand-edit `insforge-functions/*.js`; edit `insforge-src/` and rebuild.

## Build & deploy

Build deploy artifacts:

```bash
npm run build:insforge
```

Verify artifacts are up to date (no writes):

```bash
npm run build:insforge:check
```

Deploy (example):

```bash
# Update code only; keep existing slugs.
insforge2 update-function --slug vibeusage-usage-summary --codeFile insforge-functions/vibeusage-usage-summary.js
```

## Auth models

- **User JWT** endpoints: `Authorization: Bearer <user_jwt>`
  - Used by dashboard and user settings.
- **Device token** endpoints: `Authorization: Bearer <device_token>`
  - Used by CLI ingestion; long-lived; server stores only sha256 hash.

Local user JWT verification uses `INSFORGE_JWT_SECRET` (HS256) in the Edge Functions environment. It must match the JWT signing secret.

All endpoints support CORS `OPTIONS` preflight.

## Endpoint base paths

- Public edge functions are served at `/functions/<slug>` (CORS enabled).
- Admin API path `/api/functions/<slug>` requires a project admin API key and is **not** suitable for browser clients.
- Dashboard uses `/functions` and only falls back to `/api/functions` on 404 in privileged contexts.

## CLI troubleshooting (timeouts + debug)

When ingestion hangs or fails, use these client-side controls:

- `VIBEUSAGE_HTTP_TIMEOUT_MS`: HTTP request timeout in milliseconds. `0` disables timeouts. Default `20000`. Clamped to `1000..120000`.
- `VIBEUSAGE_DEBUG=1` or `--debug`: print request/response timing and original backend errors to stderr.

Examples:

```bash
VIBEUSAGE_HTTP_TIMEOUT_MS=60000 npx --yes vibeusage sync --debug
```

## Pricing configuration

Pricing metadata is resolved from `vibeusage_pricing_profiles`. The default pricing profile is selected by:

- `VIBEUSAGE_PRICING_SOURCE` (default `openrouter`)
- `VIBEUSAGE_PRICING_MODEL` (default `gpt-5.2-codex`; exact match or `*/<model>` suffix match)

OpenRouter sync requires these environment variables in InsForge:

- `OPENROUTER_API_KEY` (required)
- `OPENROUTER_HTTP_REFERER` (optional, for attribution)
- `OPENROUTER_APP_TITLE` (optional, for attribution)

Health check:

- See `docs/ops/pricing-sync-health.md` and `scripts/ops/pricing-sync-health.sql`.

Alias mapping:

- `vibeusage_pricing_model_aliases` maps `usage_model` -> `pricing_model` with `effective_from`.
- Resolver checks alias mapping before suffix matching.
- Prefixed usage models require explicit aliases; without one, pricing falls back to the default profile (no suffix inference).

## Usage guardrails & observability

To reduce runaway scans and runtime resets, usage read endpoints enforce bounded ranges and emit slow-query logs.

- `VIBEUSAGE_USAGE_MAX_DAYS`: max day span for `GET /functions/vibeusage-usage-summary`, `.../vibeusage-usage-daily`, and `.../vibeusage-usage-model-breakdown`. Default `800`. Oversized ranges return `400` with `Date range too large (max N days)`.
- `VIBEUSAGE_SLOW_QUERY_MS`: slow-query log threshold in milliseconds. Default `2000`. When exceeded, a `stage: slow_query` log is emitted with `query_label`, `duration_ms`, and `row_count`.

## Client backpressure defaults

To keep low-tier backends stable, the CLI and dashboard apply conservative defaults:

- CLI auto sync interval: ~10 minutes (with jitter)
- CLI batch size: 300 (max batches per auto run: 2 small / 4 large)
- Dashboard backend probe: every 60 seconds, paused when the tab is hidden

## Endpoints

**Timezone note:** Usage endpoints accept `tz` (IANA) or `tz_offset_minutes` (fixed offset). When provided and non-UTC, date boundaries are interpreted in that timezone. When omitted, usage endpoints default to UTC behavior.

**Canary note:** Usage endpoints exclude `source=model=canary` buckets by default unless explicitly requested via `source=canary` or `model=canary`.

### POST /functions/vibeusage-device-token-issue

Issue a long-lived device token for the current user.

Auth:

- User mode: `Authorization: Bearer <user_jwt>`
- Admin bootstrap (optional): `Authorization: Bearer <service_role_key>` with `user_id` in body

Request body:

```json
{ "device_name": "my-mac", "platform": "macos" }
```

Response:

```json
{ "device_id": "uuid", "token": "opaque", "created_at": "iso" }
```

---

### POST /functions/vibeusage-link-code-init

Issue a short-lived, single-use link code bound to the current user session.

Auth:

- `Authorization: Bearer <user_jwt>`

Request body:

```json
{}
```

Response:

```json
{ "link_code": "string", "expires_at": "iso" }
```

Notes:

- Link codes expire after ~10 minutes.
- Each link code can be used once.

---

### POST /functions/vibeusage-link-code-exchange

Exchange a link code for a device token (CLI init flow).

Auth:

- None (public function; server uses service role internally)

Request body:

```json
{
  "link_code": "string",
  "request_id": "string",
  "device_name": "string?",
  "platform": "string?"
}
```

Response:

```json
{ "token": "opaque", "device_id": "uuid", "user_id": "uuid" }
```

Notes:

- `request_id` is required for replay safety; retries with the same `request_id` return the same token.
- Expired link codes return `400` and used codes return `409`.

---

### GET /functions/vibeusage-public-view-profile

Return privacy-safe profile fields for a public share token.

Auth:

- `Authorization: Bearer <share_token>`

Response:

```json
{ "display_name": "string|null", "avatar_url": "string|null" }
```

Notes:

- `display_name` is derived from user metadata and sanitized; email-like values are removed.
- `avatar_url` is returned only for `http/https` URLs with length ≤ 1024; otherwise `null`.

---

### POST /functions/vibeusage-ingest

Ingest half-hour token usage aggregates from a device token idempotently.

Auth:

- `Authorization: Bearer <device_token>`

Request body:

```json
{
  "hourly": [
    {
      "hour_start": "2025-12-23T06:00:00.000Z",
      "source": "codex",
      "model": "unknown",
      "input_tokens": 0,
      "cached_input_tokens": 0,
      "output_tokens": 0,
      "reasoning_output_tokens": 0,
      "total_tokens": 0
    }
  ],
  "device_subscriptions": [
    {
      "tool": "codex",
      "provider": "openai",
      "product": "chatgpt",
      "planType": "pro"
    },
    {
      "tool": "claude",
      "provider": "anthropic",
      "product": "subscription",
      "planType": "max",
      "rateLimitTier": "default_claude_max_5x"
    }
  ]
}
```

Response:

```json
{
  "success": true,
  "inserted": 123,
  "skipped": 0,
  "project_inserted": 0,
  "project_skipped": 0
}
```

Notes:

- `hour_start` must be a UTC half-hour boundary ISO timestamp (`:00` or `:30`).
- `source` is optional; when missing or empty, it defaults to `codex`.
- `model` is optional; when missing or empty, it defaults to `unknown`.
- Uploads are upserts keyed by `user_id + device_id + source + model + hour_start`.
- `device_subscriptions` is optional and stores latest tool subscription markers (`user_id + tool + provider + product` upsert).
- Backward compatibility: `{ "data": { "hourly": [...] } }` is accepted, but `{ "hourly": [...] }` remains canonical.
- `hour_start` is the usage-time bucket. Database `created_at`/`updated_at` reflect ingest/upsert time, so many rows can share the same timestamp when a batch is uploaded.
- Internal observability: ingest requests also write a best-effort metrics row to `vibeusage_tracker_ingest_batches` (project_admin only). Fields include `bucket_count`, `inserted`, `skipped`, `source`, `user_id`, `device_id`, and `created_at`. No prompt/response content is stored.
- Retention: `POST /functions/vibeusage-events-retention` supports `include_ingest_batches` to purge ingest batch metrics older than the cutoff.
- When concurrency limits are exceeded, the endpoint may return `429` with `Retry-After` to signal backoff. The guard is opt-in via `VIBEUSAGE_INGEST_MAX_INFLIGHT`.

---

### POST /functions/vibeusage-sync-ping

Record a throttled sync heartbeat for a device token. Used to distinguish “unsynced” from “no usage”.

Auth:

- `Authorization: Bearer <device_token>`

Response:

```json
{
  "success": true,
  "updated": true,
  "last_sync_at": "2025-12-22T12:30:00Z",
  "min_interval_minutes": 30
}
```

---

### GET /functions/vibeusage-user-status

Return Pro status for the authenticated user.

Auth:

- `Authorization: Bearer <user_jwt>`

Response:

```json
{
  "user_id": "uuid",
  "created_at": "iso|null",
  "pro": {
    "active": true,
    "sources": ["registration_cutoff", "entitlement"],
    "expires_at": "iso",
    "partial": false,
    "as_of": "iso"
  },
  "subscriptions": {
    "partial": false,
    "as_of": "iso",
    "items": [
      {
        "tool": "codex",
        "provider": "openai",
        "product": "chatgpt",
        "plan_type": "pro",
        "rate_limit_tier": null,
        "active_start": null,
        "active_until": null,
        "last_checked": null,
        "observed_at": "iso|null",
        "updated_at": "iso|null"
      }
    ]
  }
}
```

Notes:

- Registration cutoff is fixed at `2025-12-31T23:59:59` Asia/Shanghai (`2025-12-31T15:59:59Z`).
- Registration-based Pro expires at `created_at + 99 years`.
- Entitlements are active when `now_utc` is in `[effective_from, effective_to)` and `revoked_at IS NULL`.
- When `created_at` is unavailable and no service-role key is configured, the endpoint returns a partial result (`created_at: null`, `pro.partial: true`) computed from entitlements only.
- `subscriptions.partial` may be `true` when the subscription table has not been migrated yet; in that case `items` falls back to an empty list.

---

### POST /functions/vibeusage-entitlements

Grant an entitlement for a user (admin only).

Auth:

- `Authorization: Bearer <service_role_key>` or a `project_admin` JWT

Request body:

```json
{
  "id": "uuid?",
  "idempotency_key": "string?",
  "user_id": "uuid",
  "source": "paid|override|manual",
  "effective_from": "iso",
  "effective_to": "iso",
  "note": "string?"
}
```

Response:

```json
{
  "id": "uuid",
  "user_id": "uuid",
  "source": "manual",
  "effective_from": "iso",
  "effective_to": "iso",
  "revoked_at": null,
  "note": "string?",
  "created_at": "iso",
  "updated_at": "iso"
}
```

Notes:

- For idempotent retries, send a stable `id` or `idempotency_key` (the backend derives a deterministic id).
- If the `id` or `idempotency_key` already exists with a different payload, the endpoint returns `409`.

---

### POST /functions/vibeusage-entitlements-revoke

Revoke an entitlement by id (admin only).

Auth:

- `Authorization: Bearer <service_role_key>` or a `project_admin` JWT

Request body:

```json
{ "id": "uuid", "revoked_at": "iso?" }
```

Response:

```json
{ "id": "uuid", "revoked_at": "iso" }
```

---

### GET /functions/vibeusage-usage-summary

Return token usage totals for the authenticated user over a date range in the requested timezone (default UTC).

Auth:

- `Authorization: Bearer <user_jwt>`

Query:

- `from=YYYY-MM-DD` (optional; default last 30 days)
- `to=YYYY-MM-DD` (optional; default today in requested timezone)
- `source=codex|every-code|...` (optional; filter by source; omit to aggregate all sources)
- `model=<model-id>` (optional; filter by model; omit to aggregate all models)
- `tz=IANA` (optional; e.g. `America/Los_Angeles`)
- `tz_offset_minutes` (optional; fixed offset minutes from UTC to local, e.g. `-480`)
- `debug=1` (optional; include debug payload for query timing)

Response (bigints as strings):

```json
{
  "from": "YYYY-MM-DD",
  "to": "YYYY-MM-DD",
  "days": 30,
  "model_id": "gpt-5.2-codex",
  "model": "gpt-5.2-codex",
  "totals": {
    "total_tokens": "0",
    "input_tokens": "0",
    "cached_input_tokens": "0",
    "output_tokens": "0",
    "reasoning_output_tokens": "0",
    "total_cost_usd": "0.000000"
  },
  "pricing": {
    "model": "gpt-5.2-codex",
    "pricing_mode": "overlap",
    "source": "openrouter",
    "effective_from": "2025-12-23",
    "rates_per_million_usd": {
      "input": "1.750000",
      "cached_input": "0.175000",
      "output": "14.000000",
      "reasoning_output": "14.000000"
    }
  }
}
```

Notes:

- Pricing metadata is resolved from `vibeusage_pricing_profiles` using the configured default model/source and the latest `effective_from` not in the future (`active=true`).
- If no pricing rows exist, the endpoint falls back to the built-in default profile.
- `pricing_mode` is `add`, `overlap`, or `mixed` (multiple pricing modes across sources).
- `model` query uses canonical model id; the backend expands it only to explicit active aliases for the date range (no implicit suffix matching).
- `model_id`/`model` are `null` when no model filter is supplied.
- When `debug=1` is set, the response includes a `debug` object with `request_id`, `status`, `query_ms`, `slow_threshold_ms`, `slow_query`.

---

### GET /functions/vibeusage-project-usage-summary

Return top project usage totals for the authenticated user across all recorded history.

Auth:

- `Authorization: Bearer <user_jwt>`

Query:

- `source=codex|every-code|...` (optional; filter by source; omit to aggregate all sources)
- `limit=1..10` (optional; default 3)
- `debug=1` (optional; include debug payload for query timing)
- `from`, `to`, `tz`, `tz_offset_minutes` are accepted for compatibility but ignored (all-time totals only).

Response (bigints as strings):

```json
{
  "from": null,
  "to": null,
  "all_time": true,
  "generated_at": "iso",
  "entries": [
    {
      "project_key": "owner/repo",
      "project_ref": "https://github.com/owner/repo",
      "total_tokens": "0",
      "billable_total_tokens": "0"
    }
  ]
}
```

Notes:

- Results are sorted by `billable_total_tokens` descending.
- When `debug=1` is set, the response includes a `debug` object with `request_id`, `status`, `query_ms`, `slow_threshold_ms`, `slow_query`.

---

### GET /functions/vibeusage-usage-model-breakdown

Return per-source and per-model aggregates for a date range. This endpoint is intended for model mix and cost breakdown UI.

Auth:

- `Authorization: Bearer <user_jwt>`

Query:

- `from=YYYY-MM-DD` (optional; default last 30 days)
- `to=YYYY-MM-DD` (optional; default today in requested timezone)
- `source=codex|every-code|...` (optional; filter by source; omit to aggregate all sources)
- `tz=IANA` (optional; e.g. `America/Los_Angeles`)
- `tz_offset_minutes` (optional; fixed offset minutes from UTC to local, e.g. `-480`)
- `debug=1` (optional; include debug payload for query timing)

Notes:

- `model` is not accepted because this endpoint already returns per-model groups.
- Model groups are aggregated by canonical `model_id` across sources; `model` is the display name.
- Pricing metadata is resolved from `vibeusage_pricing_profiles`. If the range contains exactly one non-`unknown` model, pricing is resolved for that model; otherwise it falls back to the configured default profile.
- `pricing_mode` is `add`, `overlap`, or `mixed` (multiple pricing modes across sources).
- When `debug=1` is set, the response includes a `debug` object with `request_id`, `status`, `query_ms`, `slow_threshold_ms`, `slow_query`.

Response (bigints as strings):

```json
{
  "from": "YYYY-MM-DD",
  "to": "YYYY-MM-DD",
  "days": 30,
  "sources": [
    {
      "source": "codex",
      "totals": {
        "total_tokens": "0",
        "input_tokens": "0",
        "cached_input_tokens": "0",
        "output_tokens": "0",
        "reasoning_output_tokens": "0",
        "total_cost_usd": "0.000000"
      },
      "models": [
        {
          "model_id": "gpt-5.2-codex",
          "model": "gpt-5.2-codex",
          "totals": {
            "total_tokens": "0",
            "input_tokens": "0",
            "cached_input_tokens": "0",
            "output_tokens": "0",
            "reasoning_output_tokens": "0",
            "total_cost_usd": "0.000000"
          }
        }
      ]
    }
  ],
  "pricing": {
    "model": "gpt-5.2-codex",
    "pricing_mode": "overlap",
    "source": "openrouter",
    "effective_from": "2025-12-23",
    "rates_per_million_usd": {
      "input": "1.750000",
      "cached_input": "0.175000",
      "output": "14.000000",
      "reasoning_output": "14.000000"
    }
  }
}
```

---

### GET /functions/vibeusage-usage-daily

Return daily aggregates for the authenticated user in the requested timezone (default UTC).

Auth:

- `Authorization: Bearer <user_jwt>`

Query:

- `from=YYYY-MM-DD` (optional; default last 30 days)
- `to=YYYY-MM-DD` (optional; default today in requested timezone)
- `source=codex|every-code|...` (optional; filter by source; omit to aggregate all sources)
- `model=<model-id>` (optional; filter by model; omit to aggregate all models)
- `tz=IANA` (optional; e.g. `America/Los_Angeles`)
- `tz_offset_minutes` (optional; fixed offset minutes from UTC to local, e.g. `-480`)

Response:

```json
{
  "from": "YYYY-MM-DD",
  "to": "YYYY-MM-DD",
  "model_id": "gpt-5.2-codex",
  "model": "gpt-5.2-codex",
  "data": [
    {
      "day": "YYYY-MM-DD",
      "total_tokens": "0",
      "input_tokens": "0",
      "cached_input_tokens": "0",
      "output_tokens": "0",
      "reasoning_output_tokens": "0"
    }
  ],
  "summary": {
    "totals": {
      "total_tokens": "0",
      "input_tokens": "0",
      "cached_input_tokens": "0",
      "output_tokens": "0",
      "reasoning_output_tokens": "0",
      "total_cost_usd": "0.000000"
    },
    "pricing": {
      "model": "gpt-5.2-codex",
      "pricing_mode": "overlap",
      "source": "openrouter",
      "effective_from": "2025-12-23",
      "rates_per_million_usd": {
        "input": "1.750000",
        "cached_input": "0.175000",
        "output": "14.000000",
        "reasoning_output": "14.000000"
      }
    }
  }
}
```

Notes:

- `model` query uses canonical model id; the backend expands it only to explicit active aliases for the date range (no implicit suffix matching).
- `model_id`/`model` are `null` when no model filter is supplied.
- The response includes backend-computed `summary` totals; the dashboard MUST NOT compute totals locally.
- When `debug=1` is set, the response includes a `debug` object with `request_id`, `status`, `query_ms`, `slow_threshold_ms`, `slow_query`.

---

### GET /functions/vibeusage-usage-hourly

Return half-hour aggregates (48 buckets) for the authenticated user on a given local day (timezone-aware; default UTC).

Auth:

- `Authorization: Bearer <user_jwt>`

Query:

- `day=YYYY-MM-DD` (optional; default today in requested timezone)
- `source=codex|every-code|...` (optional; filter by source; omit to aggregate all sources)
- `model=<model-id>` (optional; filter by model; omit to aggregate all models)
- `tz=IANA` (optional; e.g. `America/Los_Angeles`)
- `tz_offset_minutes` (optional; fixed offset minutes from UTC to local, e.g. `-480`)
- `debug=1` (optional; include debug payload for query timing)

Response:

```json
{
  "day": "YYYY-MM-DD",
  "data": [
    {
      "hour": "YYYY-MM-DDTHH:00:00",
      "total_tokens": "0",
      "input_tokens": "0",
      "cached_input_tokens": "0",
      "output_tokens": "0",
      "reasoning_output_tokens": "0",
      "missing": true
    }
  ],
  "sync": {
    "last_sync_at": "2025-12-22T12:30:00Z",
    "min_interval_minutes": 30
  }
}
```

Notes:

- `model` query uses canonical model id; the backend expands it only to explicit active aliases for the date range (no implicit suffix matching).
- When `debug=1` is set, the response includes a `debug` object with `request_id`, `status`, `query_ms`, `slow_threshold_ms`, `slow_query`.

---

### GET /functions/vibeusage-usage-monthly

Return monthly aggregates for the authenticated user aligned to local months (timezone-aware; default UTC).

Auth:

- `Authorization: Bearer <user_jwt>`

Query:

- `months=1..24` (optional; default `24`)
- `to=YYYY-MM-DD` (optional; default today in requested timezone)
- `source=codex|every-code|...` (optional; filter by source; omit to aggregate all sources)
- `model=<model-id>` (optional; filter by model; omit to aggregate all models)
- `tz=IANA` (optional; e.g. `America/Los_Angeles`)
- `tz_offset_minutes` (optional; fixed offset minutes from UTC to local, e.g. `-480`)
- `debug=1` (optional; include debug payload for query timing)

Response:

```json
{
  "from": "YYYY-MM-DD",
  "to": "YYYY-MM-DD",
  "months": 24,
  "data": [
    {
      "month": "YYYY-MM",
      "total_tokens": "0",
      "input_tokens": "0",
      "cached_input_tokens": "0",
      "output_tokens": "0",
      "reasoning_output_tokens": "0"
    }
  ]
}
```

Notes:

- `model` query uses canonical model id; the backend expands it only to explicit active aliases for the date range (no implicit suffix matching).
- When `debug=1` is set, the response includes a `debug` object with `request_id`, `status`, `query_ms`, `slow_threshold_ms`, `slow_query`.

---

### GET /functions/vibeusage-usage-heatmap

Return a GitHub-inspired activity heatmap derived from local daily totals (timezone-aware; default UTC).

Auth:

- `Authorization: Bearer <user_jwt>`

Query:

- `weeks=1..104` (optional; default `52`)
- `to=YYYY-MM-DD` (optional; default today in requested timezone)
- `week_starts_on=sun|mon` (optional; default `sun`)
- `source=codex|every-code|...` (optional; filter by source; omit to aggregate all sources)
- `model=<model-id>` (optional; filter by model; omit to aggregate all models)
- `tz=IANA` (optional; e.g. `America/Los_Angeles`)
- `tz_offset_minutes` (optional; fixed offset minutes from UTC to local, e.g. `-480`)
- `debug=1` (optional; include debug payload for query timing)

Response:

```json
{
  "from": "YYYY-MM-DD",
  "to": "YYYY-MM-DD",
  "week_starts_on": "sun",
  "thresholds": { "t1": "0", "t2": "0", "t3": "0" },
  "active_days": 0,
  "streak_days": 0,
  "weeks": [[{ "day": "YYYY-MM-DD", "value": "0", "level": 0 }, null]]
}
```

Notes:

- `weeks` is a list of week columns; each day cell is `{ day, value, level }` or `null` past the end date.
- `value` is a bigint-as-string.
- `model` query uses canonical model id; the backend expands it only to explicit active aliases for the date range (no implicit suffix matching).
- When `debug=1` is set, the response includes a `debug` object with `request_id`, `status`, `query_ms`, `slow_threshold_ms`, `slow_query`.

---

### GET /functions/vibeusage-leaderboard

Return token usage leaderboard for the current UTC period window.

Auth:

- Optional `Authorization: Bearer <user_jwt>`
- Anonymous requests are supported and return public rows only (`me=null`)

Query:

- `period=week|month|total` (required)
- `metric=all|gpt|claude|other` (optional; default `all`)
- `limit=1..100` (optional; default `20`)
- `offset=0..10000` (optional; default `0`)

Rules:

- `period=week`: UTC calendar week; week starts Sunday (UTC).
- `period=month`: UTC calendar month (1st..last day).
- `period=total`: all-time (represented as `from=1970-01-01` and `to=9999-12-31`).
- `metric=all` ranks by `total_tokens` where `total_tokens = gpt_tokens + claude_tokens + other_tokens`.
- `metric=gpt` ranks by `gpt_tokens` (users with `gpt_tokens=0` are excluded from `entries`; `me.rank` is `null` when `gpt_tokens=0`).
- `metric=claude` ranks by `claude_tokens` (users with `claude_tokens=0` are excluded from `entries`; `me.rank` is `null` when `claude_tokens=0`).
- `metric=other` ranks by `other_tokens` (users with `other_tokens=0` are excluded from `entries`; `me.rank` is `null` when `other_tokens=0`).
- Leaderboard source scope includes all sources except `source=canary` (no source whitelist).
- Unknown/unclassified models are included in the `other_tokens` bucket.
- Privacy-safe: no email and no raw logs.
- `entries[].is_public` is always a boolean.
- Public gating uses canonical `vibeusage_public_views` active state (`revoked_at IS NULL`) at read time.
- `entries[].user_id` is exposed only when `is_public=true`; otherwise it is `null`.
- When authenticated, response includes `me` (even when not in Top N).
- When anonymous, `me` is `null`.

Response:

```json
{
  "period": "week",
  "metric": "all",
  "from": "YYYY-MM-DD",
  "to": "YYYY-MM-DD",
  "generated_at": "iso",
  "page": 1,
  "limit": 20,
  "offset": 0,
  "total_entries": 0,
  "total_pages": 0,
  "entries": [
    {
      "user_id": null,
      "rank": 1,
      "is_me": false,
      "is_public": false,
      "display_name": "Anonymous",
      "avatar_url": null,
      "gpt_tokens": "0",
      "claude_tokens": "0",
      "other_tokens": "0",
      "total_tokens": "0"
    }
  ],
  "me": {
    "rank": null,
    "gpt_tokens": "0",
    "claude_tokens": "0",
    "other_tokens": "0",
    "total_tokens": "0"
  }
}
```

---

### GET /functions/vibeusage-leaderboard-profile

Return a single leaderboard snapshot entry for a requested `user_id` and period.

Auth:

- Optional `Authorization: Bearer <user_jwt>`
- Anonymous access is allowed for public profiles

Query:

- `user_id=<uuid>` (required)
- `period=week|month|total` (optional, default `week`)

Rules:

- Self access (authenticated and `user_id === me`) is always allowed.
- Non-self access requires active canonical public visibility (`vibeusage_public_views.revoked_at IS NULL`).
- Snapshot `is_public` is not used as authorization truth.

Response:

```json
{
  "period": "week",
  "from": "YYYY-MM-DD",
  "to": "YYYY-MM-DD",
  "generated_at": "iso",
  "entry": {
    "user_id": "uuid",
    "display_name": "string",
    "avatar_url": "string|null",
    "rank": 1,
    "gpt_tokens": "0",
    "claude_tokens": "0",
    "other_tokens": "0",
    "total_tokens": "0"
  }
}
```

---

### GET /functions/vibeusage-public-visibility

Read effective public visibility state for current user.

Auth:

- `Authorization: Bearer <user_jwt>`

Response:

```json
{ "enabled": true, "updated_at": "iso", "share_token": "pv1-<uuid>" }
```

Notes:

- `enabled` is canonical state from `vibeusage_public_views` active row (`revoked_at IS NULL`).
- `share_token` is present only when `enabled=true`.

---

### POST /functions/vibeusage-public-visibility

Toggle effective public visibility for current user.

Auth:

- `Authorization: Bearer <user_jwt>`

Request body:

```json
{ "enabled": true }
```

Response:

```json
{ "enabled": true, "updated_at": "iso", "share_token": "pv1-<uuid>" }
```

Notes:

- `enabled=true`: upsert/activate public row (`revoked_at=null`).
- `enabled=false`: revoke public row (`revoked_at=now`).
- Hard-cut semantics: ON => visible immediately; OFF => hidden immediately.

---

### POST /functions/vibeusage-leaderboard-refresh

Rebuild leaderboard snapshots for the current UTC period window. Intended for automation (service role only).

Auth:

- `Authorization: Bearer <service_role_key>`

Query (optional):

- `period=week|month|total` (when omitted, refreshes `week` + `month`)

Response:

```json
{
  "success": true,
  "generated_at": "iso",
  "results": [{ "period": "week", "from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "inserted": 42 }]
}
```

Manual refresh runbook:

```bash
BASE_URL="https://srctyff5.us-east.insforge.app"
ADMIN_TOKEN="<service_role_key>"

curl -s -X POST "$BASE_URL/functions/vibeusage-leaderboard-refresh?period=week" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data "{}"

curl -s -X POST "$BASE_URL/functions/vibeusage-leaderboard-refresh?period=month" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data "{}"

curl -s -X POST "$BASE_URL/functions/vibeusage-leaderboard-refresh?period=total" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data "{}"
```

Verification:

```bash
curl -s "$BASE_URL/functions/vibeusage-leaderboard?period=week" \
  -H "Authorization: Bearer <user_jwt>"
```

---

### Retired endpoints (hard-cut)

The following endpoints are retired and return `410 Gone` with `{ "error": "Endpoint retired" }`:

- `POST /functions/vibeusage-leaderboard-settings`
- `GET /functions/vibeusage-public-view-status`
- `POST /functions/vibeusage-public-view-issue`
- `POST /functions/vibeusage-public-view-revoke`

Use `GET/POST /functions/vibeusage-public-visibility` instead.

---

### POST /functions/vibeusage-pricing-sync

Sync OpenRouter Models API pricing into `vibeusage_pricing_profiles` (admin only).

Auth:

- `Authorization: Bearer <service_role_key>`

Request body:

```json
{ "retention_days": 90, "effective_from": "2025-12-25", "allow_models": ["gpt-5.2-codex"] }
```

Notes:

- `retention_days` is optional; when provided, rows older than the cutoff are soft-deactivated (`active=false`).
- `effective_from` defaults to today (UTC).
- `allow_models` is optional; when omitted, all models from OpenRouter are processed.
- Alias generation: unmatched usage models are mapped via vendor rules (`claude-*` -> `anthropic/*`, `gpt-*` -> `openai/*`) and frozen by `effective_from`.

Response:

```json
{
  "success": true,
  "source": "openrouter",
  "effective_from": "2025-12-25",
  "models_total": 300,
  "models_processed": 280,
  "models_skipped": 20,
  "rows_upserted": 280,
  "usage_models_total": 42,
  "aliases_generated": 5,
  "aliases_upserted": 5,
  "retention": { "retention_days": 90, "cutoff_date": "2025-09-26" }
}
```

---

### POST /functions/vibeusage-events-retention

Purge legacy tracker events older than a cutoff (admin only).

Auth:

- `Authorization: Bearer <service_role_key>`

Request body:

```json
{ "days": 30, "dry_run": false }
```

Response:

```json
{ "ok": true, "dry_run": false, "days": 30, "cutoff": "iso", "deleted": 123 }
```

---

### GET /functions/vibeusage-debug-auth

Diagnostic endpoint that reports whether the function runtime has the anon key
configured and whether the supplied bearer token validates. This does **not**
expose any secrets.

Auth:

- Optional `Authorization: Bearer <user_jwt>` to validate the token.

Response:

```json
{
  "hasAnonKey": true,
  "hasBearer": true,
  "authOk": true,
  "userId": "uuid",
  "error": null
}
```
