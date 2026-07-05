import React from "react";
import { ExternalLink, KeyRound, Loader2 } from "lucide-react";
import { copy } from "../../lib/copy";
import { isLocalDashboardHost } from "../../lib/cloud-sync-prefs";
import { useOpenRouterConfig } from "../../hooks/use-openrouter-config";
import { SectionCard, SettingsRow } from "./Controls.jsx";

export function OpenRouterSection() {
  if (!isLocalDashboardHost()) return null;

  const config = useOpenRouterConfig(true);
  const [draftKey, setDraftKey] = React.useState("");
  const [message, setMessage] = React.useState(null);

  const configured = config.snapshot?.configured === true;
  const envOverrides = config.snapshot?.env_overrides_config === true;

  const handleSave = async () => {
    setMessage(null);
    try {
      await config.save(draftKey, { sync: true });
      setDraftKey("");
      setMessage(copy("settings.openrouter.saved"));
    } catch {
      /* error surfaced via config.error */
    }
  };

  const handleTest = async () => {
    setMessage(null);
    const key = draftKey.trim() || "";
    if (!key) {
      setMessage(copy("settings.openrouter.testNeedsKey"));
      return;
    }
    try {
      await config.test(key);
      setMessage(copy("settings.openrouter.verified"));
    } catch {
      /* error surfaced via config.error */
    }
  };

  const handleClear = async () => {
    setMessage(null);
    try {
      await config.clear();
      setDraftKey("");
      setMessage(copy("settings.openrouter.cleared"));
    } catch {
      /* error surfaced via config.error */
    }
  };

  return (
    <SectionCard
      title={copy("settings.section.providers")}
      subtitle={copy("settings.openrouter.subtitle")}
    >
      <SettingsRow
        label={copy("settings.openrouter.status")}
        hint={
          config.loading
            ? copy("settings.openrouter.loading")
            : configured
              ? envOverrides
                ? copy("settings.openrouter.statusEnv")
                : copy("settings.openrouter.statusConfigured", {
                    key: config.snapshot?.masked_key || "••••",
                  })
              : copy("settings.openrouter.statusUnset")
        }
        control={
          configured ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
              <KeyRound className="h-3 w-3" aria-hidden />
              {copy("settings.openrouter.badgeConfigured")}
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-oai-gray-100 px-2 py-0.5 text-xs font-medium text-oai-gray-600 dark:bg-oai-gray-800 dark:text-oai-gray-300">
              {copy("settings.openrouter.badgeUnset")}
            </span>
          )
        }
      />

      <div className="py-3">
        <label htmlFor="openrouter-api-key" className="text-sm text-oai-gray-900 dark:text-oai-gray-200">
          {copy("settings.openrouter.apiKeyLabel")}
        </label>
        <p className="mt-0.5 text-xs text-oai-gray-500 dark:text-oai-gray-400">
          {copy("settings.openrouter.apiKeyHint")}{" "}
          <a
            href="https://openrouter.ai/keys"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 text-oai-brand-600 hover:underline dark:text-oai-brand-400"
          >
            openrouter.ai/keys
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        </p>
        <input
          id="openrouter-api-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draftKey}
          onChange={(event) => setDraftKey(event.target.value)}
          placeholder={copy("settings.openrouter.apiKeyPlaceholder")}
          disabled={envOverrides || config.saving || config.testing}
          className="mt-2 w-full rounded-lg border border-oai-gray-200 bg-white px-3 py-2 font-mono text-sm text-oai-gray-900 outline-none ring-oai-brand-500 focus:border-oai-brand-500 focus:ring-1 disabled:cursor-not-allowed disabled:opacity-60 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-oai-white"
        />
        {envOverrides ? (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
            {copy("settings.openrouter.envOverride")}
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 py-3">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!draftKey.trim() || envOverrides || config.saving || config.testing}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-oai-brand-600 px-3 text-xs font-medium text-white transition-colors hover:bg-oai-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {config.saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
          {config.saving ? copy("settings.openrouter.saving") : copy("settings.openrouter.save")}
        </button>
        <button
          type="button"
          onClick={() => void handleTest()}
          disabled={!draftKey.trim() || envOverrides || config.saving || config.testing}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-oai-gray-200 px-3 text-xs font-medium text-oai-gray-700 transition-colors hover:bg-oai-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-oai-gray-800 dark:text-oai-gray-300 dark:hover:bg-oai-gray-800"
        >
          {config.testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
          {config.testing ? copy("settings.openrouter.testing") : copy("settings.openrouter.test")}
        </button>
        <button
          type="button"
          onClick={() => void handleClear()}
          disabled={!configured || envOverrides || config.clearing || config.saving}
          className="inline-flex h-8 items-center rounded-md px-3 text-xs font-medium text-oai-gray-500 transition-colors hover:bg-oai-gray-100 hover:text-oai-gray-700 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-oai-gray-800 dark:hover:text-oai-gray-300"
        >
          {config.clearing ? copy("settings.openrouter.clearing") : copy("settings.openrouter.clear")}
        </button>
      </div>

      {config.error ? (
        <p className="pb-3 text-xs text-red-600 dark:text-red-400">{config.error}</p>
      ) : null}
      {message ? (
        <p className="pb-3 text-xs text-emerald-700 dark:text-emerald-300">{message}</p>
      ) : null}
    </SectionCard>
  );
}
