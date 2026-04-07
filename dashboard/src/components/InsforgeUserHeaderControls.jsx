import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useInsforgeAuth } from "../contexts/InsforgeAuthContext.jsx";
import { useLoginModal } from "../contexts/LoginModalContext.jsx";
import { resolveAuthAccessTokenWithRetry } from "../lib/auth-token";
import { getPublicVisibility } from "../lib/api";
import { copy } from "../lib/copy";
import { cn } from "../lib/cn";

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

function pickAvatarUrl(user) {
  if (!user || typeof user !== "object") return null;
  const meta = user.user_metadata && typeof user.user_metadata === "object" ? user.user_metadata : {};
  const prof = user.profile && typeof user.profile === "object" ? user.profile : {};
  const u = meta.avatar_url || meta.picture || prof.avatar_url || user.avatar_url;
  return typeof u === "string" && u.trim() ? u.trim() : null;
}

function initialsFromName(name) {
  const s = String(name || "").trim();
  if (!s) return "?";
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}

/**
 * Compact identity control. Avatar click navigates to /settings — all account
 * preferences live there now. Sign-in shows the login modal as before.
 */
export function InsforgeUserHeaderControls({ className, variant = "header", collapsed = false, onAfterAction }) {
  const isSidebar = variant === "sidebar";
  const { enabled, loading, signedIn, user, getAccessToken } = useInsforgeAuth();
  const { openLoginModal } = useLoginModal();
  const navigate = useNavigate();
  const [customDisplayName, setCustomDisplayName] = useState(null);

  const displayName = useMemo(() => pickDisplayName(user), [user]);
  const avatarUrl = useMemo(() => pickAvatarUrl(user), [user]);

  // Fetch the cloud-side custom display name (if any) so the sidebar matches Settings.
  useEffect(() => {
    if (!signedIn) return;
    let active = true;
    (async () => {
      try {
        const token = await resolveAuthAccessTokenWithRetry({ getAccessToken });
        if (!active || !token) return;
        const data = await getPublicVisibility({ accessToken: token });
        if (active && data?.display_name) setCustomDisplayName(data.display_name);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      active = false;
    };
  }, [signedIn, getAccessToken]);

  if (!enabled) return null;

  if (loading) {
    return (
      <div
        className={cn("h-9 w-9 shrink-0 rounded-full bg-oai-gray-200 dark:bg-oai-gray-800 animate-pulse", className)}
        aria-hidden
      />
    );
  }

  if (!signedIn) {
    if (isSidebar) {
      return (
        <button
          type="button"
          onClick={() => { openLoginModal(); onAfterAction?.(); }}
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] font-medium text-oai-gray-700 dark:text-oai-gray-300 hover:bg-oai-gray-200/60 dark:hover:bg-oai-gray-800 hover:text-oai-black dark:hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 min-w-0",
            collapsed ? "h-8 w-8 justify-center px-0" : "w-full",
            className,
          )}
          aria-label={copy("header.auth.sign_in_aria")}
          title={collapsed ? "Sign In" : undefined}
        >
          <span className="flex h-5 w-5 shrink-0 items-center justify-center">
            <img
              src="/app-icon.png"
              alt=""
              width={18}
              height={18}
              className="h-[18px] w-[18px] rounded"
            />
          </span>
          {!collapsed && <span className="truncate flex-1 text-left">Sign in</span>}
        </button>
      );
    }
    return (
      <button
        type="button"
        onClick={openLoginModal}
        className={cn(
          "shrink-0 inline-flex h-9 items-center justify-center gap-1.5 rounded-full px-5 text-sm font-medium transition-colors duration-200 ease-out shadow-sm ring-1 ring-oai-gray-200 dark:ring-white/10 bg-oai-gray-900 text-white hover:bg-oai-gray-800 active:bg-oai-gray-950 dark:bg-white dark:text-oai-gray-900 dark:hover:bg-oai-gray-100 dark:active:bg-oai-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-oai-gray-950",
          className,
        )}
        aria-label={copy("header.auth.sign_in_aria")}
      >
        Sign In
      </button>
    );
  }

  const handleClick = () => {
    navigate("/settings");
    onAfterAction?.();
  };

  return (
    <div
      className={cn(
        isSidebar ? "relative flex w-full shrink-0 items-center" : "relative flex shrink-0 items-center",
        className,
      )}
    >
      <button
        type="button"
        onClick={handleClick}
        className={cn(
          isSidebar
            ? cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-oai-gray-200/60 dark:hover:bg-oai-gray-800 transition-colors min-w-0",
                collapsed && "justify-center px-0 py-0 h-9 w-9",
              )
            : "flex items-center gap-2 rounded-full pl-1 pr-2 py-1 border border-transparent hover:bg-oai-gray-100 dark:hover:bg-oai-gray-900/80 hover:border-oai-gray-200 dark:hover:border-oai-gray-800 transition-colors",
        )}
        aria-label={copy("header.auth.open_settings")}
        title={isSidebar && collapsed ? (customDisplayName || displayName) : undefined}
      >
        {isSidebar ? (
          <span className="flex h-5 w-5 shrink-0 items-center justify-center">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt=""
                width={20}
                height={20}
                className="h-5 w-5 rounded-full object-cover ring-1 ring-oai-gray-300 dark:ring-oai-gray-700"
                referrerPolicy="no-referrer"
              />
            ) : (
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-oai-brand-600 text-[9px] font-semibold text-white ring-1 ring-oai-brand-500/50">
                {initialsFromName(displayName)}
              </span>
            )}
          </span>
        ) : avatarUrl ? (
          <img
            src={avatarUrl}
            alt=""
            width={32}
            height={32}
            className="h-8 w-8 rounded-full object-cover ring-1 ring-oai-gray-300 dark:ring-oai-gray-700 shrink-0"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-oai-brand-600 text-xs font-semibold text-white ring-1 ring-oai-brand-500/50">
            {initialsFromName(displayName)}
          </span>
        )}
        {isSidebar ? (
          !collapsed && (
            <span className="truncate text-[13px] font-medium text-oai-gray-900 dark:text-oai-gray-200 flex-1 text-left min-w-0">
              {customDisplayName || displayName}
            </span>
          )
        ) : (
          <span className="hidden sm:inline truncate text-sm font-medium text-oai-gray-900 dark:text-oai-gray-200 max-w-[120px]">
            {customDisplayName || displayName}
          </span>
        )}
      </button>
    </div>
  );
}
