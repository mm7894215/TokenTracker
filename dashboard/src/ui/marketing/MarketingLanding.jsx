import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "../../lib/cn";
import { HeaderGithubStar } from "../openai/components/HeaderGithubStar.jsx";
import { useInsforgeAuth } from "../../contexts/InsforgeAuthContext.jsx";
import LaserFlow from "./components/LaserFlow.jsx";
import LightRays from "./components/LightRays.jsx";

function AppleIcon({ className }) {
  return (
    <svg viewBox="0 0 384 512" className={className} fill="currentColor">
      <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" />
    </svg>
  );
}

function GithubIcon({ className }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor">
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </svg>
  );
}

function CopyIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>
  );
}

function CheckIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polyline points="20 6 9 17 4 12"></polyline>
    </svg>
  );
}

function GoogleIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1Z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23Z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.96 10.96 0 0 0 1 12c0 1.77.42 3.44 1.18 4.93l3.66-2.84Z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53Z" fill="#EA4335" />
    </svg>
  );
}

const REPO_URL = "https://github.com/mm7894215/TokenTracker";
const MAC_RELEASE_URL = "https://github.com/mm7894215/TokenTracker/releases/latest";

function buttonClass(variant = "default", size = "md", className) {
  const base =
    "inline-flex items-center justify-center rounded font-medium transition-colors duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-oai-gray-950";
  const variants = {
    default:
      "bg-oai-gray-900 text-white hover:bg-oai-gray-800 active:bg-oai-gray-950 dark:bg-white dark:text-oai-gray-900 dark:hover:bg-oai-gray-100 dark:active:bg-oai-gray-200",
    ghost:
      "text-oai-gray-600 hover:text-oai-gray-900 hover:bg-oai-gray-100 active:bg-oai-gray-200 dark:text-oai-gray-400 dark:hover:text-white dark:hover:bg-oai-gray-800 dark:active:bg-oai-gray-700",
  };
  const sizes = {
    sm: "h-9 px-4 text-sm",
    md: "h-11 px-6 text-sm",
    lg: "h-12 px-8 text-base",
  };
  return cn(base, variants[variant], sizes[size], className);
}

