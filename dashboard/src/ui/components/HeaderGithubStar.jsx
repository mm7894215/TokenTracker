import React, { useEffect, useState } from "react";
import { shouldFetchGithubStars } from "../dashboard/util/should-fetch-github-stars.js";

/**
 * Dashboard / marketing header: single row — icon + Star + count (matches Shell header).
 */
export function HeaderGithubStar({ repo = "mm7894215/TokenTracker" }) {
  const [stars, setStars] = useState(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const prefersReducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const screenshotCapture =
      typeof document !== "undefined" &&
      (document.documentElement?.classList.contains("screenshot-capture") ||
        document.body?.classList.contains("screenshot-capture"));
    if (!shouldFetchGithubStars({ prefersReducedMotion, screenshotCapture })) return;
    fetch(`https://api.github.com/repos/${repo}`)
      .then((res) => res.json())
      .then((data) => {
        if (data && typeof data.stargazers_count === "number") {
          setStars(data.stargazers_count);
        }
      })
      .catch(() => {});
  }, [repo]);

  return (
    <a
      href={`https://github.com/${repo}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex shrink-0 items-center gap-2 px-3 py-1.5 rounded-md border border-oai-gray-200 dark:border-oai-gray-700 bg-oai-gray-50 dark:bg-oai-gray-800 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-700 transition-colors no-underline"
    >
      <svg height="16" viewBox="0 0 16 16" width="16" className="shrink-0 fill-oai-gray-700 dark:fill-oai-gray-300">
        <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
      </svg>
      <span className="text-xs font-medium text-oai-gray-700 dark:text-oai-gray-300 whitespace-nowrap">Star</span>
      {stars !== null && (
        <span className="text-xs font-semibold text-oai-gray-900 dark:text-oai-white tabular-nums whitespace-nowrap">
          {stars}
        </span>
      )}
    </a>
  );
}
