import React from "react";
import { AnimatePresence, motion } from "motion/react";
import { LogOut } from "lucide-react";
import { copy } from "../../lib/copy";
import { useAccountProfileSettings } from "./useAccountProfileSettings.js";
import { PublicProfileFields, SignedOutAccountSection } from "./AccountSectionParts.jsx";
import { SectionCard, SettingsRow, ToggleSwitch } from "./Controls.jsx";

export function AccountSection() {
  const settings = useAccountProfileSettings();

  if (!settings.enabled) return null;
  if (!settings.signedIn) return <SignedOutAccountSection />;

  return (
    <SectionCard
      title={copy("settings.section.account")}
      subtitle={settings.email || (settings.name.customDisplayName || settings.name.displayName)}
      action={<SignOutButton onSignOut={settings.signOut} />}
    >
      <CloudSyncRow settings={settings} />
      <PublicProfileToggleRow
        checked={settings.publicProfileOn}
        disabled={settings.profileLoading || settings.profileSaving}
        onChange={settings.handlePublicProfileToggle}
      />
      <PublicProfileDetails visible={settings.publicProfileOn} name={settings.name} github={settings.github} />
    </SectionCard>
  );
}

function SignOutButton({ onSignOut }) {
  return (
    <button
      type="button"
      onClick={() => onSignOut()}
      className="inline-flex h-7 items-center gap-1.5 text-xs font-medium text-oai-gray-500 transition-colors hover:text-oai-gray-700 dark:hover:text-oai-gray-300"
    >
      <LogOut className="h-3.5 w-3.5" aria-hidden />
      {copy("settings.account.signOut")}
    </button>
  );
}

function CloudSyncRow({ settings }) {
  if (!settings.showLocalCloudSync) return null;
  return (
    <SettingsRow
      label={copy("settings.account.cloudSync")}
      hint={copy("settings.account.cloudSyncHint")}
      control={
        <ToggleSwitch
          checked={settings.cloudSyncOn}
          onChange={settings.handleCloudSyncToggle}
          ariaLabel={copy("settings.account.cloudSync")}
        />
      }
    />
  );
}

function PublicProfileToggleRow({ checked, disabled, onChange }) {
  return (
    <SettingsRow
      label={copy("settings.account.publicProfile")}
      hint={copy("settings.account.publicProfileHint")}
      control={
        <ToggleSwitch
          checked={checked}
          onChange={onChange}
          disabled={disabled}
          ariaLabel={copy("settings.account.publicProfile")}
        />
      }
    />
  );
}

function PublicProfileDetails({ visible, name, github }) {
  return (
    <AnimatePresence initial={false}>
      {visible ? (
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
          <PublicProfileFields name={name} github={github} />
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
