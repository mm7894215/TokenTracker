import React, { useLayoutEffect, useRef } from "react";
import { SpotlightCard } from "../components/SpotlightCard.jsx";
import { gsap } from "./gsap.js";

const CARD_KEYS = ["limits", "heatmap", "devices"];

function LimitsGlyph() {
  return (
    <svg viewBox="0 0 48 24" className="h-6 w-12" fill="none" aria-hidden="true">
      <path d="M2 22 A 22 22 0 0 1 46 22" stroke="var(--lv3-line)" strokeWidth="3" strokeLinecap="round" />
      <path d="M2 22 A 22 22 0 0 1 32 4.5" stroke="var(--lv3-accent)" strokeWidth="3" strokeLinecap="round" />
      <circle cx="32" cy="4.5" r="2.6" fill="var(--lv3-accent-soft)" />
    </svg>
  );
}

function HeatmapGlyph() {
  const cells = [0.15, 0.5, 0.9, 0.3, 0.7, 0.2, 1, 0.45, 0.6, 0.25, 0.8, 0.35];
  return (
    <div className="grid w-12 grid-cols-6 gap-[3px]" aria-hidden="true">
      {cells.map((v, i) => (
        <span
          key={i}
          className="h-[7px] w-[7px] rounded-[2px]"
          style={{ background: "var(--lv3-accent)", opacity: 0.15 + v * 0.85 }}
        />
      ))}
    </div>
  );
}

function DevicesGlyph() {
  return (
    <svg viewBox="0 0 48 24" className="h-6 w-12" fill="none" stroke="var(--lv3-accent-soft)" strokeWidth="2" aria-hidden="true">
      <rect x="2" y="3" width="24" height="15" rx="2" />
      <path d="M10 21h8" strokeLinecap="round" />
      <rect x="33" y="6" width="12" height="16" rx="2.5" stroke="var(--lv3-accent)" />
    </svg>
  );
}

const GLYPHS = { limits: LimitsGlyph, heatmap: HeatmapGlyph, devices: DevicesGlyph };

/**
 * Capability cards with a large, perspective-tilted product screenshot that
 * settles flat as it scrolls into view (Linear-style). `screenshotSrc` /
 * `screenshotAlt` are passed in from MarketingLanding so the literals the
 * repo tests grep for stay in that file.
 */
export function CapabilitiesSection({ copy, animate, screenshotSrc, screenshotAlt }) {
  const sectionRef = useRef(null);
  const frameRef = useRef(null);

  useLayoutEffect(() => {
    if (!animate) return undefined;
    const ctx = gsap.context(() => {
      gsap.fromTo(
        ".lv3-cap-header",
        { y: 160, autoAlpha: 0 },
        {
          y: 0,
          autoAlpha: 1,
          ease: "power1.out",
          scrollTrigger: {
            trigger: sectionRef.current,
            start: "top bottom",
            end: "top 25%",
            scrub: 0.5,
          },
        },
      );
      gsap.fromTo(
        ".lv3-cap-card",
        { autoAlpha: 0, y: 110 },
        {
          autoAlpha: 1,
          y: 0,
          ease: "power1.out",
          stagger: 0.1,
          scrollTrigger: {
            trigger: sectionRef.current,
            start: "top 85%",
            end: "top 15%",
            scrub: 0.5,
          },
        },
      );
      gsap.fromTo(
        frameRef.current,
        { rotateX: 16, y: 90, autoAlpha: 0.35 },
        {
          rotateX: 0,
          y: 0,
          autoAlpha: 1,
          ease: "none",
          scrollTrigger: {
            trigger: frameRef.current,
            start: "top 95%",
            end: "top 40%",
            scrub: 0.5,
          },
        },
      );
    }, sectionRef);
    return () => ctx.revert();
  }, [animate]);

  return (
    <section ref={sectionRef} className="relative bg-transparent py-20 sm:py-28 lg:py-36">
      {/* Background glow at the top boundary to bleed light from the galaxy */}
      <div
        className="pointer-events-none absolute -top-40 left-1/2 h-80 w-[60rem] -translate-x-1/2 rounded-[50%] opacity-20"
        style={{
          background: "radial-gradient(ellipse at center, var(--lv3-accent), transparent 65%)",
          filter: "blur(120px)",
        }}
        aria-hidden="true"
      />
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="max-w-2xl lv3-cap-header">
          <p className="text-xs font-bold uppercase tracking-widest text-[color:var(--lv3-accent-soft)]">
            {copy("landing.v3.cap.kicker")}
          </p>
          <h2 className="mt-4 text-balance text-3xl font-semibold leading-tight tracking-tight text-white sm:text-4xl">
            {copy("landing.v3.cap.title")}
          </h2>
          <p className="mt-4 text-base leading-relaxed text-oai-gray-400">{copy("landing.v3.cap.subtitle")}</p>
        </div>

        <div className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-3">
          {CARD_KEYS.map((key) => {
            const Glyph = GLYPHS[key];
            return (
              <SpotlightCard key={key} className="lv3-cap-card p-6">
                <Glyph />
                <h3 className="mt-5 text-sm font-semibold text-white">
                  {copy(`landing.v3.cap.${key}.title`)}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-oai-gray-400">
                  {copy(`landing.v3.cap.${key}.body`)}
                </p>
              </SpotlightCard>
            );
          })}
        </div>

        <div className="mt-16 sm:mt-20" style={{ perspective: "1400px" }}>
          <div
            ref={frameRef}
            className="relative rounded-xl p-[1px] shadow-2xl"
            style={{
              transformStyle: "preserve-3d",
              background:
                "linear-gradient(to bottom, var(--lv3-line), var(--lv3-accent-ghost) 40%, transparent)",
              boxShadow: "0 24px 90px -20px var(--lv3-accent-faint), 0 4px 20px rgba(0,0,0,0.4)",
            }}
          >
            <div className="relative overflow-hidden rounded-[11px] bg-oai-gray-950">
              <div
                className="pointer-events-none absolute inset-x-0 top-0 z-20 h-40"
                style={{
                  background:
                    "linear-gradient(to bottom, var(--lv3-accent-faint) 0%, transparent 100%)",
                  mixBlendMode: "screen",
                }}
              />
              <img
                src={screenshotSrc}
                alt={screenshotAlt}
                className="relative z-10 block h-auto w-full object-cover"
                loading="lazy"
                decoding="async"
                width={2496}
                height={1730}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
