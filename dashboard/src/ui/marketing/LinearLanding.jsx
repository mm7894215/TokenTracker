import React, { useEffect, useMemo, useState } from "react";
import "@fontsource-variable/inter";
import { Link } from "react-router-dom";
import { motion, useReducedMotion, useScroll, useTransform } from "motion/react";
import {
  ArrowRight,
  BarChart3,
  Check,
  Copy,
  Download,
  Gauge,
  GitBranch,
  LockKeyhole,
  MonitorDot,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { useInsforgeAuth } from "../../contexts/InsforgeAuthContext.jsx";
import { useLoginModal } from "../../contexts/LoginModalContext.jsx";
import { cn } from "../../lib/cn";
import { STATUSPAGE_URL } from "../../lib/config";
import { getDashboardEntryPath } from "../../lib/host-mode";
import { detectOS } from "../../lib/os";
import { HeaderGithubStar } from "../components/HeaderGithubStar.jsx";
import { ProviderIcon } from "../dashboard/components/ProviderIcon.jsx";

const REPO_URL = "https://github.com/mm7894215/TokenTracker";
const RELEASES_URL = "https://github.com/mm7894215/TokenTracker/releases/latest";
const MAC_DMG_URL = `${RELEASES_URL}/download/TokenTrackerBar.dmg`;
const WIN_SETUP_URL = `${RELEASES_URL}/download/TokenTracker-Setup.exe`;

// Shared motion vocabulary — Linear-style staggered fade-up on an ease-out-expo
// curve. All entrances are gated by prefers-reduced-motion at the call site.
const EASE_OUT = [0.22, 1, 0.36, 1];
const fadeUp = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE_OUT } },
};
const fadeUpSm = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE_OUT } },
};
const heroStagger = { hidden: {}, show: { transition: { staggerChildren: 0.08, delayChildren: 0.05 } } };
const chipStagger = { hidden: {}, show: { transition: { staggerChildren: 0.035 } } };
const rowStagger = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } };

// One eyebrow/kicker treatment everywhere a section is introduced.
const EYEBROW = "text-xs font-medium uppercase tracking-[0.08em] text-oai-gray-500";

function actionClass(variant = "primary", className) {
  const variants = {
    primary:
      "bg-white text-oai-gray-950 shadow-lg shadow-black/30 hover:bg-oai-gray-100 active:bg-oai-gray-200",
    secondary:
      "border border-white/20 bg-white/[0.04] text-white hover:border-white/20 hover:bg-white/[0.06] active:bg-white/[0.08]",
    ghost:
      "text-oai-gray-400 hover:bg-white/[0.04] hover:text-white active:bg-white/[0.08]",
  };

  return cn(
    "group inline-flex h-10 items-center justify-center gap-2 rounded-full px-4 text-sm font-medium transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40",
    variants[variant],
    className,
  );
}

function AnimatedBlock({ children, className, delay = 0 }) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.6, ease: EASE_OUT, delay }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

function NavLink({ href, children }) {
  return (
    <a
      href={href}
      className="rounded-md px-2 py-1 text-sm font-medium text-oai-gray-400 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
    >
      {children}
    </a>
  );
}

function SectionIntro({ kicker, title, body, className }) {
  return (
    <AnimatedBlock className={cn("max-w-2xl", className)}>
      <p className={EYEBROW}>{kicker}</p>
      <h2 className="mt-4 text-3xl font-semibold -tracking-[0.02em] text-white sm:text-4xl">
        {title}
      </h2>
      {body ? <p className="mt-5 max-w-xl text-base leading-7 text-oai-gray-400">{body}</p> : null}
    </AnimatedBlock>
  );
}

function ProductPreview({ copy }) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.8, ease: EASE_OUT, delay: 0.12 }}
      className="relative mx-auto w-full max-w-7xl rounded-xl bg-white/[0.04] p-px"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-px rounded-xl bg-[linear-gradient(150deg,theme(colors.white/.5),theme(colors.white/.12)_15%,transparent_42%,transparent_58%,theme(colors.white/.24)_80%,theme(colors.white/.58))] opacity-90"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-8 top-0 h-px bg-[linear-gradient(to_right,transparent,theme(colors.white/.8),transparent)]"
      />
      <div className="relative overflow-hidden rounded-[11px] border border-white/10 bg-oai-gray-950">
        <img
          src="/dashboard-dark.png"
          alt={copy("landing.screenshot.alt")}
          className="block h-auto w-full object-cover object-top"
          loading="eager"
          decoding="async"
        />
        <div
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_bottom,theme(colors.white/.06),transparent_20%,transparent_74%,theme(colors.oai.gray.950/.30))]"
          aria-hidden
        />
      </div>
    </motion.div>
  );
}

