import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  LogOut,
  Pencil,
  Sun,
  Moon,
  Monitor,
  RefreshCw,
  Download,
} from "lucide-react";
import { useInsforgeAuth } from "../contexts/InsforgeAuthContext.jsx";
import { useLoginModal } from "../contexts/LoginModalContext.jsx";
import { useTheme } from "../hooks/useTheme.js";
import { useLimitsDisplayPrefs } from "../hooks/use-limits-display-prefs.js";
import { useNativeSettings } from "../hooks/use-native-settings.js";
import { resolveAuthAccessTokenWithRetry } from "../lib/auth-token";
import { getPublicVisibility, setPublicVisibility } from "../lib/api";
import { runCloudUsageSyncNow } from "../lib/cloud-sync";
import {
  getCloudSyncEnabled,
  isLocalDashboardHost,
  setCloudSyncEnabled,
} from "../lib/cloud-sync-prefs";
import { copy } from "../lib/copy";
import { cn } from "../lib/cn";
import { Card } from "../ui/openai/components";
import { LimitsSettingsPanel } from "../components/LimitsSettingsPanel.jsx";

function pickDisplayName(user) {
  if (!user || typeof user !== "object") return "";
  const meta = user.user_metadata && typeof user.user_metadata === "object" ? user.user_metadata : {};
  const prof = user.profile && typeof user.profile === "object" ? user.profile : {};
  const n = meta.full_name || meta.name || prof.name || meta.user_name || meta.preferred_username;
  if (typeof n === "string" && n.trim()) return n.trim();
  if (typeof user.email === "string" && user.email.includes("@")) {
    return user.email.split("@")[0].trim() || user.email.trim();
  }
  return typeof user.email === "string" ? user.email.trim() : "";
}

function pickEmail(user) {
  if (!user || typeof user !== "object") return "";
  return typeof user.email === "string" ? user.email.trim() : "";
}

function ToggleSwitch({ checked, onChange, disabled, ariaLabel }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={onChange}
      disabled={disabled}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 disabled:opacity-50 disabled:cursor-not-allowed",
        checked ? "bg-oai-brand-500" : "bg-oai-gray-300 dark:bg-oai-gray-700",
      )}
    >
      <span
        className={cn(
          "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-[3px]",
        )}
      />
    </button>
  );
}

function SettingsRow({ label, hint, control }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-oai-gray-900 dark:text-oai-gray-200">{label}</div>
        {hint && (
          <div className="mt-0.5 text-xs text-oai-gray-500 dark:text-oai-gray-400">{hint}</div>
        )}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

function SectionCard({ title, subtitle, action, children }) {
  return (
    <Card>
      <div className="mb-3 flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium text-oai-gray-500 dark:text-oai-gray-300 uppercase tracking-wide">
            {title}
          </h2>
          {subtitle && (
            <p className="mt-1 text-xs text-oai-gray-500 dark:text-oai-gray-400 truncate">{subtitle}</p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {/* -mb-3 pulls the last SettingsRow's py-3 bottom padding back up so the
          card's bottom whitespace matches its top padding instead of stacking. */}
      <div className="-mb-3 divide-y divide-oai-gray-200/60 dark:divide-oai-gray-800/60">
        {children}
      </div>
    </Card>
  );
}

const THEME_OPTIONS = [
  { value: "light", labelKey: "settings.appearance.theme.light", Icon: Sun },
  { value: "dark", labelKey: "settings.appearance.theme.dark", Icon: Moon },
  { value: "system", labelKey: "settings.appearance.theme.system", Icon: Monitor },
];

function ThemeSegmented({ theme, onSetTheme }) {
  return (
    <div className="inline-flex items-center rounded-lg border border-oai-gray-200 dark:border-oai-gray-800 p-0.5 bg-oai-gray-50 dark:bg-oai-gray-900">
      {THEME_OPTIONS.map(({ value, labelKey, Icon }) => {
        const active = theme === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => onSetTheme(value)}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
              active
                ? "bg-white dark:bg-oai-gray-800 text-oai-black dark:text-white shadow-sm"
                : "text-oai-gray-500 dark:text-oai-gray-400 hover:text-oai-black dark:hover:text-white",
            )}
            aria-pressed={active}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            <span>{copy(labelKey)}</span>
          </button>
        );
      })}
    </div>
  );
}

