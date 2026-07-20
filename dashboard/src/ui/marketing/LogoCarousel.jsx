import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ProviderIcon } from "../dashboard/components/ProviderIcon.jsx";

// Animated logo wall, adapted from cult-ui's LogoCarousel
// (https://www.cult-ui.com/docs/components/logo-carousel). Logos are split
// across N columns; each column cycles through its share of logos with a
// staggered vertical flip. Icons render through the shared ProviderIcon so
// both brand-colour SVGs and mono (currentColor) marks stay consistent.

// Fisher-Yates shuffle (returns a new array, never mutates the input).
function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// Distribute logos evenly across columns, padding shorter columns so every
// column cycles through the same number of frames.
function distributeLogos(allLogos, columnCount) {
  const shuffled = shuffleArray(allLogos);
  const columns = Array.from({ length: columnCount }, () => []);

  shuffled.forEach((logo, index) => {
    columns[index % columnCount].push(logo);
  });

  const maxLength = Math.max(...columns.map((col) => col.length));
  columns.forEach((col) => {
    while (col.length < maxLength) {
      col.push(shuffled[Math.floor(Math.random() * shuffled.length)]);
    }
  });

  return columns;
}

const LogoColumn = React.memo(function LogoColumn({ logos, index, currentTime, onHoverChange }) {
  const [hovered, setHovered] = useState(false);
  const cycleInterval = 4000; // ms each logo stays visible
  const columnDelay = index * 400; // stagger columns so they flip out of sync
  const adjustedTime = (currentTime + columnDelay) % (cycleInterval * logos.length);
  const currentIndex = Math.floor(adjustedTime / cycleInterval);
  const logo = logos[currentIndex];

  const setHover = (value) => {
    setHovered(value);
    onHoverChange(value);
  };

  return (
    // Outer wrapper carries hover (pause + name) and is NOT clipped, so the
    // name label can sit below the box. The inner box keeps overflow-hidden
    // to clip the vertical flip animation.
    <div
      className="relative flex flex-col items-center"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <motion.div
        className="relative h-8 w-8 sm:h-10 sm:w-10 md:h-12 md:w-12 overflow-hidden"
        initial={{ opacity: 0, y: 50 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: index * 0.1, duration: 0.5, ease: "easeOut" }}
      >
        <AnimatePresence mode="wait">
          <motion.div
            key={`${logo.id}-${currentIndex}`}
            className="absolute inset-0 flex items-center justify-center"
            initial={{ y: "18%", opacity: 0, filter: "blur(4px)" }}
            animate={{
              y: "0%",
              opacity: 1,
              filter: "blur(0px)",
              transition: {
                type: "tween",
                ease: [0.22, 1, 0.36, 1],
                duration: 0.9,
              },
            }}
            exit={{
              y: "-18%",
              opacity: 0,
              filter: "blur(4px)",
              transition: { type: "tween", ease: [0.4, 0, 1, 1], duration: 0.55 },
            }}
          >
            <ProviderIcon provider={logo.provider} size={24} className="object-contain" />
          </motion.div>
        </AnimatePresence>
      </motion.div>

      <AnimatePresence>
        {hovered && (
          <motion.span
            className="pointer-events-none absolute -bottom-7 z-10 whitespace-nowrap rounded bg-oai-gray-800 px-2 py-0.5 text-xs font-medium text-oai-gray-100 shadow-lg ring-1 ring-oai-gray-700"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
          >
            {logo.name}
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
});

export function LogoCarousel({ logos, columnCount = 2 }) {
  const [logoSets, setLogoSets] = useState([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    setLogoSets(distributeLogos(logos, columnCount));
  }, [logos, columnCount]);

  // Advance the clock that drives logo cycling. Hovering any column pauses it,
  // freezing every column on its current logo (whose name is then revealed).
  // 400ms granularity = gcd(4000ms cycle, 400ms column stagger): every column
  // flip lands exactly on a tick, so the staggered rhythm is preserved while
  // the subtree re-renders 2.5x/s instead of 10x/s. (500ms would quantize the
  // stagger — adjacent columns would flip on the same tick.)
  useEffect(() => {
    if (paused) return undefined;
    const intervalId = setInterval(() => setCurrentTime((prev) => prev + 400), 400);
    return () => clearInterval(intervalId);
  }, [paused]);

  const handleHoverChange = useCallback((isHovering) => {
    setPaused(isHovering);
  }, []);

  return (
    <div className="flex gap-2.5 sm:gap-4 text-oai-gray-200">
      {logoSets.map((columnLogos, index) => (
        <LogoColumn
          key={index}
          logos={columnLogos}
          index={index}
          currentTime={currentTime}
          onHoverChange={handleHoverChange}
        />
      ))}
    </div>
  );
}

export default LogoCarousel;
