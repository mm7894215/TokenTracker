import React, { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Award, ChevronUp, LogIn, LogOut, Settings as SettingsIcon } from "lucide-react";
import { useInsforgeAuth } from "../contexts/InsforgeAuthContext.jsx";
import { useLoginModal } from "../contexts/LoginModalContext.jsx";
import { useLocale } from "../hooks/useLocale.js";
import { isNativeApp } from "../lib/native-bridge.js";
import { copy } from "../lib/copy";
import { cn } from "../lib/cn";

function pickAvatarUrl(user) {
  if (!user || typeof user !== "object") return null;
  const meta = user.user_metadata && typeof user.user_metadata === "object" ? user.user_metadata : {};
  const prof = user.profile && typeof user.profile === "object" ? user.profile : {};
  const u = meta.avatar_url || meta.picture || prof.avatar_url || user.avatar_url;
  return typeof u === "string" && u.trim() ? u.trim() : null;
}

// In TokenTrackerBar WKWebView, third-party avatar CDNs (lh3.googleusercontent.com,
// avatars.githubusercontent.com) intermittently fail to load even when they
// render fine in Safari. Route them through the local CLI server, which fetches
// via Node and serves the bytes as same-origin — that path is reliable.
// On Vercel (no local server) we keep the original URL.
function resolveAvatarSrc(url) {
  if (!url) return null;
  if (!isNativeApp()) return url;
  return `/api/avatar-proxy?url=${encodeURIComponent(url)}`;
}

function initialsFromName(name) {
  const s = String(name || "").trim();
  if (!s) return "?";
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}

function SidebarAccountMenu({ signedIn, onNavigate, onSignIn, onSignOut }) {
  const itemClass = "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] text-oai-gray-700 transition-colors hover:bg-oai-gray-100 hover:text-oai-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-oai-brand-500 dark:text-oai-gray-300 dark:hover:bg-oai-gray-800 dark:hover:text-white";
  return (
    <div
      role="menu"
      className="absolute bottom-full left-0 z-50 mb-2 w-[208px] rounded-xl border border-oai-gray-200 bg-white p-1.5 shadow-lg dark:border-oai-gray-800 dark:bg-oai-gray-900"
    >
      <button type="button" role="menuitem" onClick={() => onNavigate("/settings")} className={itemClass}>
        <SettingsIcon className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden />
        <span>{copy("nav.settings")}</span>
      </button>
      <button type="button" role="menuitem" onClick={() => onNavigate("/achievements")} className={itemClass}>
        <Award className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden />
        <span>{copy("nav.achievements")}</span>
      </button>
      <div className="my-1 h-px bg-oai-gray-200/80 dark:bg-oai-gray-800" aria-hidden />
      {signedIn ? (
        <button
          type="button"
          role="menuitem"
          onClick={onSignOut}
          className={cn(itemClass, "text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/30 dark:hover:text-red-300")}
        >
          <LogOut className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden />
          <span>{copy("settings.account.signOut")}</span>
        </button>
      ) : (
        <button type="button" role="menuitem" onClick={onSignIn} className={itemClass}>
          <LogIn className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden />
          <span>{copy("header.auth.sign_in_aria")}</span>
        </button>
      )}
    </div>
  );
}

/**
 * Compact identity control. The header variant opens Settings directly; the
 * sidebar variant owns the account menu for Settings, Achievements, and the
 * current authentication action.
 */
