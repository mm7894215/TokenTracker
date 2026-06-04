import React, { useEffect, useMemo, useState } from "react";
import { copy } from "../lib/copy";
import { safeWriteClipboard } from "../lib/safe-browser";
import { LinearLanding } from "../ui/marketing/LinearLanding.jsx";

export function LinearLandingPage({ signInUrl, signUpUrl }) {
  const installCommand = copy("landing.install.command");
  const [installCopied, setInstallCopied] = useState(false);
  const installEntryKey = "tokentracker.dashboard.from_landing.v3";

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.sessionStorage.setItem(installEntryKey, "1");
    } catch (_e) {
      // Ignore write errors in private browsing or restricted embeds.
    }
  }, [installEntryKey]);

  const handleCopyInstall = async () => {
    const didCopy = await safeWriteClipboard(installCommand);
    if (!didCopy) return;
    setInstallCopied(true);
    window.setTimeout(() => setInstallCopied(false), 2000);
  };

  const props = useMemo(
    () => ({
      copy,
      signInUrl,
      signUpUrl,
      installCommand,
      installCopied,
      onCopyInstallCommand: handleCopyInstall,
    }),
    [installCopied, installCommand, signInUrl, signUpUrl],
  );

  return <LinearLanding {...props} />;
}
