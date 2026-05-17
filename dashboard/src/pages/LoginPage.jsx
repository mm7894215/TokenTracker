import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useInsforgeAuth } from "../contexts/InsforgeAuthContext.jsx";
import { copy } from "../lib/copy";
import { cn } from "../lib/cn";

/** @param {string} search */
function parseNext(search) {
  const raw = new URLSearchParams(search).get("next");
  if (typeof raw !== "string" || raw.length === 0) return "/dashboard";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/dashboard";
  return raw;
}

const BUILTIN_LABEL = {
  google: "Google",
  github: "GitHub",
  microsoft: "Microsoft",
  discord: "Discord",
  linkedin: "LinkedIn",
  facebook: "Facebook",
  instagram: "Instagram",
  tiktok: "TikTok",
  apple: "Apple",
  x: "X",
  spotify: "Spotify",
};

function providerLabel(key) {
  const k = String(key || "").trim();
  if (BUILTIN_LABEL[k]) return BUILTIN_LABEL[k];
  return k.replace(/-/g, " ");
}

export function LoginPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    enabled,
    loading: authLoading,
    signedIn,
    refreshUser,
    signInWithPassword,
    signUp,
    signInWithOAuth,
    getPublicAuthConfig,
  } = useInsforgeAuth();

  const nextPath = useMemo(() => parseNext(searchParams.toString()), [searchParams]);

  const [mode, setMode] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [banner, setBanner] = useState(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [oauthProviders, setOauthProviders] = useState([]);
  const [customProviders, setCustomProviders] = useState([]);
  const [passwordMinLength, setPasswordMinLength] = useState(8);

  useEffect(() => {
    const status = searchParams.get("insforge_status");
    const type = searchParams.get("insforge_type");
    const err = searchParams.get("insforge_error");
    if (status === "success" && type === "verify_email") {
      setBanner(copy("login.verify_email_success"));
    } else if (status === "error" && type === "verify_email" && err) {
      setBanner(copy("shared.error.prefix", { error: err }));
    }
  }, [searchParams]);

  useEffect(() => {
    if (!enabled) {
      setConfigLoading(false);
      return;
    }
    let active = true;
    (async () => {
      const { data, error: cfgErr } = await getPublicAuthConfig();
      if (!active) return;
      if (cfgErr || !data) {
        setOauthProviders(["google", "github"]);
        setCustomProviders([]);
      } else {
        setOauthProviders(Array.isArray(data.oAuthProviders) ? data.oAuthProviders : []);
        setCustomProviders(Array.isArray(data.customOAuthProviders) ? data.customOAuthProviders : []);
        if (typeof data.passwordMinLength === "number" && data.passwordMinLength > 0) {
          setPasswordMinLength(data.passwordMinLength);
        }
      }
      setConfigLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [enabled, getPublicAuthConfig]);

  const isNativeLogin = useMemo(() => {
    return searchParams.get("native") === "1";
  }, [searchParams]);

  const autoProvider = useMemo(() => {
    return searchParams.get("provider") || null;
  }, [searchParams]);

  useEffect(() => {
    if (!enabled || authLoading) return;
    if (signedIn) {
      if (isNativeLogin) {
        // Native app login in browser: redirect to callback page which triggers URL scheme
        window.location.href = "/auth/native-callback";
        return;
      }
      navigate(nextPath, { replace: true });
    }
  }, [enabled, authLoading, signedIn, navigate, nextPath, isNativeLogin]);

  useEffect(() => {
    if (!enabled) return;
    refreshUser();
  }, [enabled, refreshUser]);

  const redirectAfterOAuth = useMemo(() => {
    if (typeof window === "undefined") return "";
    // For native app login, don't override — let InsforgeAuthContext use its default
    // /auth/callback?native=1 redirect so the callback page can detect native mode.
    if (isNativeLogin) return "";
    return `${window.location.origin}/`;
  }, [isNativeLogin]);

  const signInRedirectForEmail = useMemo(() => {
    if (typeof window === "undefined") return "";
    return `${window.location.origin}/`;
  }, []);

  const handleEmailAuth = useCallback(
    async (e) => {
      e.preventDefault();
      setError(null);
      setBusy(true);
      try {
        if (mode === "signup") {
          const { data, error: err } = await signUp({
            email: email.trim(),
            password,
            name: name.trim() || undefined,
            redirectTo: signInRedirectForEmail,
          });
          if (err) {
            setError(err.message || String(err));
            return;
          }
          if (data?.requireEmailVerification) {
            setBanner(copy("login.verify_email_pending"));
            setMode("signin");
            return;
          }
          navigate(nextPath, { replace: true });
          return;
        }
        const { error: err } = await signInWithPassword({
          email: email.trim(),
          password,
        });
        if (err) {
          setError(err.message || String(err));
          return;
        }
        navigate(nextPath, { replace: true });
      } finally {
        setBusy(false);
      }
    },
    [mode, email, password, name, signUp, signInWithPassword, navigate, nextPath, signInRedirectForEmail],
  );

  const handleOAuth = useCallback(
    async (provider) => {
      setError(null);
      setBusy(true);
      try {
        const { error: err } = await signInWithOAuth(provider, redirectAfterOAuth);
        if (err) setError(err.message || String(err));
      } finally {
        setBusy(false);
      }
    },
    [signInWithOAuth, redirectAfterOAuth],
  );

  // Mark native login in sessionStorage so /auth/callback knows to redirect to app
  useEffect(() => {
    if (isNativeLogin && typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem("tokentracker_native_login", "1");
      } catch {
        // Ignore storage failures; OAuth can still proceed without the marker.
      }
    }
  }, [isNativeLogin]);

  // Auto-trigger OAuth when opened from native app with ?native=1&provider=xxx
  useEffect(() => {
    if (!enabled || authLoading || signedIn || configLoading || !isNativeLogin || !autoProvider) return;
    const allProviders = [...oauthProviders, ...customProviders];
    if (allProviders.includes(autoProvider)) {
      handleOAuth(autoProvider);
    }
  }, [enabled, authLoading, signedIn, configLoading, isNativeLogin, autoProvider, oauthProviders, customProviders, handleOAuth]);

  const clearVerifyQuery = useCallback(() => {
    setSearchParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        n.delete("insforge_status");
        n.delete("insforge_type");
        n.delete("insforge_error");
        return n;
      },
      { replace: true },
    );
    setBanner(null);
  }, [setSearchParams]);

  if (!enabled) {
    return (
      <div className="min-h-screen bg-oai-gray-950 text-oai-white font-oai antialiased dark flex flex-col">
        <header className="border-b border-oai-gray-900 px-4 sm:px-6 py-4">
          <Link to="/" className="text-sm font-medium text-oai-gray-400 hover:text-white no-underline">
            {copy("login.back_home")}
          </Link>
        </header>
        <main className="flex-1 flex items-center justify-center px-4">
          <p className="text-oai-gray-400 text-center max-w-md">{copy("login.cloud_only")}</p>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-oai-gray-950 text-oai-white font-oai antialiased dark flex flex-col">
      <header className="border-b border-oai-gray-900 px-4 sm:px-6 h-16 flex items-center justify-between">
        <Link
          to="/"
          className="text-sm font-medium text-oai-gray-400 hover:text-white no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 rounded"
        >
          {copy("login.back_home")}
        </Link>
      </header>

      <main className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md space-y-8">
          <div className="text-center">
            <h1 className="text-2xl font-semibold text-white tracking-tight">{copy("login.title")}</h1>
            <p className="mt-2 text-sm text-oai-gray-500">{copy("login.subtitle")}</p>
          </div>

          {banner ? (
            <div
              className="rounded-lg border border-oai-gray-800 bg-oai-gray-900/50 px-4 py-3 text-sm text-oai-gray-300 flex justify-between gap-3 items-start"
              role="status"
            >
              <span>{banner}</span>
              <button
                type="button"
                onClick={clearVerifyQuery}
                className="shrink-0 text-oai-gray-500 hover:text-white text-xs"
              >
                {copy("login.dismiss")}
              </button>
            </div>
          ) : null}

          {error ? (
            <p className="text-sm text-red-400" role="alert">
              {copy("shared.error.prefix", { error: error })}
            </p>
          ) : null}

          <div className="space-y-3">
            {configLoading ? (
              <div className="h-11 rounded-lg bg-oai-gray-900 animate-pulse" aria-hidden />
            ) : (
              <>
                {oauthProviders.map((p) => (
                  <button
                    key={p}
                    type="button"
                    disabled={busy}
                    onClick={() => handleOAuth(p)}
                    className={cn(
                      "w-full h-11 rounded-lg border border-oai-gray-700 bg-oai-gray-900 text-sm font-medium text-white",
                      "hover:bg-oai-gray-800 transition-colors disabled:opacity-50",
                    )}
                  >
                    {copy("login.oauth.continue", { provider: providerLabel(p) })}
                  </button>
                ))}
                {customProviders.map((p) => (
                  <button
                    key={p}
                    type="button"
                    disabled={busy}
                    onClick={() => handleOAuth(p)}
                    className={cn(
                      "w-full h-11 rounded-lg border border-oai-gray-700 bg-oai-gray-900 text-sm font-medium text-white",
                      "hover:bg-oai-gray-800 transition-colors disabled:opacity-50",
                    )}
                  >
                    {copy("login.oauth.continue", { provider: providerLabel(p) })}
                  </button>
                ))}
              </>
            )}
          </div>

          <div className="relative">
            <div className="absolute inset-0 flex items-center" aria-hidden>
              <span className="w-full border-t border-oai-gray-800" />
            </div>
            <div className="relative flex justify-center text-xs uppercase tracking-wider">
              <span className="bg-oai-gray-950 px-3 text-oai-gray-600">{copy("login.divider")}</span>
            </div>
          </div>

          <div className="flex rounded-lg border border-oai-gray-800 p-0.5 bg-oai-gray-900/50">
            <button
              type="button"
              className={cn(
                "flex-1 py-2 text-sm font-medium rounded-md transition-colors",
                mode === "signin" ? "bg-oai-gray-800 text-white" : "text-oai-gray-500 hover:text-oai-gray-300",
              )}
              onClick={() => {
                setMode("signin");
                setError(null);
              }}
            >
              {copy("login.tab.sign_in")}
            </button>
            <button
              type="button"
              className={cn(
                "flex-1 py-2 text-sm font-medium rounded-md transition-colors",
                mode === "signup" ? "bg-oai-gray-800 text-white" : "text-oai-gray-500 hover:text-oai-gray-300",
              )}
              onClick={() => {
                setMode("signup");
                setError(null);
              }}
            >
              {copy("login.tab.sign_up")}
            </button>
          </div>

          <form onSubmit={handleEmailAuth} className="space-y-4">
            {mode === "signup" ? (
              <div>
                <label htmlFor="login-name" className="block text-xs font-medium text-oai-gray-500 mb-1">
                  {copy("login.field.name")}
                </label>
                <input
                  id="login-name"
                  type="text"
                  autoComplete="name"
                  value={name}
                  onChange={(ev) => setName(ev.target.value)}
                  className="w-full h-11 rounded-lg border border-oai-gray-800 bg-oai-gray-900 px-3 text-sm text-white placeholder-oai-gray-600 focus:outline-none focus:ring-2 focus:ring-oai-brand-500"
                  placeholder={copy("login.field.name_placeholder")}
                />
              </div>
            ) : null}
            <div>
              <label htmlFor="login-email" className="block text-xs font-medium text-oai-gray-500 mb-1">
                {copy("login.field.email")}
              </label>
              <input
                id="login-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(ev) => setEmail(ev.target.value)}
                className="w-full h-11 rounded-lg border border-oai-gray-800 bg-oai-gray-900 px-3 text-sm text-white placeholder-oai-gray-600 focus:outline-none focus:ring-2 focus:ring-oai-brand-500"
              />
            </div>
            <div>
              <label htmlFor="login-password" className="block text-xs font-medium text-oai-gray-500 mb-1">
                {copy("login.field.password")}
              </label>
              <input
                id="login-password"
                type="password"
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                required
                minLength={mode === "signup" ? passwordMinLength : undefined}
                value={password}
                onChange={(ev) => setPassword(ev.target.value)}
                className="w-full h-11 rounded-lg border border-oai-gray-800 bg-oai-gray-900 px-3 text-sm text-white placeholder-oai-gray-600 focus:outline-none focus:ring-2 focus:ring-oai-brand-500"
              />
              {mode === "signup" ? (
                <p className="mt-1 text-xs text-oai-gray-600">
                  {copy("login.password_hint", { min: String(passwordMinLength) })}
                </p>
              ) : null}
            </div>
            <button
              type="submit"
              disabled={busy || authLoading}
              className="w-full h-11 rounded-lg bg-white text-oai-gray-950 text-sm font-semibold hover:bg-oai-gray-100 transition-colors disabled:opacity-50"
            >
              {mode === "signup" ? copy("login.submit.sign_up") : copy("login.submit.sign_in")}
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}
