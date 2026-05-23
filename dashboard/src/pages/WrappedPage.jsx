import React, { useEffect, useState } from "react";
import { formatCompactNumber } from "../lib/format";

/**
 * /wrapped — year-end summary page.
 *
 * Fetches /functions/tokentracker-wrapped and renders the aggregator's
 * output as a card stack. No animation library (the visual lift comes
 * from the gradient + typography); this keeps the page work
 * predictably across SSR-less environments and reduced-motion users.
 */

// Wrap formatCompactNumber to add a T (trillion) suffix — the project-wide
// helper only ships K/M/B because no other dashboard surface ever needed T,
// but wrapped totals can plausibly cross 10^12 for power users.
function compactNumber(n) {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e12) return (n / 1e12).toFixed(2).replace(/\.?0+$/, "") + "T";
  return formatCompactNumber(n, { decimals: 2 });
}

function Card({ children, accent = false, className = "" }) {
  const base =
    "rounded-2xl border border-oai-gray-200 dark:border-oai-gray-800 p-6 bg-white dark:bg-oai-gray-900";
  const accentStyle = accent
    ? "bg-gradient-to-br from-emerald-50 to-cyan-50 dark:from-emerald-900/30 dark:to-cyan-900/30 border-transparent"
    : "";
  return <div className={`${base} ${accentStyle} ${className}`}>{children}</div>;
}

export default function WrappedPage() {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams(window.location.search);
    const year = params.get("year");
    const url = year
      ? `/functions/tokentracker-wrapped?year=${encodeURIComponent(year)}`
      : "/functions/tokentracker-wrapped";
    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => {
        if (cancelled) return;
        setData(j);
        setStatus(j.totals && j.totals.tokens > 0 ? "ready" : "empty");
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e?.message || e));
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === "loading") {
    return (
      <div className="min-h-screen bg-white dark:bg-oai-gray-950 flex items-center justify-center">
        <p className="text-oai-gray-500">Loading…</p>
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="min-h-screen bg-white dark:bg-oai-gray-950 flex items-center justify-center px-6">
        <Card>
          <p className="text-red-600 dark:text-red-300">Couldn't load Wrapped: {error}</p>
        </Card>
      </div>
    );
  }
  if (status === "empty" || !data) {
    return (
      <div className="min-h-screen bg-white dark:bg-oai-gray-950 flex items-center justify-center px-6">
        <Card>
          <p className="text-oai-gray-500">
            No data for that year yet. Run <code>tracker sync</code> first.
          </p>
        </Card>
      </div>
    );
  }

  const fmtShare = (s) => `${(s * 100).toFixed(0)}%`;

  return (
    <div className="min-h-screen bg-gradient-to-b from-white to-oai-gray-50 dark:from-oai-gray-950 dark:to-oai-gray-900 px-6 py-12">
      <div className="max-w-3xl mx-auto space-y-6">
        <header className="text-center pb-6">
          <p className="text-sm uppercase tracking-widest text-oai-gray-500 dark:text-oai-gray-400">
            TokenTracker Wrapped
          </p>
          <h1 className="text-6xl font-bold text-oai-gray-900 dark:text-white mt-2">
            {data.year}
          </h1>
        </header>

        <Card accent className="text-center">
          <p className="text-xs uppercase tracking-widest text-oai-gray-600 dark:text-oai-gray-300">
            Total tokens
          </p>
          <p className="text-7xl font-bold text-emerald-700 dark:text-emerald-300 mt-2">
            {compactNumber(data.totals.tokens)}
          </p>
          <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400 mt-4">
            across <strong>{data.totals.conversations.toLocaleString("en-US")}</strong> conversations,{" "}
            <strong>{data.totals.active_days}</strong> active days, and{" "}
            <strong>{data.totals.sources}</strong> tools
          </p>
        </Card>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card>
            <h3 className="text-xs uppercase tracking-widest text-oai-gray-500 dark:text-oai-gray-400 mb-4">
              Top tools
            </h3>
            <ul className="space-y-3">
              {data.top.sources.slice(0, 5).map((s) => (
                <li key={s.source} className="flex items-baseline justify-between">
                  <span className="text-oai-gray-900 dark:text-white">{s.source}</span>
                  <span className="text-oai-gray-500 dark:text-oai-gray-400 font-mono text-sm">
                    {compactNumber(s.tokens)} · {fmtShare(s.share)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <h3 className="text-xs uppercase tracking-widest text-oai-gray-500 dark:text-oai-gray-400 mb-4">
              Top models
            </h3>
            <ul className="space-y-3">
              {data.top.models.slice(0, 5).map((m) => (
                <li key={m.model} className="flex items-baseline justify-between">
                  <span className="text-oai-gray-900 dark:text-white truncate pr-3">{m.model}</span>
                  <span className="text-oai-gray-500 dark:text-oai-gray-400 font-mono text-sm whitespace-nowrap">
                    {compactNumber(m.tokens)} · {fmtShare(m.share)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {data.peak_hour && (
            <Card>
              <p className="text-xs uppercase tracking-widest text-oai-gray-500 dark:text-oai-gray-400">
                Peak hour
              </p>
              <p className="text-4xl font-semibold text-oai-gray-900 dark:text-white mt-2">
                {String(data.peak_hour.hour).padStart(2, "0")}:00 UTC
              </p>
              <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400 mt-1">
                {compactNumber(data.peak_hour.tokens)} tokens
              </p>
            </Card>
          )}
          {data.longest_streak && data.longest_streak.days > 0 && (
            <Card>
              <p className="text-xs uppercase tracking-widest text-oai-gray-500 dark:text-oai-gray-400">
                Longest streak
              </p>
              <p className="text-4xl font-semibold text-oai-gray-900 dark:text-white mt-2">
                {data.longest_streak.days} days
              </p>
              <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400 mt-1">
                {data.longest_streak.from} → {data.longest_streak.to}
              </p>
            </Card>
          )}
        </div>

        {data.top.days.length > 0 && (
          <Card>
            <h3 className="text-xs uppercase tracking-widest text-oai-gray-500 dark:text-oai-gray-400 mb-4">
              Top days
            </h3>
            <ul className="space-y-2">
              {data.top.days.slice(0, 5).map((d) => (
                <li key={d.day} className="flex items-baseline justify-between">
                  <span className="text-oai-gray-900 dark:text-white font-mono text-sm">{d.day}</span>
                  <span className="text-oai-gray-500 dark:text-oai-gray-400 font-mono text-sm">
                    {compactNumber(d.tokens)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {data.highlights.length > 0 && (
          <Card accent>
            <h3 className="text-xs uppercase tracking-widest text-oai-gray-600 dark:text-oai-gray-300 mb-3">
              Highlights
            </h3>
            <ul className="space-y-2 text-oai-gray-800 dark:text-oai-gray-200">
              {data.highlights.map((h, i) => (
                <li key={i} className="text-base">
                  · {h}
                </li>
              ))}
            </ul>
          </Card>
        )}

        <footer className="text-center text-xs text-oai-gray-400 dark:text-oai-gray-500 pt-6">
          Generated from local queue.jsonl · share with{" "}
          <code className="font-mono">tracker wrapped --json</code>
        </footer>
      </div>
    </div>
  );
}