function AccountSection() {
  const { enabled, signedIn, user, signOut, getAccessToken } = useInsforgeAuth();
  const { openLoginModal } = useLoginModal();
  const [cloudSyncOn, setCloudSyncOn] = useState(() => getCloudSyncEnabled());
  const [publicProfileOn, setPublicProfileOn] = useState(false);
  const [anonymousOn, setAnonymousOn] = useState(false);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [customDisplayName, setCustomDisplayName] = useState(null);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");

  const showLocalCloudSync = enabled && signedIn && isLocalDashboardHost();
  const displayName = useMemo(() => pickDisplayName(user), [user]);
  const email = useMemo(() => pickEmail(user), [user]);

  // Load profile settings on mount when signed in
  useEffect(() => {
    if (!signedIn) return;
    let active = true;
    setProfileLoading(true);
    (async () => {
      try {
        const token = await resolveAuthAccessTokenWithRetry({ getAccessToken });
        if (!active || !token) return;
        const data = await getPublicVisibility({ accessToken: token });
        if (!active) return;
        setPublicProfileOn(Boolean(data?.enabled));
        setAnonymousOn(Boolean(data?.anonymous));
        if (data?.display_name) setCustomDisplayName(data.display_name);
      } catch {
        /* ignore */
      } finally {
        if (active) setProfileLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [signedIn, getAccessToken]);

  const handleCloudSyncToggle = useCallback(async () => {
    const next = !cloudSyncOn;
    setCloudSyncEnabled(next);
    setCloudSyncOn(next);
    if (next) {
      try {
        await runCloudUsageSyncNow(() => getAccessToken());
      } catch (err) {
        console.warn("[tokentracker] cloud sync:", err);
      }
    }
  }, [cloudSyncOn, getAccessToken]);

  const handlePublicProfileToggle = useCallback(async () => {
    if (profileSaving) return;
    setProfileSaving(true);
    try {
      const token = await resolveAuthAccessTokenWithRetry({ getAccessToken });
      if (!token) return;
      const next = !publicProfileOn;
      await setPublicVisibility({ accessToken: token, enabled: next });
      setPublicProfileOn(next);
    } catch {
      /* ignore */
    } finally {
      setProfileSaving(false);
    }
  }, [publicProfileOn, profileSaving, getAccessToken]);

  const handleAnonymousToggle = useCallback(async () => {
    if (profileSaving) return;
    setProfileSaving(true);
    try {
      const token = await resolveAuthAccessTokenWithRetry({ getAccessToken });
      if (!token) return;
      const next = !anonymousOn;
      await setPublicVisibility({ accessToken: token, anonymous: next });
      setAnonymousOn(next);
    } catch {
      /* ignore */
    } finally {
      setProfileSaving(false);
    }
  }, [anonymousOn, profileSaving, getAccessToken]);

  const handleSaveName = useCallback(async () => {
    if (profileSaving) return;
    const trimmed = nameInput.trim().slice(0, 50);
    if (!trimmed) return;
    setProfileSaving(true);
    try {
      const token = await resolveAuthAccessTokenWithRetry({ getAccessToken });
      if (!token) return;
      await setPublicVisibility({ accessToken: token, display_name: trimmed });
      setCustomDisplayName(trimmed);
      setEditingName(false);
    } catch {
      /* ignore */
    } finally {
      setProfileSaving(false);
    }
  }, [nameInput, profileSaving, getAccessToken]);

  const startEditingName = useCallback(() => {
    setNameInput(customDisplayName || displayName);
    setEditingName(true);
  }, [customDisplayName, displayName]);

  if (!enabled) return null;

  if (!signedIn) {
    return (
      <SectionCard title={copy("settings.section.account")}>
        <div className="flex items-center justify-between py-3 gap-4">
          <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400">
            {copy("settings.account.signedOutHint")}
          </p>
          <button
            type="button"
            onClick={openLoginModal}
            className="shrink-0 inline-flex h-8 items-center justify-center rounded-md bg-oai-gray-900 text-white px-4 text-xs font-medium hover:bg-oai-gray-800 dark:bg-white dark:text-oai-gray-900 dark:hover:bg-oai-gray-100 transition-colors"
          >
            {copy("settings.account.signIn")}
          </button>
        </div>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title={copy("settings.section.account")}
      subtitle={email || (customDisplayName || displayName)}
      action={
        <button
          type="button"
          onClick={() => signOut()}
          className="inline-flex h-7 items-center gap-1.5 text-xs font-medium text-oai-gray-500 hover:text-oai-gray-700 dark:hover:text-oai-gray-300 transition-colors"
        >
          <LogOut className="h-3.5 w-3.5" aria-hidden />
          {copy("settings.account.signOut")}
        </button>
      }
    >
      {showLocalCloudSync && (
        <SettingsRow
          label={copy("settings.account.cloudSync")}
          hint={copy("settings.account.cloudSyncHint")}
          control={
            <ToggleSwitch
              checked={cloudSyncOn}
              onChange={handleCloudSyncToggle}
              ariaLabel={copy("settings.account.cloudSync")}
            />
          }
        />
      )}

      <SettingsRow
        label={copy("settings.account.publicProfile")}
        hint={copy("settings.account.publicProfileHint")}
        control={
          <ToggleSwitch
            checked={publicProfileOn}
            onChange={handlePublicProfileToggle}
            disabled={profileLoading || profileSaving}
            ariaLabel={copy("settings.account.publicProfile")}
          />
        }
      />

      <AnimatePresence initial={false}>
        {publicProfileOn && (
          <motion.div
            key="public-profile-fields"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              height: { duration: 0.28, ease: [0.22, 1, 0.36, 1] },
              opacity: { duration: 0.2, ease: [0.22, 1, 0.36, 1] },
            }}
            style={{ overflow: "hidden" }}
            className="divide-y divide-oai-gray-200/60 dark:divide-oai-gray-800/60"
          >
            <div className="py-3">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-oai-gray-900 dark:text-oai-gray-200">
                    {copy("settings.account.displayName")}
                  </div>
                  {!editingName && (
                    <div className="mt-0.5 text-xs text-oai-gray-500 dark:text-oai-gray-400 truncate">
                      {customDisplayName || displayName}
                    </div>
                  )}
                  {editingName && (
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        type="text"
                        value={nameInput}
                        onChange={(e) => setNameInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleSaveName();
                          if (e.key === "Escape") setEditingName(false);
                        }}
                        maxLength={50}
                        autoFocus
                        className="flex-1 rounded-md border border-oai-gray-300 dark:border-oai-gray-700 bg-transparent px-2.5 py-1.5 text-sm text-oai-black dark:text-white outline-none focus:border-oai-brand-500 focus:ring-1 focus:ring-inset focus:ring-oai-brand-500"
                        placeholder={copy("settings.account.displayName")}
                      />
                      <button
                        type="button"
                        onClick={handleSaveName}
                        disabled={profileSaving || !nameInput.trim()}
                        className="rounded-md bg-oai-brand-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-oai-brand-600 disabled:opacity-50 transition-colors"
                      >
                        {profileSaving ? copy("settings.account.saving") : copy("settings.account.save")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingName(false)}
                        className="rounded-md px-2 py-1.5 text-xs text-oai-gray-500 hover:text-oai-gray-700 dark:hover:text-oai-gray-300 transition-colors"
                      >
                        {copy("settings.account.cancel")}
                      </button>
                    </div>
                  )}
                </div>
                {!editingName && (
                  <button
                    type="button"
                    onClick={startEditingName}
                    className="shrink-0 inline-flex h-8 items-center gap-1.5 rounded-md border border-oai-gray-200 dark:border-oai-gray-800 px-3 text-xs font-medium text-oai-gray-700 dark:text-oai-gray-300 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 transition-colors"
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden />
                    {copy("settings.account.edit")}
                  </button>
                )}
              </div>
            </div>

            <SettingsRow
              label={copy("settings.account.anonymous")}
              hint={copy("settings.account.anonymousHint")}
              control={
                <ToggleSwitch
                  checked={anonymousOn}
                  onChange={handleAnonymousToggle}
                  disabled={profileLoading || profileSaving}
                  ariaLabel={copy("settings.account.anonymous")}
                />
              }
            />
          </motion.div>
        )}
      </AnimatePresence>
    </SectionCard>
  );
}

function MenuBarSection() {
  const { available, settings, setSetting, runAction } = useNativeSettings();

  if (!available) return null;

  const showStats = Boolean(settings?.showStats);
  const animatedIcon = settings?.animatedIcon !== false; // default on
  const launchAtLogin = Boolean(settings?.launchAtLogin);
  const launchAtLoginSupported = settings?.launchAtLoginSupported !== false;
  const version = settings?.version || "—";
  const updateStatus = settings?.updateStatus || null;
  const updateBusy = Boolean(settings?.updateBusy);
  const isSyncing = Boolean(settings?.isSyncing);

  return (
    <SectionCard title={copy("settings.section.menubar")}>
      <SettingsRow
        label={copy("settings.menubar.showStats")}
        hint={copy("settings.menubar.showStatsHint")}
        control={
          <ToggleSwitch
            checked={showStats}
            onChange={() => setSetting("showStats", !showStats)}
            ariaLabel={copy("settings.menubar.showStats")}
          />
        }
      />
      <SettingsRow
        label={copy("settings.menubar.animatedIcon")}
        hint={copy("settings.menubar.animatedIconHint")}
        control={
          <ToggleSwitch
            checked={animatedIcon}
            onChange={() => setSetting("animatedIcon", !animatedIcon)}
            ariaLabel={copy("settings.menubar.animatedIcon")}
          />
        }
      />
      {launchAtLoginSupported && (
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
      )}

      <SettingsRow
        label={copy("settings.menubar.syncNow")}
        hint={copy("settings.menubar.syncNowHint")}
        control={
          <button
            type="button"
            onClick={() => runAction("syncNow")}
            disabled={isSyncing}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-oai-gray-200 dark:border-oai-gray-800 px-3 text-xs font-medium text-oai-gray-700 dark:text-oai-gray-300 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-oai-gray-200 dark:border-oai-gray-800 px-3 text-xs font-medium text-oai-gray-700 dark:text-oai-gray-300 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            {copy("settings.menubar.checkUpdates")}
          </button>
        }
      />
    </SectionCard>
  );
}

function NativeAppFooter() {
  const { available, settings, runAction } = useNativeSettings();
  if (!available || !settings?.version) return null;
  return (
    <div className="mt-6 flex items-center justify-center gap-2 text-[11px] text-oai-gray-500 dark:text-oai-gray-500">
      <span>TokenTrackerBar v{settings.version}</span>
      <span aria-hidden>·</span>
      <button
        type="button"
        onClick={() => runAction("openAbout")}
        className="hover:text-oai-gray-700 dark:hover:text-oai-gray-300 transition-colors underline-offset-2 hover:underline"
      >
        GitHub
      </button>
    </div>
  );
}

export function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const limitsPrefs = useLimitsDisplayPrefs();

  return (
    <div className="flex flex-col flex-1 text-oai-black dark:text-oai-white font-oai antialiased">
      <main className="flex-1 pt-8 sm:pt-10 pb-12 sm:pb-16">
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          <div className="mb-8 flex items-center justify-between gap-4">
            <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-oai-black dark:text-white">
              {copy("settings.page.title")}
            </h1>
            <ThemeSegmented theme={theme} onSetTheme={setTheme} />
          </div>

          <div className="space-y-4">
            <MenuBarSection />

            <AccountSection />

            <SectionCard title={copy("settings.section.limits")}>
              <LimitsSettingsPanel prefs={limitsPrefs} />
            </SectionCard>
          </div>

          <NativeAppFooter />
        </div>
      </main>
    </div>
  );
}
