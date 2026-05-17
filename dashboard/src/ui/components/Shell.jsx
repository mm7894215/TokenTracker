import React from "react";
import { Link } from "react-router-dom";

/**
 * Brand Logo component (kept for screenshot mode / standalone Shell usage)
 */
function BrandLogo() {
  return (
    <Link to="/landing" className="flex items-center gap-2.5 no-underline hover:opacity-80 transition-opacity">
      <img
        src="/app-icon.png"
        alt="Token Tracker"
        width={28}
        height={28}
        className="rounded-md"
      />
      <span className="text-base font-semibold text-oai-black dark:text-oai-white leading-tight">
        Token Tracker
      </span>
    </Link>
  );
}

/**
 * Shell - OpenAI 风格的外壳布局组件
 *
 * Modes:
 *   - default: full-screen wrapper with optional header/footer (used by standalone web pages and screenshot mode)
 *   - bare: no outer wrapper / header / background — content sits directly in parent (used inside AppLayout sidebar mode)
 */
export function Shell({
  children,
  header,
  footer,
  className = "",
  hideHeader = false,
  hideFooter = false,
  bare = false,
}) {
  if (bare) {
    return (
      <div className={`flex flex-col flex-1 min-h-0 ${className}`}>
        <main className="flex-1 px-6 py-6">{children}</main>
        {!hideFooter && footer && (
          <footer className="border-t border-oai-gray-200 dark:border-oai-gray-800 px-6 py-4 mt-auto transition-colors duration-200">
            {footer}
          </footer>
        )}
      </div>
    );
  }

  return (
    <div
      className={`min-h-screen bg-oai-white dark:bg-oai-gray-950 text-oai-black dark:text-oai-white font-sans flex flex-col transition-colors duration-200 ${className}`}
    >
      {!hideHeader && (
        <header className="border-b border-oai-gray-200 dark:border-oai-gray-800 px-6 py-4 flex items-center justify-between transition-colors duration-200">
          <BrandLogo />
          <div className="flex-1 flex justify-center">{header}</div>
        </header>
      )}

      <main className="flex-1 px-6 py-6">{children}</main>

      {!hideFooter && footer && (
        <footer className="border-t border-oai-gray-200 dark:border-oai-gray-800 px-6 py-4 mt-auto transition-colors duration-200">
          {footer}
        </footer>
      )}
    </div>
  );
}