function ToolStrip({ copy }) {
  const reduceMotion = useReducedMotion();
  const tools = [
    { provider: "claude", label: copy("landing.v3.tool.1") },
    { provider: "codex", label: copy("landing.v3.tool.2") },
    { provider: "cursor", label: copy("landing.v3.tool.3") },
    { provider: "gemini", label: copy("landing.v3.tool.4") },
    { provider: "opencode", label: copy("landing.v3.tool.5") },
    { provider: "openclaw", label: copy("landing.v3.tool.6") },
    { provider: "kiro", label: copy("landing.v3.tool.7") },
    { provider: "copilot", label: copy("landing.v3.tool.8") },
  ];

  return (
    <motion.div
      initial={reduceMotion ? false : "hidden"}
      whileInView="show"
      viewport={{ once: true, margin: "-80px" }}
      variants={chipStagger}
      className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:justify-center sm:gap-3 sm:overflow-visible sm:px-0"
    >
      {tools.map((tool) => (
        <motion.div
          key={tool.provider}
          variants={fadeUpSm}
          className="flex h-10 shrink-0 items-center gap-2 rounded-md border border-white/10 bg-white/[0.02] px-3 text-sm text-oai-gray-300 transition-colors hover:border-white/20 hover:bg-white/[0.06]"
        >
          <ProviderIcon
            provider={tool.provider}
            size={18}
            className="shrink-0 text-oai-gray-300 opacity-80 grayscale saturate-0"
          />
          <span>{tool.label}</span>
        </motion.div>
      ))}
    </motion.div>
  );
}

function FeatureGrid({ copy }) {
  const features = [
    {
      Icon: ShieldCheck,
      title: copy("landing.v3.feature.1.title"),
      body: copy("landing.v3.feature.1.body"),
    },
    {
      Icon: Terminal,
      title: copy("landing.v3.feature.2.title"),
      body: copy("landing.v3.feature.2.body"),
    },
    {
      Icon: MonitorDot,
      title: copy("landing.v3.feature.3.title"),
      body: copy("landing.v3.feature.3.body"),
    },
    {
      Icon: BarChart3,
      title: copy("landing.v3.feature.4.title"),
      body: copy("landing.v3.feature.4.body"),
    },
  ];

  return (
    <section id="product" className="relative border-t border-white/10 bg-oai-gray-950 py-24 sm:py-32">
      <div
        className="absolute inset-0 bg-[linear-gradient(to_right,theme(colors.white/.28)_1px,transparent_1px),linear-gradient(to_bottom,theme(colors.white/.28)_1px,transparent_1px)] bg-[length:64px_64px] opacity-[0.045]"
        aria-hidden
      />
      <div className="relative mx-auto max-w-6xl px-4 sm:px-6">
        <SectionIntro
          kicker={copy("landing.v3.features.kicker")}
          title={copy("landing.v3.features.title")}
        />

        {/* gap-px over a tinted container draws the grid lines once, so internal
            cell borders can't double up on the container edge. */}
        <div className="mt-12 grid gap-px overflow-hidden rounded-lg border border-white/10 bg-white/10 sm:grid-cols-2 lg:grid-cols-4">
          {features.map((feature, index) => (
            <AnimatedBlock
              key={feature.title}
              delay={index * 0.04}
              className="group bg-oai-gray-950 p-5 transition-colors hover:bg-oai-gray-900 lg:min-h-[260px]"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-md border border-white/10 bg-white/[0.02] transition-colors group-hover:border-white/20 group-hover:bg-white/[0.06]">
                <feature.Icon className="h-5 w-5 text-oai-gray-200" aria-hidden />
              </div>
              <h3 className="mt-8 text-base font-semibold text-white">{feature.title}</h3>
              <p className="mt-3 text-sm leading-6 text-oai-gray-400">{feature.body}</p>
            </AnimatedBlock>
          ))}
        </div>
      </div>
    </section>
  );
}

