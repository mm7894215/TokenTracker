import React from "react";
import { Download, RefreshCw } from "lucide-react";
import { useNativeSettings } from "../../hooks/use-native-settings.js";
import { copy } from "../../lib/copy";
import { cn } from "../../lib/cn";
import { SectionCard, SettingsRow, ToggleSwitch } from "./Controls.jsx";

export function MenuBarSection() {
  const { available, settings, setSetting, runAction } = useNativeSettings();
  if (!available) return null;

  // showStats + animatedIcon live on the Widgets page (Menu Bar section) where
  // they sit next to the live preview. This section keeps only the system-level
  // toggles + actions that don't have a visual analogue.
  const launchAtLogin = Boolean(settings?.launchAtLogin);
  const launchAtLoginSupported = settings?.launchAtLoginSupported !== false;
  const updateStatus = settings?.updateStatus || null;
  const updateBusy = Boolean(settings?.updateBusy);
  const isSyncing = Boolean(settings?.isSyncing);

  return (
    <SectionCard title={copy("settings.section.menubar")}>
      {launchAtLoginSupported ? (
        <SettingsRow
          label={copy("settings.menubar.launchAtLogin")}
          hint={copy("settings.menubar.launchAtLoginHint")}
          control={
            <ToggleSwitch
              checked={launchAtLogin}
              onChange={() => setSetting("launchAtLogin", !launchAtLogin)}
              ariaLabel={copy("settings.menubar.launchAtLogin")}
            />
          }
        />
      ) : null}
      <SettingsRow
        label={copy("settings.menubar.syncNow")}
        hint={copy("settings.menubar.syncNowHint")}
        control={
          <button
            type="button"
            onClick={() => runAction("syncNow")}
            disabled={isSyncing}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-oai-gray-200 px-3 text-xs font-medium text-oai-gray-700 transition-colors hover:bg-oai-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-oai-gray-800 dark:text-oai-gray-300 dark:hover:bg-oai-gray-800"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isSyncing && "animate-spin")} aria-hidden />
            {isSyncing ? copy("settings.menubar.syncing") : copy("settings.menubar.syncNow")}
          </button>
        }
      />
      <SettingsRow
        label={copy("settings.menubar.updates")}
        hint={updateStatus || undefined}
        control={
          <button
            type="button"
            onClick={() => runAction("checkForUpdates")}
            disabled={updateBusy}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-oai-gray-200 px-3 text-xs font-medium text-oai-gray-700 transition-colors hover:bg-oai-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-oai-gray-800 dark:text-oai-gray-300 dark:hover:bg-oai-gray-800"
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            {copy("settings.menubar.checkUpdates")}
          </button>
        }
      />
    </SectionCard>
  );
}

export function NativeAppFooter() {
  const { available, settings, runAction } = useNativeSettings();
  if (!available || !settings?.version) return null;
  return (
    <div className="mt-6 flex items-center justify-center gap-2 text-[11px] text-oai-gray-500 dark:text-oai-gray-500">
      <span>TokenTrackerBar v{settings.version}</span>
      <span aria-hidden>·</span>
      <button
        type="button"
        onClick={() => runAction("openAbout")}
        className="underline-offset-2 transition-colors hover:text-oai-gray-700 hover:underline dark:hover:text-oai-gray-300"
      >
        GitHub
      </button>
    </div>
  );
}