export function MarketingLanding({
  copy,
  signInUrl,
  signUpUrl,
  installCommand,
  installCopied,
  onCopyInstallCommand,
}) {
  const reduceMotion = useReducedMotion();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 10);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const isLocalMode = useMemo(() => {
    if (typeof window === "undefined") return false;
    // Dev escape hatch: append `?cloud=1` to preview the cloud-signed-out
    // experience while running on localhost.
    if (new URLSearchParams(window.location.search).get("cloud") === "1") return false;
    return (
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1"
    );
  }, []);
  const { signedIn, loading: authLoading, signInWithOAuth } = useInsforgeAuth();
  // Hide the Google CTA when the visitor is local-mode or already signed in.
  const isInDashboardMode = isLocalMode || signedIn || authLoading;
  const [oauthBusy, setOauthBusy] = useState(false);
  const handleGoogleSignIn = useCallback(async () => {
    if (typeof window === "undefined") return;
    setOauthBusy(true);
    try {
      const { error: err } = await signInWithOAuth("google", `${window.location.origin}/`);
      if (err) {
        // Surface to console; the /login page remains available as a fallback
        // via the header LOGIN / SIGN UP buttons.
        console.error("[MarketingLanding] Google OAuth failed:", err);
      }
    } finally {
      setOauthBusy(false);
    }
  }, [signInWithOAuth]);

  const modelAgentLabels = useMemo(
    () => ({
      codex: copy("landing.v2.models.agent.codex"),
      claude_code: copy("landing.v2.models.agent.claude_code"),
      cursor: copy("landing.v2.models.agent.cursor"),
      gemini: copy("landing.v2.models.agent.gemini"),
      opencode: copy("landing.v2.models.agent.opencode"),
      openclaw: copy("landing.v2.models.agent.openclaw"),
    }),
    [copy],
  );

  const modelAgents = useMemo(
    () => [
      { id: "codex", icon: "/brand-logos/codex.svg" },
      { id: "claude_code", icon: "/brand-logos/claude-code.svg" },
      { id: "cursor", icon: "/brand-logos/cursor.svg" },
      { id: "gemini", icon: "/brand-logos/gemini.svg" },
      { id: "opencode", icon: "/brand-logos/opencode.svg" },
      { id: "openclaw", icon: "/brand-logos/openclaw.svg" },
    ],
    [],
  );

  const spring = reduceMotion ? { duration: 0 } : undefined;

  return (
    <div className="relative min-h-screen bg-oai-gray-950 text-oai-white font-oai antialiased dark">
      {/* LightRays — covers header + hero, behind all content */}
      <div className="absolute inset-0 z-0 pointer-events-none" style={{ height: "100vh" }}>
        <LightRays
          raysOrigin="top-center"
          raysColor="#b8b3ff"
          raysSpeed={1}
          lightSpread={0.5}
          rayLength={3}
          pulsating={false}
          fadeDistance={1}
          saturation={1}
          followMouse
          mouseInfluence={0.1}
          noiseAmount={0}
          distortion={0}
        />
      </div>
      <header className={cn("sticky top-0 z-50 transition-all duration-300", scrolled ? "bg-oai-gray-950/80 backdrop-blur-md border-b border-oai-gray-900" : "bg-transparent border-b border-transparent")}>
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-5">
            <Link
              to={signUpUrl || "/"}
              className="flex items-center gap-3 no-underline outline-none rounded focus-visible:ring-2 focus-visible:ring-oai-brand-500 focus-visible:ring-offset-2 dark:ring-offset-oai-gray-950 transition-opacity hover:opacity-80"
            >
              <img src="/app-icon.png" alt="" width={24} height={24} className="rounded-md" />
              <span className="text-sm font-semibold tracking-wide text-white uppercase">
                Token Tracker
              </span>
            </Link>
            <div className="hidden sm:block">
              <HeaderGithubStar />
            </div>
          </div>
        </div>
      </header>

      <main>
        <section className="relative py-16 sm:py-24 lg:py-32 overflow-hidden">
          <div className="relative z-10 mx-auto max-w-7xl px-4 sm:px-6 flex flex-col items-center text-center gap-20 lg:gap-36">
            <motion.div
              initial={reduceMotion ? false : { opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={spring || { duration: 0.5 }}
              className="w-full max-w-3xl relative z-20"
            >
                <h1 className="text-balance text-5xl font-semibold tracking-tight text-white sm:text-6xl lg:text-[4rem] lg:leading-[1.05]">
                  {copy("landing.v2.hero.title_line1")}
                  <br />
                  <span 
                    className="bg-gradient-to-b from-white via-oai-gray-200 to-oai-gray-500 bg-clip-text text-transparent font-bold tracking-tight"
                    style={{ WebkitTextStroke: "1px rgba(255, 255, 255, 0.15)" }}
                  >
                    {copy("landing.v2.hero.title_line2")}
                  </span>
                </h1>
                <p className="mt-6 text-lg leading-relaxed text-oai-gray-400">
                  {copy("landing.v2.hero.subtagline")}
                </p>

                <div className="mt-8 w-full max-w-lg mx-auto">
                  <motion.div
                    whileHover={{ scale: 1.01, y: -1 }}
                    transition={{ type: "spring", stiffness: 400, damping: 25 }}
                    className="group relative inline-block w-full overflow-hidden rounded-2xl"
                    style={{ padding: "1.5px 0" }}
                  >
                    {/* Star border orbs */}
                    <div
                      className="absolute w-[300%] h-[50%] opacity-70 bottom-[-11px] right-[-250%] rounded-full animate-star-movement-bottom z-0"
                      style={{
                        background: "radial-gradient(circle, #fbdfff, transparent 10%)",
                        animationDuration: "6s",
                      }}
                    />
                    <div
                      className="absolute w-[300%] h-[50%] opacity-70 top-[-10px] left-[-250%] rounded-full animate-star-movement-top z-0"
                      style={{
                        background: "radial-gradient(circle, #fbdfff, transparent 10%)",
                        animationDuration: "6s",
                      }}
                    />

                    <div className="relative z-[1] flex items-center justify-between w-full bg-[#0a0a0a] border border-oai-gray-800 rounded-2xl p-1.5 pl-5 shadow-2xl shadow-black/50">
                      <div className="flex items-center gap-3 overflow-hidden">
                        <span className="text-oai-gray-600 font-mono select-none" aria-hidden="true">›</span>
                        <code className="font-mono text-sm text-oai-gray-200 overflow-x-auto whitespace-nowrap py-2 [scrollbar-width:none]">
                          {installCommand ? installCommand.split(' ').map((part, i) => (
                            <span key={i} className={
                              part === 'npx' || part === 'tokentracker-cli'
                                ? 'text-white font-medium'
                                : part === '--yes'
                                  ? 'text-oai-gray-500'
                                  : 'text-oai-brand-400'
                            }>
                              {part}{' '}
                            </span>
                          )) : null}
                        </code>
                      </div>

                      <button
                        type="button"
                        onClick={onCopyInstallCommand}
                        aria-label={
                          installCopied ? copy("landing.install.action.copied") : copy("landing.install.action.copy")
                        }
                        className="shrink-0 flex h-9 w-9 items-center justify-center text-oai-gray-200 bg-oai-gray-900 border border-oai-gray-700 rounded-lg hover:bg-oai-gray-800 hover:text-white active:scale-95 transition-all duration-200 shadow-sm"
                      >
                        {installCopied ? (
                          <CheckIcon className="h-4 w-4 text-green-400" aria-hidden />
                        ) : (
                          <CopyIcon className="h-4 w-4 opacity-70" aria-hidden />
                        )}
                      </button>
                    </div>
                  </motion.div>
                  
                  {!isInDashboardMode && (
                    <motion.div
                      whileHover={reduceMotion ? undefined : { scale: 1.01, y: -1 }}
                      transition={{ type: "spring", stiffness: 400, damping: 25 }}
                      className="group relative mt-3 inline-block w-full overflow-hidden rounded-2xl"
                      style={{ padding: "1.5px 0" }}
                    >
                      <div
                        className="absolute w-[300%] h-[50%] opacity-70 bottom-[-11px] right-[-250%] rounded-full animate-star-movement-bottom z-0"
                        style={{
                          background: "radial-gradient(circle, #b8b3ff, transparent 10%)",
                          animationDuration: "6s",
                        }}
                      />
                      <div
                        className="absolute w-[300%] h-[50%] opacity-70 top-[-10px] left-[-250%] rounded-full animate-star-movement-top z-0"
                        style={{
                          background: "radial-gradient(circle, #b8b3ff, transparent 10%)",
                          animationDuration: "6s",
                        }}
                      />
                      <button
                        type="button"
                        onClick={handleGoogleSignIn}
                        disabled={oauthBusy}
                        className="relative z-[1] flex h-12 w-full items-center justify-center gap-2.5 rounded-2xl border border-[#b8b3ff]/30 bg-gradient-to-b from-[#a89eff] to-[#6d5ff0] text-base font-semibold text-white shadow-[0_0_24px_rgba(138,122,255,0.3)] transition-all duration-200 group-hover:from-[#c1b8ff] group-hover:to-[#7d6ffa] group-hover:shadow-[0_8px_32px_rgba(138,122,255,0.45)] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white">
                          <GoogleIcon className="h-3.5 w-3.5" />
                        </span>
                        {copy("login.oauth.continue", { provider: "Google" })}
                      </button>
                    </motion.div>
                  )}

                  <div className="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-4">
                    <a href={MAC_RELEASE_URL} target="_blank" rel="noopener noreferrer" className="group flex items-center gap-2 text-sm font-medium text-oai-gray-400 hover:text-white transition-colors">
                      <div className="flex items-center justify-center h-8 w-8 rounded-full bg-oai-gray-800 group-hover:bg-oai-gray-700 transition-colors">
                        <AppleIcon className="h-4 w-4 text-oai-gray-400 group-hover:text-white" />
                      </div>
                      {copy("landing.v2.install.mac_cta")}
                    </a>
                    <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className="group flex items-center gap-2 text-sm font-medium text-oai-gray-400 hover:text-white transition-colors">
                      <div className="flex items-center justify-center h-8 w-8 rounded-full bg-oai-gray-800 group-hover:bg-oai-gray-700 transition-colors">
                        <GithubIcon className="h-4 w-4 text-oai-gray-400 group-hover:text-white" />
                      </div>
                      {copy("landing.cta.secondary")}
                    </a>
                  </div>
                  <span className="sr-only" aria-live="polite">
                    {installCopied ? copy("landing.install.action.copied") : ""}
                  </span>
                </div>
            </motion.div>

            <div className="relative group w-full">
              <motion.div
                initial={reduceMotion ? false : { opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                transition={spring || { duration: 0.6, delay: 0.1 }}
                className="relative w-full"
              >
                {/* LaserFlow: z-index低于图片，光柱从天空落在图片顶边 */}
                <div
                  style={{
                    position: 'absolute',
                    top: '-256px',
                    left: 0,
                    right: 0,
                    height: '510px',
                    zIndex: 3,
                    pointerEvents: 'none',
                  }}
                >
                  <LaserFlow
                    color="#8a7aff"
                    wispDensity={2}
                    flowSpeed={0.28}
                    verticalSizing={2.2}
                    horizontalSizing={1.22}
                    fogIntensity={4.0}
                    fogScale={0.1}
                    wispSpeed={18}
                    wispIntensity={10}
                    flowStrength={0.12}
                    decay={1.1}
                    falloffStart={1.1}
                    fogFallSpeed={0.5}
                    horizontalBeamOffset={0.22}
                    verticalBeamOffset={0}
                    style={{ width: '100%', height: '100%' }}
                  />
                </div>

                {/* 图片容器：发亮、暗亮变化的渐变边框 */}
                <div className="relative rounded-xl p-[1px] shadow-2xl bg-gradient-to-b from-[rgba(138,122,255,0.6)] via-[rgba(138,122,255,0.15)] to-[rgba(138,122,255,0.05)]"
                  style={{
                    position: 'relative',
                    zIndex: 10,
                    boxShadow: '0 20px 60px -10px rgba(138,122,255,0.15), 0 4px 20px rgba(0,0,0,0.4)',
                  }}
                >
                  <div className="relative rounded-[11px] overflow-hidden bg-oai-gray-950">
                    {/* 顶部光线渗透渐变 */}
                    <div
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        right: 0,
                        height: '180px',
                        background: 'linear-gradient(to bottom, rgba(138,122,255,0.35) 0%, rgba(138,122,255,0.12) 40%, transparent 100%)',
                        mixBlendMode: 'screen',
                        zIndex: 20,
                        pointerEvents: 'none',
                      }}
                    />
                    {/* 顶部亮线 */}
                    <div
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        right: 0,
                        height: '1px',
                        background: 'linear-gradient(90deg, transparent 0%, rgba(138,122,255,0.9) 30%, rgba(180,168,255,1) 50%, rgba(138,122,255,0.9) 70%, transparent 100%)',
                        zIndex: 25,
                        pointerEvents: 'none',
                      }}
                    />
                    <img
                      src="/dashboard-dark.png"
                      alt={copy("landing.screenshot.alt")}
                      className="block h-auto w-full object-cover"
                      style={{ position: 'relative', zIndex: 10 }}
                      loading="eager"
                      decoding="async"
                    />
                  </div>
                </div>
              </motion.div>
            </div>
          </div>
        </section>

        <section className="border-y border-oai-gray-900 bg-oai-gray-950/50 py-12 lg:py-16">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-8">
              <p className="text-sm font-semibold uppercase tracking-wider text-oai-gray-400 shrink-0">
                {copy("landing.v2.models.title")}
              </p>
              <div className="flex flex-wrap items-center gap-x-8 gap-y-6 opacity-60 hover:opacity-100 transition-opacity duration-500 grayscale hover:grayscale-0">
                {modelAgents.map((a) => (
                  <div key={a.id} className="flex items-center gap-2.5 transition-transform hover:-translate-y-0.5 duration-300">
                    <img
                      src={a.icon}
                      alt=""
                      width={20}
                      height={20}
                      className={`h-5 w-5 object-contain ${a.id === "cursor" ? "dark:invert" : ""}`}
                      loading="lazy"
                    />
                    <span className="text-sm font-medium text-oai-gray-300">
                      {modelAgentLabels[a.id]}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="py-20 lg:py-32">
          <div className="mx-auto max-w-6xl px-4 sm:px-6 grid grid-cols-1 md:grid-cols-2 gap-16 lg:gap-24 items-start">
            <div className="max-w-md">
              <p className="text-xs font-bold tracking-widest uppercase text-oai-brand-500 mb-4">
                {copy("landing.v2.compare.kicker")}
              </p>
              <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl text-balance">
                {copy("landing.v2.compare.title")}
              </h2>
              <p className="mt-6 text-lg leading-relaxed text-oai-gray-400">
                {copy("landing.v2.compare.subtitle")}
              </p>
              <p className="mt-6 text-base leading-relaxed text-oai-gray-500">
                {copy("landing.v2.distill.body")}
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-10">
              <div className="space-y-4">
                <h3 className="text-sm font-semibold uppercase tracking-wider text-white border-b border-oai-gray-800 pb-3">
                  {copy("landing.v2.compare.with.title")}
                </h3>
                <ul className="space-y-3 text-sm text-oai-gray-400">
                  <li className="flex gap-2">
                    <span className="text-oai-brand-500 shrink-0">✦</span>
                    <span>{copy("landing.v2.compare.with.p1")}</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="text-oai-brand-500 shrink-0">✦</span>
                    <span>{copy("landing.v2.compare.with.p2")}</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="text-oai-brand-500 shrink-0">✦</span>
                    <span>{copy("landing.v2.compare.with.p3")}</span>
                  </li>
                </ul>
              </div>
              <div className="space-y-4">
                <h3 className="text-sm font-semibold uppercase tracking-wider text-oai-gray-500 border-b border-oai-gray-800/50 pb-3">
                  {copy("landing.v2.compare.without.title")}
                </h3>
                <ul className="space-y-3 text-sm text-oai-gray-500">
                  <li className="flex gap-2">
                    <span className="opacity-50 shrink-0">✕</span>
                    <span>{copy("landing.v2.compare.without.p1")}</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="opacity-50 shrink-0">✕</span>
                    <span>{copy("landing.v2.compare.without.p2")}</span>
                  </li>
                  <li className="flex gap-2">
                    <span className="opacity-50 shrink-0">✕</span>
                    <span>{copy("landing.v2.compare.without.p3")}</span>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-oai-gray-900 bg-oai-gray-950 py-12">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 px-4 sm:px-6 text-sm text-oai-gray-400 sm:flex-row">
          <p>{copy("landing.v2.footer.line")}</p>
          <div className="flex items-center gap-6">
            <a
              href={REPO_URL}
              className="font-medium text-oai-gray-400 hover:text-white transition-colors"
              target="_blank"
              rel="noopener noreferrer"
            >
              {copy("landing.v2.nav.github")}
            </a>
            {isLocalMode && (
              <Link
                to={signInUrl}
                className="font-medium text-oai-brand-500 hover:text-oai-brand-400 transition-colors"
              >
                {copy("landing.cta.primary")} &rarr;
              </Link>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}