function WorkflowSection({ copy }) {
  const steps = [
    {
      Icon: GitBranch,
      step: copy("landing.v3.workflow.1.step"),
      title: copy("landing.v3.workflow.1.title"),
      body: copy("landing.v3.workflow.1.body"),
      tag: copy("landing.v3.workflow.1.tag"),
    },
    {
      Icon: Gauge,
      step: copy("landing.v3.workflow.2.step"),
      title: copy("landing.v3.workflow.2.title"),
      body: copy("landing.v3.workflow.2.body"),
      tag: copy("landing.v3.workflow.2.tag"),
    },
    {
      Icon: LockKeyhole,
      step: copy("landing.v3.workflow.3.step"),
      title: copy("landing.v3.workflow.3.title"),
      body: copy("landing.v3.workflow.3.body"),
      tag: copy("landing.v3.workflow.3.tag"),
    },
  ];

  return (
    <section id="workflow" className="border-t border-white/10 bg-oai-gray-900 py-24 sm:py-32">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="grid gap-10 lg:grid-cols-[0.72fr_1.28fr] lg:items-start">
          <SectionIntro
            kicker={copy("landing.v3.workflow.kicker")}
            title={copy("landing.v3.workflow.title")}
            body={copy("landing.v3.workflow.body")}
            className="lg:sticky lg:top-24"
          />

          <div className="grid gap-3">
            {steps.map((item, index) => (
              <AnimatedBlock
                key={item.title}
                delay={index * 0.06}
                className="grid gap-4 rounded-lg border border-white/10 bg-oai-gray-950/70 p-5 shadow-lg shadow-black/15 transition-[colors,transform] duration-200 hover:-translate-y-0.5 hover:border-white/20 sm:grid-cols-[2.75rem_minmax(0,1fr)_auto] sm:items-start"
              >
                <div className="flex h-11 w-11 items-center justify-center rounded-md border border-white/10 bg-white/[0.04]">
                  <item.Icon className="h-5 w-5 text-white" aria-hidden />
                </div>
                <div className="min-w-0">
                  <p className="font-mono text-xs font-medium uppercase tracking-[0.08em] text-oai-gray-500">
                    {item.step}
                  </p>
                  <h3 className="mt-1 text-base font-semibold text-white">{item.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-oai-gray-400">{item.body}</p>
                </div>
                <span className="hidden rounded-md border border-white/10 px-2 py-1 font-mono text-xs text-oai-gray-500 sm:block">
                  {item.tag}
                </span>
              </AnimatedBlock>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function IntelligenceSection({ copy }) {
  const reduceMotion = useReducedMotion();
  const rows = [
    {
      title: copy("landing.v3.intelligence.row1.title"),
      body: copy("landing.v3.intelligence.row1.body"),
      state: copy("landing.v3.intelligence.row1.state"),
    },
    {
      title: copy("landing.v3.intelligence.row2.title"),
      body: copy("landing.v3.intelligence.row2.body"),
      state: copy("landing.v3.intelligence.row2.state"),
    },
    {
      title: copy("landing.v3.intelligence.row3.title"),
      body: copy("landing.v3.intelligence.row3.body"),
      state: copy("landing.v3.intelligence.row3.state"),
    },
    {
      title: copy("landing.v3.intelligence.row4.title"),
      body: copy("landing.v3.intelligence.row4.body"),
      state: copy("landing.v3.intelligence.row4.state"),
    },
  ];

  return (
    <section id="privacy" className="border-t border-white/10 bg-oai-gray-950 py-24 sm:py-32">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="grid gap-10 lg:grid-cols-[1fr_1fr] lg:items-start">
          <SectionIntro
            kicker={copy("landing.v3.intelligence.kicker")}
            title={copy("landing.v3.intelligence.title")}
            body={copy("landing.v3.intelligence.body")}
          />

          <AnimatedBlock className="overflow-hidden rounded-lg border border-white/10 bg-oai-gray-900/80 shadow-2xl shadow-black/25">
            <div className="grid grid-cols-[minmax(0,1fr)_8rem] border-b border-white/10 px-4 py-3 text-xs font-medium uppercase tracking-[0.06em] text-oai-gray-500">
              <span>{copy("landing.v3.intelligence.table.metric")}</span>
              <span className="text-right">{copy("landing.v3.intelligence.table.state")}</span>
            </div>
            <motion.div
              className="divide-y divide-white/10"
              initial={reduceMotion ? false : "hidden"}
              whileInView="show"
              viewport={{ once: true, margin: "-80px" }}
              variants={rowStagger}
            >
              {rows.map((row) => (
                <motion.div
                  key={row.title}
                  variants={fadeUpSm}
                  className="grid grid-cols-[minmax(0,1fr)_8rem] items-center gap-4 px-4 py-4"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-white">{row.title}</p>
                    <p className="mt-1 truncate text-xs text-oai-gray-500">{row.body}</p>
                  </div>
                  <span className="justify-self-end rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 font-mono text-xs text-oai-gray-300">
                    {row.state}
                  </span>
                </motion.div>
              ))}
            </motion.div>
          </AnimatedBlock>
        </div>
      </div>
    </section>
  );
}

export function LinearLanding({
  copy,
  signInUrl,
  installCommand,
  installCopied,
  onCopyInstallCommand,
}) {
  const [scrolled, setScrolled] = useState(false);
  const reduceMotion = useReducedMotion();
  const { scrollYProgress } = useScroll();
  const heroPreviewY = useTransform(scrollYProgress, [0, 0.24], reduceMotion ? [0, 0] : [0, -12]);
  const { signedIn, loading: authLoading } = useInsforgeAuth();
  const { openLoginModal } = useLoginModal();
  const os = useMemo(() => detectOS(), []);
  const nativeDownload =
    os === "windows"
      ? { href: WIN_SETUP_URL, label: copy("landing.v3.cta.download_windows") }
      : os === "mac"
        ? { href: MAC_DMG_URL, label: copy("landing.v3.cta.download_macos") }
        : { href: RELEASES_URL, label: copy("landing.v3.cta.download") };

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  let headerAction = null;
  if (authLoading) {
    headerAction = <div className="h-9 w-20" aria-hidden />;
  } else if (signedIn) {
    headerAction = (
      <Link to={getDashboardEntryPath()} className={actionClass("primary", "h-9 px-3")}>
        {copy("landing.cta.primary")}
      </Link>
    );
  } else {
    headerAction = (
      <button type="button" onClick={openLoginModal} className={actionClass("secondary", "h-9 px-3")}>
        {copy("header.auth.sign_in_aria")}
      </button>
    );
  }

  return (
    <div
      className="min-h-screen bg-oai-gray-950 text-white antialiased dark"
      style={{ fontFamily: "'Inter Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}
    >
      <header
        className={cn(
          "sticky top-0 z-50 border-b transition-colors",
          scrolled
            ? "border-white/10 bg-oai-gray-950/90 backdrop-blur"
            : "border-transparent bg-oai-gray-950/55",
        )}
      >
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link
            to="/landing"
            className="flex items-center gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          >
            <img src="/app-icon.png" alt="" className="h-6 w-6 rounded-md grayscale saturate-0" />
            <span className="text-sm font-semibold text-white">{copy("landing.v3.brand")}</span>
          </Link>

          <nav className="hidden items-center gap-2 md:flex">
            <NavLink href="#product">{copy("landing.v3.nav.product")}</NavLink>
            <NavLink href="#workflow">{copy("landing.v3.nav.workflow")}</NavLink>
            <NavLink href="#privacy">{copy("landing.v3.nav.privacy")}</NavLink>
            <Link
              to="/leaderboard"
              className="rounded-md px-2 py-1 text-sm font-medium text-oai-gray-400 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
            >
              {copy("nav.leaderboard")}
            </Link>
          </nav>

          <div className="flex items-center gap-3">
            <span className="hidden h-5 w-px bg-white/10 md:block" aria-hidden />
            <div className="hidden sm:block">
              <HeaderGithubStar />
            </div>
            {headerAction}
          </div>
        </div>
      </header>

      <main>
        <section className="relative overflow-hidden border-b border-white/10">
          <div className="relative mx-auto max-w-6xl px-4 pt-16 sm:px-6 sm:pt-20 lg:pt-24">
            <motion.div
              initial={reduceMotion ? false : "hidden"}
              animate="show"
              variants={heroStagger}
              className="max-w-5xl text-left"
            >
              <motion.p variants={fadeUp} className={EYEBROW}>
                {copy("landing.v3.hero.badge")}
              </motion.p>

              <motion.h1
                variants={fadeUp}
                className="mt-8 max-w-4xl text-4xl font-semibold leading-[1.06] -tracking-[0.022em] text-white sm:text-5xl lg:text-6xl"
              >
                {copy("landing.v3.hero.title")}
              </motion.h1>
              <motion.p
                variants={fadeUp}
                className="mt-6 max-w-2xl text-lg leading-8 text-oai-gray-300 sm:text-xl"
              >
                {copy("landing.v3.hero.subtitle")}
              </motion.p>

              <motion.div variants={fadeUp} className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
                <Link to={getDashboardEntryPath()} className={actionClass("primary", "w-full sm:w-auto")}>
                  {copy("landing.v3.cta.dashboard")}
                  <ArrowRight className="h-4 w-4 transition-transform duration-200 ease-out group-hover:translate-x-0.5" aria-hidden />
                </Link>
                <a
                  href={nativeDownload.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={actionClass("secondary", "w-full sm:w-auto")}
                >
                  <Download className="h-4 w-4" aria-hidden />
                  {nativeDownload.label}
                </a>
                <a
                  href={REPO_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={actionClass("ghost", "w-full px-3 sm:w-auto")}
                >
                  {copy("landing.cta.secondary")}
                </a>
              </motion.div>

              <motion.div
                variants={fadeUp}
                className="mt-5 flex max-w-xl items-center gap-2 rounded-md border border-white/10 bg-oai-gray-950/85 py-1.5 pl-3 pr-1.5 text-left shadow-xl shadow-black/30"
              >
                <Terminal className="h-4 w-4 shrink-0 text-oai-gray-500" aria-hidden />
                <code
                  tabIndex={0}
                  className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-sm font-mono text-sm text-oai-gray-200 [scrollbar-width:none] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/40"
                >
                  {installCommand}
                </code>
                <button
                  type="button"
                  onClick={onCopyInstallCommand}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-white text-oai-gray-950 transition-colors hover:bg-oai-gray-100 active:bg-oai-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                  aria-label={
                    installCopied ? copy("landing.install.action.copied") : copy("landing.install.action.copy")
                  }
                >
                  {installCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </button>
              </motion.div>
            </motion.div>

          </div>

          {/* Product showcase: wider than the copy column (max-w-7xl) and wrapped
              in a large soft halo BOUND to the panel, so the full dashboard
              floats in an even glow wherever you scroll — never cropped. */}
          <motion.div
            className="relative mx-auto mt-12 max-w-7xl px-4 pb-44 sm:mt-16 sm:px-6 sm:pb-60"
            style={{ y: heroPreviewY }}
          >
            {/* Linear Frame_background, faithfully: NOT a flat bright slab — a
                SOFT, defocused grey halo pooled at the panel's base-center
                (Linear reads as a calm mid-grey glow, not pure white), but LARGE:
                a full-width, tall low ellipse centered below the panel so the
                panel rests on a big lit surface and casts its shadow into it.
                Feathers out to black on every side; bound to the panel.
                TUNING: 1st % = width, 2nd % = height, `at 50% N%` = vertical
                center, white/.34 = brightness, transparent N% = spread. */}
            <div
              className="pointer-events-none absolute left-1/2 top-0 bottom-0 w-screen -translate-x-1/2 bg-[radial-gradient(30%_36%_at_50%_86%,transparent_35%,theme(colors.oai.gray.950)_88%),linear-gradient(to_bottom,transparent_6%,theme(colors.white/.12)_30%,theme(colors.white/.58)_68%,theme(colors.white/.58)_80%,transparent_96%)]"
              aria-hidden
            />
            <ProductPreview copy={copy} />
          </motion.div>
        </section>

        <section className="border-b border-white/10 bg-oai-gray-950 py-10">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <p className={cn(EYEBROW, "mb-5 text-center")}>
              {copy("landing.v3.tools.kicker")}
            </p>
            <ToolStrip copy={copy} />
          </div>
        </section>

        <FeatureGrid copy={copy} />
        <WorkflowSection copy={copy} />
        <IntelligenceSection copy={copy} />

        <section className="border-t border-white/10 bg-oai-gray-950 py-24 sm:py-32">
          <div className="mx-auto max-w-6xl px-4 text-center sm:px-6">
            <h2 className="text-3xl font-semibold -tracking-[0.02em] text-white sm:text-4xl">
              {copy("landing.v3.final.title")}
            </h2>
            <p className="mx-auto mt-5 max-w-xl text-base leading-7 text-oai-gray-400">
              {copy("landing.v3.final.body")}
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link to={getDashboardEntryPath()} className={actionClass("primary", "w-full sm:w-auto")}>
                {copy("landing.v3.cta.dashboard")}
              </Link>
              <a
                href={STATUSPAGE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={actionClass("secondary", "w-full sm:w-auto")}
              >
                {copy("landing.v3.nav.status")}
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/10 bg-oai-gray-950 py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 text-sm text-oai-gray-500 sm:flex-row sm:px-6">
          <p>{copy("landing.v3.footer.line")}</p>
          <div className="flex items-center gap-5">
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-sm hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
            >
              {copy("landing.cta.secondary")}
            </a>
            <Link
              to="/landing-legacy"
              className="rounded-sm hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
            >
              {copy("landing.v3.footer.legacy")}
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
