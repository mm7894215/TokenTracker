// Local-only session browser client. The backing endpoint retains the raw
// session id and local project path so the dashboard can offer one-click
// resume; it is never served from the cloud account view.
import { copy } from "./copy";

const SLUG = "tokentracker-sessions";

export type SessionSource = "claude" | "codex" | "grok";

export interface SessionRow {
  session_hash: string;
  session_id: string | null;
  title: string | null;
  source: SessionSource;
  project_key: string;
  project_ref: string | null;
  model: string;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number;
  turns: number;
  edit_turns: number;
  retry_turns: number;
  subagent_calls: number;
  total_tokens: number;
  cost_usd: number;
  productive: boolean;
  first_pass: boolean;
  resume_command: string | null;
}

export interface SessionsResponse {
  from: string;
  to: string;
  available: boolean;
  session_count: number;
  returned_count: number;
  sessions: SessionRow[];
  provenance?: Record<string, unknown>;
  error?: string;
}

interface FetchOptions {
  from?: string;
  to?: string;
  limit?: number;
  refresh?: boolean;
}

export async function getSessions(options: FetchOptions = {}): Promise<SessionsResponse> {
  const url = new URL(`/functions/${SLUG}`, window.location.origin);
  if (options.from) url.searchParams.set("from", options.from);
  if (options.to) url.searchParams.set("to", options.to);
  if (options.limit) url.searchParams.set("limit", String(options.limit));
  if (options.refresh) url.searchParams.set("refresh", "1");
  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    // A 404 here means the local server predates this endpoint — i.e. a desktop
    // app whose bundled EmbeddedServer is older than the dashboard it hosts.
    // "HTTP 404" tells the user nothing actionable; "update the app" does.
    const fallback =
      response.status === 404
        ? copy("sessions.error.outdated_app")
        : `Request failed with HTTP ${response.status}`;
    const err = new Error(payload?.error || fallback) as Error & {
      status?: number;
    };
    err.status = response.status;
    throw err;
  }
  return payload as SessionsResponse;
}
