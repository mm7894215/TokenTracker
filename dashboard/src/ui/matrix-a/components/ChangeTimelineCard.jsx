import React from "react";
import { copy } from "../../../lib/copy";

const SUPPORTED_EVENT_TYPES = new Set([
  "source_first_seen",
  "model_first_seen",
  "project_attribution_started",
  "cloud_sync_configured",
]);

function eventTitle(event) {
  if (!event || !SUPPORTED_EVENT_TYPES.has(event.event_type)) {
    return copy("dashboard.timeline.event.unknown.title");
  }
  return copy(`dashboard.timeline.event.${event.event_type}.title`, event.params || {});
}

function eventDetail(event) {
  if (!event || !SUPPORTED_EVENT_TYPES.has(event.event_type)) {
    return copy("dashboard.timeline.event.unknown.detail");
  }
  return copy(`dashboard.timeline.event.${event.event_type}.detail`, event.params || {});
}

function eventKey(event, index) {
  const params = event?.params || {};
  const paramSig = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return `${event?.event_type || "unknown"}-${event?.date || index}-${paramSig}`;
}

export function ChangeTimelineCard({ events = [], loading = false, error = null, className = "" }) {
  return (
    <div className={`rounded-xl border border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-900 p-5 ${className}`}>
      <div className="mb-4">
        <h3 className="text-sm font-medium text-oai-gray-500 dark:text-oai-gray-300 uppercase tracking-wide">
          {copy("dashboard.timeline.title")}
        </h3>
        <p className="mt-1 text-xs text-oai-gray-500 dark:text-oai-gray-400">
          {copy("dashboard.timeline.subtitle")}
        </p>
      </div>

      <TimelineBody events={events} loading={loading} error={error} />
    </div>
  );
}

function TimelineBody({ events, loading, error }) {
  if (error) {
    return (
      <div className="text-sm text-red-500 dark:text-red-400" role="alert">
        {copy("dashboard.timeline.error")}
      </div>
    );
  }
  if (loading && events.length === 0) {
    return (
      <div className="text-sm text-oai-gray-500 dark:text-oai-gray-400">
        {copy("dashboard.timeline.loading")}
      </div>
    );
  }
  if (events.length === 0) {
    return (
      <div className="text-sm text-oai-gray-500 dark:text-oai-gray-400">
        {copy("dashboard.timeline.empty")}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {events.map((event, index) => (
        <div key={eventKey(event, index)} className="flex items-start gap-3">
          <div className="mt-1 h-2.5 w-2.5 rounded-full bg-oai-brand" />
          <div className="min-w-0">
            <div className="text-xs text-oai-gray-500 dark:text-oai-gray-400">{event.date}</div>
            <div className="text-sm font-medium text-oai-black dark:text-oai-white">
              {eventTitle(event)}
            </div>
            <div className="text-xs text-oai-gray-500 dark:text-oai-gray-400">
              {eventDetail(event)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
