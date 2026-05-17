import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { X, Mail } from "lucide-react";
import { useInsforgeAuth } from "../contexts/InsforgeAuthContext.jsx";
import { useLoginModal } from "../contexts/LoginModalContext.jsx";
import { useLocale } from "../hooks/useLocale.js";
import { copy } from "../lib/copy";
import { cn } from "../lib/cn";

const GOOGLE_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1Z" fill="#4285F4"/>
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23Z" fill="#34A853"/>
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.96 10.96 0 0 0 1 12c0 1.77.42 3.44 1.18 4.93l3.66-2.84Z" fill="#FBBC05"/>
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53Z" fill="#EA4335"/>
  </svg>
);

const GITHUB_ICON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12Z"/>
  </svg>
);

const PROVIDER_ICONS = { google: GOOGLE_ICON, github: GITHUB_ICON };

const PROVIDER_LABELS = {
  google: "Google",
  github: "GitHub",
  microsoft: "Microsoft",
  discord: "Discord",
  apple: "Apple",
};

function providerLabel(key) {
  return PROVIDER_LABELS[key] || String(key || "").replace(/-/g, " ");
}

export function LoginModal() {
  // Subscribe to locale so the modal re-renders when the user switches language.
  useLocale();
  const { isOpen, closeLoginModal } = useLoginModal();
  const {
    enabled,
    signedIn,
    refreshUser,
    signInWithPassword,
    signUp,
    signInWithOAuth,
    getPublicAuthConfig,
  } = useInsforgeAuth();

  const [mode, setMode] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [banner, setBanner] = useState(null);
  const [emailExpanded, setEmailExpanded] = useState(false);
  const [configLoading, setConfigLoading] = useState(true);
  const [oauthProviders, setOauthProviders] = useState([]);
  const [passwordMinLength, setPasswordMinLength] = useState(8);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setError(null);
      setBanner(null);
      setMode("signin");
      setEmail("");
      setPassword("");
      setName("");
      setEmailExpanded(false);
    }
  }, [isOpen]);

  // Load auth config
  useEffect(() => {
    if (!isOpen || !enabled) {
      setConfigLoading(false);
      return;
    }
    let active = true;
    (async () => {
      const { data, error: cfgErr } = await getPublicAuthConfig();
      if (!active) return;
      if (cfgErr || !data) {
        setOauthProviders(["google", "github"]);
      } else {
        const providers = Array.isArray(data.oAuthProviders) ? data.oAuthProviders : [];
        const custom = Array.isArray(data.customOAuthProviders) ? data.customOAuthProviders : [];
        setOauthProviders([...providers, ...custom]);
        if (typeof data.passwordMinLength === "number" && data.passwordMinLength > 0) {
          setPasswordMinLength(data.passwordMinLength);
        }
      }
      setConfigLoading(false);
    })();
    return () => { active = false; };
  }, [isOpen, enabled, getPublicAuthConfig]);

  // Close on successful login
  useEffect(() => {
    if (isOpen && signedIn) {
      closeLoginModal();
    }
  }, [isOpen, signedIn, closeLoginModal]);

  const redirectUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    // In the macOS app WebView, route OAuth back through /auth/callback so
    // NativeAuthCallbackPage can detect the native flag and bounce the code
    // into the app via the tokentracker:// URL scheme. Plain web visitors
    // can land directly on / since the SDK auto-exchanges insforge_code.
    const isNativeContext = Boolean(window.webkit?.messageHandlers?.nativeOAuth);
    return isNativeContext
      ? `${window.location.origin}/auth/callback`
      : `${window.location.origin}/`;
  }, []);

  const handleOAuth = useCallback(async (provider) => {
    setError(null);
    setBusy(true);
    try {
      const { error: err } = await signInWithOAuth(provider, redirectUrl);
      if (err) setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }, [signInWithOAuth, redirectUrl]);

  const handleEmailAuth = useCallback(async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "signup") {
        const { data, error: err } = await signUp({
          email: email.trim(),
          password,
          name: name.trim() || undefined,
        });
        if (err) { setError(err.message || String(err)); return; }
        if (data?.requireEmailVerification) {
          setBanner(copy("login.verify_email_pending"));
          setMode("signin");
          return;
        }
        await refreshUser();
        return;
      }
      const { error: err } = await signInWithPassword({ email: email.trim(), password });
      if (err) { setError(err.message || String(err)); return; }
      await refreshUser();
    } finally {
      setBusy(false);
    }
  }, [mode, email, password, name, signUp, signInWithPassword, refreshUser]);

  // Handle Escape key
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e) => { if (e.key === "Escape") closeLoginModal(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, closeLoginModal]);

  if (!enabled) return null;

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          {/* Backdrop */}
          <motion.div
            className="absolute inset-0 bg-black/40 dark:bg-black/60 "
            onClick={closeLoginModal}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />

          {/* Card */}
          <motion.div
            className="relative w-full max-w-[420px] rounded-2xl border border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-950 p-6 shadow-2xl"
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.2 }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Close button */}
            <button
              type="button"
              onClick={closeLoginModal}
              className="absolute right-4 top-4 text-oai-gray-400 dark:text-oai-gray-500 hover:text-oai-black dark:hover:text-white transition-colors"
            >
              <X className="h-5 w-5" />
            </button>

            {/* Header */}
            <div className="text-center mb-6">
              <div className="flex items-center justify-center gap-2 mb-2">
                <img src="/app-icon.png" alt="" width={28} height={28} className="rounded-md" />
                <span className="text-lg font-semibold text-oai-black dark:text-white">Token Tracker</span>
              </div>
              <p className="text-sm text-oai-gray-500">{copy("login_modal.subtitle")}</p>
            </div>

            {/* Banner */}
            {banner && (
              <div className="mb-4 rounded-lg border border-oai-gray-200 dark:border-oai-gray-800 bg-oai-gray-50 dark:bg-oai-gray-900/50 px-3 py-2 text-xs text-oai-gray-700 dark:text-oai-gray-300">
                {banner}
              </div>
            )}

            {/* Error */}
            {error && (
              <p className="mb-4 text-sm text-red-500 dark:text-red-400" role="alert">{error}</p>
            )}

            {/* OAuth buttons */}
            <div className="space-y-2.5 mb-5">
              {configLoading ? (
                <div className="h-10 rounded-lg bg-oai-gray-100 dark:bg-oai-gray-900 animate-pulse" />
              ) : (
                oauthProviders.map((p) => (
                  <button
                    key={p}
                    type="button"
                    disabled={busy}
                    onClick={() => handleOAuth(p)}
                    className={cn(
                      "w-full h-10 rounded-lg border border-oai-gray-200 dark:border-oai-gray-700 bg-oai-gray-50 dark:bg-oai-gray-900 text-sm font-medium text-oai-black dark:text-white",
                      "hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 hover:border-oai-gray-300 dark:hover:border-oai-gray-600 transition-colors disabled:opacity-50",
                      "flex items-center justify-center gap-2.5",
                    )}
                  >
                    {PROVIDER_ICONS[p] || null}
                    {copy("login.oauth.continue", { provider: providerLabel(p) })}
                  </button>
                ))
              )}
            </div>

            {/* Email section — collapsed by default */}
            {!emailExpanded ? (
              <>
                <div className="relative mb-5">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t border-oai-gray-200 dark:border-oai-gray-800" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase tracking-wider">
                    <span className="bg-white dark:bg-oai-gray-950 px-3 text-oai-gray-400 dark:text-oai-gray-600">{copy("login.divider")}</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setEmailExpanded(true)}
                  className={cn(
                    "w-full h-10 rounded-lg border border-oai-gray-200 dark:border-oai-gray-700 bg-oai-gray-50 dark:bg-oai-gray-900 text-sm font-medium text-oai-black dark:text-white",
                    "hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 hover:border-oai-gray-300 dark:hover:border-oai-gray-600 transition-colors",
                    "flex items-center justify-center gap-2.5",
                  )}
                >
                  <Mail className="h-[18px] w-[18px] text-oai-gray-500 dark:text-oai-gray-400" strokeWidth={1.75} />
                  {copy("login_modal.continue_email")}
                </button>
              </>
            ) : (
              <>
                {/* Divider */}
                <div className="relative mb-5">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t border-oai-gray-200 dark:border-oai-gray-800" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase tracking-wider">
                    <span className="bg-white dark:bg-oai-gray-950 px-3 text-oai-gray-400 dark:text-oai-gray-600">{copy("login_modal.divider_email")}</span>
                  </div>
                </div>

                {/* Sign in / Sign up toggle */}
                <div className="flex rounded-lg border border-oai-gray-200 dark:border-oai-gray-800 p-0.5 bg-oai-gray-50 dark:bg-oai-gray-900/50 mb-4">
                  <button
                    type="button"
                    className={cn(
                      "flex-1 py-1.5 text-xs font-medium rounded-md transition-colors",
                      mode === "signin"
                        ? "bg-white dark:bg-oai-gray-800 text-oai-black dark:text-white shadow-sm"
                        : "text-oai-gray-500 hover:text-oai-gray-700 dark:hover:text-oai-gray-300",
                    )}
                    onClick={() => { setMode("signin"); setError(null); }}
                  >
                    {copy("login.tab.sign_in")}
                  </button>
                  <button
                    type="button"
                    className={cn(
                      "flex-1 py-1.5 text-xs font-medium rounded-md transition-colors",
                      mode === "signup"
                        ? "bg-white dark:bg-oai-gray-800 text-oai-black dark:text-white shadow-sm"
                        : "text-oai-gray-500 hover:text-oai-gray-700 dark:hover:text-oai-gray-300",
                    )}
                    onClick={() => { setMode("signup"); setError(null); }}
                  >
                    {copy("login.tab.sign_up")}
                  </button>
                </div>

                {/* Email form */}
                <form onSubmit={handleEmailAuth} className="space-y-3">
                  {mode === "signup" && (
                    <div>
                      <label htmlFor="modal-name" className="block text-xs font-medium text-oai-gray-500 mb-1">{copy("login.field.name")}</label>
                      <input
                        id="modal-name"
                        type="text"
                        autoComplete="name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="w-full h-10 rounded-lg border border-oai-gray-200 dark:border-oai-gray-800 bg-oai-gray-50 dark:bg-oai-gray-900 px-3 text-sm text-oai-black dark:text-white placeholder-oai-gray-400 dark:placeholder-oai-gray-600 focus:outline-none focus:ring-2 focus:ring-oai-brand-500"
                        placeholder={copy("login.field.name_placeholder")}
                      />
                    </div>
                  )}
                  <div>
                    <label htmlFor="modal-email" className="block text-xs font-medium text-oai-gray-500 mb-1">{copy("login.field.email")}</label>
                    <input
                      id="modal-email"
                      type="email"
                      autoComplete="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full h-10 rounded-lg border border-oai-gray-200 dark:border-oai-gray-800 bg-oai-gray-50 dark:bg-oai-gray-900 px-3 text-sm text-oai-black dark:text-white placeholder-oai-gray-400 dark:placeholder-oai-gray-600 focus:outline-none focus:ring-2 focus:ring-oai-brand-500"
                    />
                  </div>
                  <div>
                    <label htmlFor="modal-password" className="block text-xs font-medium text-oai-gray-500 mb-1">{copy("login.field.password")}</label>
                    <input
                      id="modal-password"
                      type="password"
                      autoComplete={mode === "signup" ? "new-password" : "current-password"}
                      required
                      minLength={mode === "signup" ? passwordMinLength : undefined}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full h-10 rounded-lg border border-oai-gray-200 dark:border-oai-gray-800 bg-oai-gray-50 dark:bg-oai-gray-900 px-3 text-sm text-oai-black dark:text-white placeholder-oai-gray-400 dark:placeholder-oai-gray-600 focus:outline-none focus:ring-2 focus:ring-oai-brand-500"
                    />
                    {mode === "signup" && (
                      <p className="mt-1 text-xs text-oai-gray-400 dark:text-oai-gray-600">{copy("login.password_hint", { min: String(passwordMinLength) })}</p>
                    )}
                  </div>
                  <button
                    type="submit"
                    disabled={busy}
                    className="w-full h-10 rounded-lg bg-oai-gray-900 dark:bg-white text-white dark:text-oai-gray-950 text-sm font-semibold hover:bg-oai-gray-800 dark:hover:bg-oai-gray-100 transition-colors disabled:opacity-50"
                  >
                    {mode === "signup" ? copy("login.submit.sign_up") : copy("login.submit.sign_in")}
                  </button>
                </form>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