export function InsforgeUserHeaderControls({ className, variant = "header", collapsed = false, onAfterAction }) {
  // Subscribe to locale so labels re-render on language switch.
  useLocale();
  const isSidebar = variant === "sidebar";
  const { enabled, loading, signedIn, user, displayName, signOut } = useInsforgeAuth();
  const { openLoginModal } = useLoginModal();
  const navigate = useNavigate();
  const avatarUrl = useMemo(() => pickAvatarUrl(user), [user]);
  const avatarSrc = useMemo(() => resolveAvatarSrc(avatarUrl), [avatarUrl]);
  const [avatarFailed, setAvatarFailed] = React.useState(false);
  const [sidebarMenuOpen, setSidebarMenuOpen] = React.useState(false);
  const sidebarMenuRef = React.useRef(null);

  React.useEffect(() => {
    setAvatarFailed(false);
  }, [avatarSrc]);

  React.useEffect(() => {
    if (!isSidebar || !sidebarMenuOpen) return undefined;
    const onPointerDown = (event) => {
      if (sidebarMenuRef.current && !sidebarMenuRef.current.contains(event.target)) {
        setSidebarMenuOpen(false);
      }
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") setSidebarMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isSidebar, sidebarMenuOpen]);

  const handleSidebarNavigate = (path) => {
    setSidebarMenuOpen(false);
    navigate(path);
    onAfterAction?.();
  };
  const handleSidebarSignIn = () => {
    setSidebarMenuOpen(false);
    openLoginModal();
    onAfterAction?.();
  };
  const handleSidebarSignOut = async () => {
    setSidebarMenuOpen(false);
    await signOut();
    onAfterAction?.();
  };

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
        <div ref={sidebarMenuRef} className={cn("relative w-full", className)}>
          <button
            type="button"
            onClick={() => setSidebarMenuOpen((open) => !open)}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] font-medium text-oai-gray-700 dark:text-oai-gray-300 hover:bg-oai-gray-200/60 dark:hover:bg-oai-gray-800 hover:text-oai-black dark:hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 min-w-0",
              collapsed ? "h-8 w-8 justify-center px-0" : "w-full",
            )}
            aria-label={copy("header.auth.open_account_menu")}
            aria-expanded={sidebarMenuOpen}
            aria-haspopup="menu"
            title={collapsed ? copy("header.auth.open_account_menu") : undefined}
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
            {!collapsed && (
              <>
                <span className="truncate flex-1 text-left">{copy("header.auth.sign_in_aria")}</span>
                <ChevronUp className={cn("h-3.5 w-3.5 shrink-0 transition-transform", sidebarMenuOpen && "rotate-180")} aria-hidden />
              </>
            )}
          </button>
          {sidebarMenuOpen && (
            <SidebarAccountMenu
              signedIn={false}
              onNavigate={handleSidebarNavigate}
              onSignIn={handleSidebarSignIn}
              onSignOut={handleSidebarSignOut}
            />
          )}
        </div>
      );
    }
    return (
      <button
        type="button"
        onClick={openLoginModal}
        className={cn(
          "shrink-0 inline-flex h-9 items-center justify-center gap-1.5 rounded-md px-4 text-sm font-medium transition-colors duration-200 ease-out shadow-sm ring-1 ring-oai-gray-200 dark:ring-white/10 bg-oai-gray-900 text-white hover:bg-oai-gray-800 active:bg-oai-gray-950 dark:bg-white dark:text-oai-gray-900 dark:hover:bg-oai-gray-100 dark:active:bg-oai-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-oai-gray-950",
          className,
        )}
        aria-label={copy("header.auth.sign_in_aria")}
      >
        {copy("header.auth.sign_in_aria")}
      </button>
    );
  }

  const handleClick = () => {
    if (isSidebar) {
      setSidebarMenuOpen((open) => !open);
      return;
    }
    navigate("/settings");
    onAfterAction?.();
  };

  return (
    <div
      ref={isSidebar ? sidebarMenuRef : undefined}
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
            : "flex items-center gap-2 rounded-md pl-1 pr-2 py-1 border border-transparent hover:bg-oai-gray-100 dark:hover:bg-oai-gray-900/80 hover:border-oai-gray-200 dark:hover:border-oai-gray-800 transition-colors",
        )}
        aria-label={isSidebar ? copy("header.auth.open_account_menu") : copy("header.auth.open_settings")}
        aria-expanded={isSidebar ? sidebarMenuOpen : undefined}
        aria-haspopup={isSidebar ? "menu" : undefined}
        title={isSidebar && collapsed ? (displayName) : undefined}
      >
        {isSidebar ? (
          <span className="flex h-5 w-5 shrink-0 items-center justify-center">
            {avatarSrc && !avatarFailed ? (
              <img
                src={avatarSrc}
                alt=""
                width={20}
                height={20}
                className="h-5 w-5 rounded-full object-cover ring-1 ring-oai-gray-300 dark:ring-oai-gray-700"
                referrerPolicy="no-referrer"
                onError={() => setAvatarFailed(true)}
              />
            ) : initialsFromName(displayName) === "?" ? (
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-oai-brand-600/30 text-white ring-1 ring-oai-brand-500/50">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3 h-3 opacity-80">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                </svg>
              </span>
            ) : (
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-oai-brand-600 text-[9px] font-semibold text-white ring-1 ring-oai-brand-500/50">
                {initialsFromName(displayName)}
              </span>
            )}
          </span>
        ) : avatarSrc && !avatarFailed ? (
          <img
            src={avatarSrc}
            alt=""
            width={32}
            height={32}
            className="h-8 w-8 rounded-full object-cover ring-1 ring-oai-gray-300 dark:ring-oai-gray-700 shrink-0"
            referrerPolicy="no-referrer"
            onError={() => setAvatarFailed(true)}
          />
        ) : initialsFromName(displayName) === "?" ? (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-oai-brand-600/30 text-white ring-1 ring-oai-brand-500/50">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-4 h-4 opacity-80">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
            </svg>
          </span>
        ) : (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-oai-brand-600 text-xs font-semibold text-white ring-1 ring-oai-brand-500/50">
            {initialsFromName(displayName)}
          </span>
        )}
        {isSidebar ? (
          !collapsed && (
            <>
              <span className="truncate text-[13px] font-medium text-oai-gray-900 dark:text-oai-gray-200 flex-1 text-left min-w-0">
                {displayName}
              </span>
              <ChevronUp className={cn("h-3.5 w-3.5 shrink-0 text-oai-gray-400 transition-transform", sidebarMenuOpen && "rotate-180")} aria-hidden />
            </>
          )
        ) : (
          <span className="hidden sm:inline truncate text-sm font-medium text-oai-gray-900 dark:text-oai-gray-200 max-w-[120px]">
            {displayName}
          </span>
        )}
      </button>
      {isSidebar && sidebarMenuOpen && (
        <SidebarAccountMenu
          signedIn
          onNavigate={handleSidebarNavigate}
          onSignIn={handleSidebarSignIn}
          onSignOut={handleSidebarSignOut}
        />
      )}
    </div>
  );
}
