import React, { useLayoutEffect, useRef } from "react";
import { gsap } from "./gsap.js";

const STEP_KEYS = ["step1", "step2", "step3", "step4"];
const BAR_HEIGHTS = [34, 58, 42, 88, 66, 100, 74];

function PanelFrame({ title, children, accent = false }) {
  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-oai-gray-800 bg-[color:var(--lv3-panel)] shadow-2xl shadow-black/40"
      style={accent ? { borderColor: "var(--lv3-line)", boxShadow: "0 24px 80px -32px var(--lv3-accent-faint)" } : undefined}
    >
      <div className="flex items-center gap-2 border-b border-oai-gray-800/80 px-4 py-2.5">
        <span className="flex gap-1.5" aria-hidden="true">
          <span className="h-2 w-2 rounded-full bg-oai-gray-700" />
          <span className="h-2 w-2 rounded-full bg-oai-gray-700" />
          <span className="h-2 w-2 rounded-full bg-oai-gray-700" />
        </span>
        <span className="ml-1 font-mono text-[10px] uppercase tracking-widest text-oai-gray-500">{title}</span>
      </div>
      <div className="flex flex-1 flex-col justify-center px-5 py-5 font-mono text-xs leading-loose sm:px-6">
        {children}
      </div>
    </div>
  );
}

// The four mini-scenes: CLI run → hook capture → local queue → dashboard.
// Terminal/JSON fragments are decorative pseudo-code, styled like the CLIs
// they depict (baselined by validate:ui-hardcode, same as the v2 console).
function HowScene({ index, copy }) {
  if (index === 0) {
    return (
      <PanelFrame title={copy("landing.v3.how.scene.terminal_title")}>
        <p className="text-oai-gray-200">
          <span className="text-[color:var(--lv3-accent-soft)]">$</span> claude{" "}
          <span className="text-oai-gray-500">
            {copy("landing.v3.how.scene.prompt")}
          </span>
        </p>
        <p className="mt-2 text-oai-gray-500">⏺ {copy("landing.v3.how.scene.thinking")}</p>
        <p className="text-oai-gray-500">
          ⏺ {copy("landing.v3.how.scene.editing", { path: "src/lib/rollout.js" })}
        </p>
        <p className="mt-2 text-oai-gray-300">
          ✓ {copy("landing.v3.how.scene.files_changed", { count: 3 })}
        </p>
      </PanelFrame>
    );
  }
  if (index === 1) {
    return (
      <PanelFrame title={copy("landing.v3.how.scene.session_title")}>
        <p className="text-oai-gray-500">{'"usage": {'}</p>
        <p className="pl-4 text-oai-gray-300">
          {'"input_tokens": '}<span className="text-[color:var(--lv3-accent-soft)]">12,482</span>,
        </p>
        <p className="pl-4 text-oai-gray-300">
          {'"output_tokens": '}<span className="text-[color:var(--lv3-accent-soft)]">3,067</span>,
        </p>
        <p className="pl-4 text-oai-gray-300">
          {'"cache_read": '}<span className="text-[color:var(--lv3-accent-soft)]">88,214</span>
        </p>
        <p className="text-oai-gray-500">{"}"}</p>
      </PanelFrame>
    );
  }
  if (index === 2) {
    return (
      <PanelFrame title="~/.tokentracker/queue.jsonl">
        <p className="truncate text-oai-gray-500">{'{"source":"codex","total_tokens":91406…'}</p>
        <p className="truncate text-oai-gray-500">{'{"source":"cursor","total_tokens":18220…'}</p>
        <p className="truncate text-oai-gray-300">
          {'{"source":"claude","total_tokens":'}
          <span className="text-[color:var(--lv3-accent-soft)]">103,763</span>…
        </p>
        <p className="mt-3 text-[10px] uppercase tracking-widest text-[color:var(--lv3-accent-soft)]">
          ▌ {copy("landing.v3.how.scene.appended")}
        </p>
      </PanelFrame>
    );
  }
  return (
    <PanelFrame title="localhost:7680" accent>
      <div className="flex h-24 items-end gap-2" aria-hidden="true">
        {BAR_HEIGHTS.map((h, i) => (
          <span
            key={i}
            className="lv3-how-bar w-full origin-bottom rounded-sm"
            style={{
              height: `${h}%`,
              background: i === 5 ? "var(--lv3-accent)" : "var(--lv3-accent-faint)",
            }}
          />
        ))}
      </div>
      <p className="mt-4 text-[10px] uppercase tracking-widest text-oai-gray-500">
        {copy("landing.v3.how.scene.total_tokens")}
      </p>
      <p className="text-lg font-bold tabular-nums text-white">6,830,736,916</p>
    </PanelFrame>
  );
}

