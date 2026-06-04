import React, { useEffect, useState } from "react";
import { useInsforgeAuth } from "../contexts/InsforgeAuthContext";
import { getOrCreateInsforgeClient } from "../lib/insforge-config";

/**
 * /device — OAuth-style device flow approval page.
 *
 * Pairs a headless CLI session (SSH / Docker / CI) with the user's browser
 * sign-in. The CLI prints an 8-char user_code; the user opens this page,
 * signs in if they aren't already, types the code, hits Approve, and the
 * CLI's next poll comes back with the granted user_id.
 *
 * Deep-link: `…/device?user_code=XXXX-XXXX` pre-fills the input.
 */

function buildGrantUrl() {
  // The Insforge baseUrl drives both the SDK and the edge functions; reading
  // from getOrCreateInsforgeClient() avoids hardcoding the production URL
  // here (dev/staging may differ).
  const client = getOrCreateInsforgeClient();
  // SDK doesn't expose its baseUrl as a public field; fall back to the same
  // VITE env var that initialized the client.
  const baseUrl =
    (import.meta.env && import.meta.env.VITE_INSFORGE_BASE_URL) ||
    "https://srctyff5.us-east.insforge.app";
  return `${baseUrl.replace(/\/$/, "")}/functions/tokentracker-device-flow-grant`;
}

function normalizeUserCode(s) {
  return (s || "").toUpperCase().replace(/\s+/g, "").replace(/[^A-Z0-9-]/g, "");
}

export default function DevicePage() {
  const auth = useInsforgeAuth();
  const [userCode, setUserCode] = useState("");
  const [status, setStatus] = useState({ kind: "idle", message: "" });

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const prefill = params.get("user_code");
      if (prefill) setUserCode(normalizeUserCode(prefill));
    } catch { /* ignore */ }
  }, []);

  async function onSubmit(event) {
    event?.preventDefault?.();
    if (!auth?.signedIn) {
      setStatus({ kind: "error", message: "Please sign in first." });
      return;
    }
    const code = normalizeUserCode(userCode);
    if (!/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/.test(code)) {
      setStatus({ kind: "error", message: "Invalid code format. Expected XXXX-XXXX." });
      return;
    }
    setStatus({ kind: "working", message: "Approving…" });
    try {
      const token = await auth.getAccessToken?.();
      if (!token) {
        setStatus({ kind: "error", message: "No access token — please sign in again." });
        return;
      }
      const res = await fetch(buildGrantUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ user_code: code }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setStatus({
          kind: "success",
          message:
            body.status === "already_approved"
              ? `Already approved earlier${body.client_info ? " (" + body.client_info + ")" : ""}.`
              : `Approved${body.client_info ? " for " + body.client_info : ""}. You can close this tab — your CLI will pick it up within a few seconds.`,
        });
      } else if (res.status === 404) {
        setStatus({ kind: "error", message: "Code not found. Double-check what your CLI printed." });
      } else if (res.status === 410) {
        setStatus({ kind: "error", message: "Code expired. Re-run `tracker device-login` and try again." });
      } else if (res.status === 401) {
        setStatus({ kind: "error", message: "Session expired. Sign out, sign in, and try again." });
      } else {
        setStatus({
          kind: "error",
          message: body?.error || `Server error (HTTP ${res.status}).`,
        });
      }
    } catch (e) {
      setStatus({ kind: "error", message: `Network error: ${e?.message || e}` });
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-white dark:bg-oai-gray-950 px-6 py-12">
      <div className="w-full max-w-md rounded-xl border border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-900 p-8">
        <h1 className="text-2xl font-semibold text-oai-gray-900 dark:text-white mb-2">
          Approve your CLI
        </h1>
        <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400 mb-6">
          {"Type the code your CLI showed you. We'll link it to your account so token usage from that machine flows into your leaderboard profile."}
        </p>

        {!auth?.signedIn ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-800 p-4 mb-4">
            <p className="text-sm text-amber-700 dark:text-amber-300">
              Sign in first, then return to this page.
            </p>
          </div>
        ) : null}

        <form onSubmit={onSubmit} className="space-y-4">
          <label className="block">
            <span className="block text-xs font-medium uppercase tracking-wide text-oai-gray-500 dark:text-oai-gray-400 mb-1">
              CLI code
            </span>
            <input
              type="text"
              value={userCode}
              onChange={(e) => setUserCode(normalizeUserCode(e.target.value))}
              placeholder="XXXX-XXXX"
              spellCheck={false}
              autoCapitalize="characters"
              maxLength={9}
              className="w-full font-mono text-xl tracking-widest text-center rounded-md border border-oai-gray-300 dark:border-oai-gray-700 bg-white dark:bg-oai-gray-900 text-oai-gray-900 dark:text-white px-4 py-3 focus:outline-none focus:ring-inset focus:ring-2 focus:ring-emerald-600"
            />
          </label>

          <button
            type="submit"
            disabled={status.kind === "working" || !auth?.signedIn}
            className="w-full rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:bg-oai-gray-300 disabled:cursor-not-allowed text-white font-medium py-3 transition-colors"
          >
            {status.kind === "working" ? "Approving…" : "Approve"}
          </button>
        </form>

        {status.kind === "success" && (
          <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-800 p-4">
            <p className="text-sm text-emerald-700 dark:text-emerald-300">{status.message}</p>
          </div>
        )}
        {status.kind === "error" && (
          <div className="mt-4 rounded-md border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-800 p-4">
            <p className="text-sm text-red-700 dark:text-red-300">{status.message}</p>
          </div>
        )}
      </div>
    </div>
  );
}
