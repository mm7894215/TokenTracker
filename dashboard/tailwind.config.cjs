/** @type {import("tailwindcss").Config} */
const defaultTheme = require("tailwindcss/defaultTheme");

module.exports = {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      screens: {
        // Viewport-height gates for vertically-anchored layouts (marketing
        // hero): default styles fit short laptop screens (13" MacBook Air
        // ≈ 800px-high viewport); scale the vertical rhythm up only when
        // there's room.
        tall: { raw: "(min-height: 900px)" },
        xtall: { raw: "(min-height: 1000px)" },
      },
      fontFamily: {
        oai: [
          "'OpenAI Sans'",
          "-apple-system",
          "BlinkMacSystemFont",
          "'Segoe UI'",
          "Roboto",
          "Oxygen",
          "Ubuntu",
          "sans-serif",
        ],
        mono: [
          "'SF Mono'",
          "SFMono-Regular",
          "ui-monospace",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
      fontSize: {
        // Display sizes - for hero metrics
        display: [
          "72px",
          {
            lineHeight: "1",
            fontWeight: "700",
            letterSpacing: "-0.03em",
          },
        ],
        "display-sm": [
          "56px",
          {
            lineHeight: "1.05",
            fontWeight: "700",
            letterSpacing: "-0.02em",
          },
        ],
        hero: [
          "48px",
          {
            lineHeight: "1.1",
            fontWeight: "600",
            letterSpacing: "-0.02em",
          },
        ],
        h1: [
          "36px",
          {
            lineHeight: "1.2",
            fontWeight: "600",
            letterSpacing: "-0.02em",
          },
        ],
        h2: [
          "28px",
          {
            lineHeight: "1.25",
            fontWeight: "600",
            letterSpacing: "-0.01em",
          },
        ],
        h3: [
          "22px",
          {
            lineHeight: "1.3",
            fontWeight: "600",
            letterSpacing: "-0.01em",
          },
        ],
        h4: [
          "18px",
          {
            lineHeight: "1.4",
            fontWeight: "600",
          },
        ],
        body: [
          "16px",
          {
            lineHeight: "1.5",
            fontWeight: "400",
          },
        ],
        "body-sm": [
          "14px",
          {
            lineHeight: "1.5",
            fontWeight: "400",
          },
        ],
        caption: [
          "12px",
          {
            lineHeight: "1.4",
            fontWeight: "500",
            letterSpacing: "0.01em",
          },
        ],
        label: [
          "11px",
          {
            lineHeight: "1.3",
            fontWeight: "600",
            letterSpacing: "0.02em",
          },
        ],
      },
      colors: {
        oai: {
          black: "#0a0a0a",
          white: "#fafafa",
          gray: {
            50: "#fafafa",
            100: "#f5f5f5",
            200: "#e5e5e5",
            300: "#d4d4d4",
            400: "#a3a3a3",
            500: "#737373",
            600: "#525252",
            700: "#404040",
            800: "#262626",
            900: "#171717",
            950: "#0a0a0a",
          },
          // Brand Color - Muted Forest Green (适合白色背景)
          brand: {
            DEFAULT: "#059669",
            dark: "#047857",
            light: "#10b981",
            50: "#ecfdf5",
            100: "#d1fae5",
            200: "#a7f3d0",
            300: "#6ee7b7",
            400: "#34d399",
            500: "#10b981",
            600: "#059669",
            700: "#047857",
            800: "#065f46",
            900: "#064e3b",
            950: "#022c22",
          },
          // Supporting accent - Emerald (30%)
          forest: {
            DEFAULT: "#10b981",
            dark: "#059669",
            light: "#34d399",
            50: "#ecfdf5",
          },
          // Secondary accents (10%)
          amber: {
            DEFAULT: "#f59e0b",
            dark: "#d97706",
            light: "#fbbf24",
            50: "#fffbeb",
          },
          // Semantic colors
          success: "#10b981",
          warning: "#f59e0b",
          error: "#ef4444",
          info: "#059669",
          // Legacy blue - mapped to brand green for consistency
          blue: {
            DEFAULT: "#059669",
            dark: "#047857",
            light: "#10b981",
            50: "#ecfdf5",
          },
        },
      },
      animation: {
        "fade-in": "fadeIn 0.5s ease-out",
        "slide-up": "slideUp 0.5s ease-out",
        "pulse-slow": "pulse 3s ease-in-out infinite",
        "star-movement-bottom": "star-movement-bottom linear infinite alternate",
        "star-movement-top": "star-movement-top linear infinite alternate",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(10px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "star-movement-bottom": {
          "0%": { transform: "translate(0%, 0%)", opacity: "1" },
          "100%": { transform: "translate(-100%, 0%)", opacity: "0" },
        },
        "star-movement-top": {
          "0%": { transform: "translate(0%, 0%)", opacity: "1" },
          "100%": { transform: "translate(100%, 0%)", opacity: "0" },
        },
      },
      boxShadow: {
        "oai-sm": "0 1px 2px 0 rgba(0, 0, 0, 0.05)",
        "oai": "0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px -1px rgba(0, 0, 0, 0.1)",
        "oai-md": "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1)",
        "oai-lg": "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1)",
      },
      borderRadius: {
        sm: "4px",
        md: "8px",
        lg: "12px",
        xl: "16px",
      },
      spacing: {
        0: "0",
        1: "4px",
        2: "8px",
        3: "12px",
        4: "16px",
        5: "20px",
        6: "24px",
        8: "32px",
        10: "40px",
        12: "48px",
        16: "64px",
        20: "80px",
      },
    },
  },
  plugins: [],
};