function StepItem({ copy, stepKey, index }) {
  return (
    <div className="lv3-how-step flex gap-4">
      <span
        className="relative mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-oai-gray-700 bg-oai-gray-950 font-mono text-[10px] font-bold text-oai-gray-300"
        aria-hidden="true"
      >
        {String(index + 1).padStart(2, "0")}
      </span>
      <div>
        <h3 className="text-sm font-semibold text-white">{copy(`landing.v3.how.${stepKey}.title`)}</h3>
        <p className="mt-1 text-sm leading-relaxed text-oai-gray-400">{copy(`landing.v3.how.${stepKey}.body`)}</p>
      </div>
    </div>
  );
}

/**
 * Pinned scroll story: while the section is pinned, the scrubbed timeline
 * walks through the four stages of the data flow, crossfading the right-hand
 * scene and spotlighting the matching step on the left. Below lg (or with
 * animation disabled) it renders as a plain stacked list with inline scenes.
 */
export function HowItWorksSection({ copy, animate }) {
  const sectionRef = useRef(null);

  useLayoutEffect(() => {
    if (!animate) return undefined;
    const ctx = gsap.context(() => {
      const mm = gsap.matchMedia();
      mm.add("(min-width: 1024px)", () => {
        const scenes = gsap.utils.toArray(".lv3-how-scene");
        const steps = gsap.utils.toArray(".lv3-how-desktop .lv3-how-step");
        gsap.set(scenes.slice(1), { autoAlpha: 0, y: 28 });
        gsap.set(steps.slice(1), { opacity: 0.35 });

        const tl = gsap.timeline({
          defaults: { ease: "none" },
          scrollTrigger: {
            trigger: sectionRef.current,
            pin: true,
            scrub: 0.8,
            start: "top top",
            end: "+=240%",
            anticipatePin: 1,
          },
        });
        // Long, overlapping crossfades: each hand-off breathes instead of
        // snapping, and the pin releases right after the last beat.
        for (let i = 1; i < scenes.length; i += 1) {
          tl.to(scenes[i - 1], { autoAlpha: 0, y: -24, duration: 0.62 }, i);
          tl.fromTo(scenes[i], { autoAlpha: 0, y: 24 }, { autoAlpha: 1, y: 0, duration: 0.62 }, i + 0.12);
          tl.to(steps[i - 1], { opacity: 0.35, duration: 0.45 }, i);
          tl.to(steps[i], { opacity: 1, duration: 0.45 }, i + 0.12);
        }
        tl.fromTo(
          ".lv3-how-bar",
          { scaleY: 0.1 },
          { scaleY: 1, duration: 0.5, stagger: 0.05 },
          scenes.length - 1 + 0.35,
        );
        tl.to(".lv3-how-progress", { scaleY: 1, duration: scenes.length }, 0.0);
        tl.to({}, { duration: 0.35 });
      });
    }, sectionRef);
    return () => ctx.revert();
  }, [animate]);

  return (
    <section ref={sectionRef} className="relative overflow-hidden bg-oai-gray-950">
      <div className="mx-auto flex min-h-[100vh] max-w-6xl flex-col justify-center px-4 py-20 sm:px-6 lg:py-0">
        <div className="mb-12 max-w-2xl lg:mb-16">
          <p className="text-xs font-bold uppercase tracking-widest text-[color:var(--lv3-accent-soft)]">
            {copy("landing.v3.how.kicker")}
          </p>
          <h2 className="mt-4 text-balance text-3xl font-semibold leading-tight tracking-tight text-white sm:text-4xl">
            {copy("landing.v3.how.title")}
          </h2>
          <p className="mt-4 text-base leading-relaxed text-oai-gray-400">{copy("landing.v3.how.subtitle")}</p>
        </div>

        {/* Desktop: pinned steps + crossfading stage */}
        <div className="lv3-how-desktop hidden grid-cols-12 items-center gap-12 lg:grid">
          <div className="relative col-span-5 space-y-9 pl-1">
            <span
              className="absolute bottom-3 left-[17px] top-3 w-px origin-top bg-oai-gray-800"
              aria-hidden="true"
            >
              <span
                className="lv3-how-progress block h-full w-full origin-top scale-y-0"
                style={{ background: "linear-gradient(to bottom, var(--lv3-accent), var(--lv3-accent-soft))" }}
              />
            </span>
            {STEP_KEYS.map((stepKey, i) => (
              <StepItem key={stepKey} copy={copy} stepKey={stepKey} index={i} />
            ))}
          </div>
          <div className="relative col-span-7 h-[420px]">
            {STEP_KEYS.map((stepKey, i) => (
              <div key={stepKey} className="lv3-how-scene absolute inset-0">
                <HowScene index={i} copy={copy} />
              </div>
            ))}
          </div>
        </div>

        {/* Mobile / reduced motion: stacked steps with inline scenes */}
        <div className="space-y-10 lg:hidden">
          {STEP_KEYS.map((stepKey, i) => (
            <div key={stepKey} className="space-y-4">
              <StepItem copy={copy} stepKey={stepKey} index={i} />
              <div className="h-64">
                <HowScene index={i} copy={copy} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
