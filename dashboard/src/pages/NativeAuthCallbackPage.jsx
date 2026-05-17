import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useInsforgeAuth } from "../contexts/InsforgeAuthContext.jsx";
import { useLocale } from "../hooks/useLocale.js";
import { copy } from "../lib/copy";

/**
 * Unified OAuth callback page at /auth/callback.
 *
 * Both web and native macOS app flows land here. Since InsForge only allows
 * one redirect URL, we detect native mode via a flag on the local server
 * (set by the WebView before opening the browser).
 *
 * Native flow:
 *   1. Capture insforge_code from URL before SDK strips it
 *   2. Check /api/auth-bridge/verifier for native flag
 *   3. If native: redirect to tokentracker://auth/callback?insforge_code=xxx
 *      App receives code, loads /auth/callback in WebView, SDK exchanges it
 *
 * Web flow:
 *   SDK auto-detects insforge_code and exchanges it → redirect to /dashboard
 */

// Capture code at module load time BEFORE SDK's detectAuthCallback() strips it.
const _initialSearch = typeof window !== "undefined" ? window.location.search : "";
const _initialParams = new URLSearchParams(_initialSearch);
const _capturedCode = _initialParams.get("insforge_code") || _initialParams.get("code") || null;

export function NativeAuthCallbackPage() {
  useLocale();
  const { loading, signedIn } = useInsforgeAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState("processing");
  const [isNative, setIsNative] = useState(null); // null = checking, true/false = determined
  const checkedRef = useRef(false);

  // Step 1: Check with local server if this is a native OAuth flow
  useEffect(() => {
    if (!_capturedCode || checkedRef.current) return;
    checkedRef.current = true;

    (async () => {
      try {
        const resp = await fetch("/api/auth-bridge/verifier");
        const data = await resp.json();
        setIsNative(Boolean(data?.native));
      } catch {
        setIsNative(false); // assume web flow on error
      }
    })();
  }, []);

  // Step 2a: Native flow — relay code to app via URL scheme
  useEffect(() => {
    if (isNative !== true || !_capturedCode) return;

    setStatus("redirecting");
    const timer = setTimeout(() => {
      window.location.href = `tokentracker://auth/callback?insforge_code=${encodeURIComponent(_capturedCode)}`;
    }, 200);
    return () => clearTimeout(timer);
  }, [isNative]);

  // Step 2b: Web flow — SDK auto-exchanges code, wait for signedIn
  useEffect(() => {
    if (isNative !== false) return; // wait until we know it's web flow
    if (loading) return;

    if (signedIn) {
      navigate("/dashboard", { replace: true });
      return;
    }

    const timer = setTimeout(() => {
      if (!signedIn) setStatus("failed");
    }, 5000);
    return () => clearTimeout(timer);
  }, [isNative, loading, signedIn, navigate]);

  // No code at all — show failure
  useEffect(() => {
    if (!_capturedCode && isNative === null) {
      // Wait a moment for SDK to potentially handle it
      const timer = setTimeout(() => setStatus("failed"), 3000);
      return () => clearTimeout(timer);
    }
  }, [isNative]);

  // Show blank while determining flow type or SDK is processing
  if (status === "processing" && isNative !== true) {
    if (isNative === null || (isNative === false && loading)) {
      return <div className="min-h-screen bg-oai-gray-950" />;
    }
  }

  return (
    <div className="min-h-screen bg-oai-gray-950 text-white font-oai antialiased dark flex items-center justify-center">
      <div className="text-center space-y-4 max-w-sm px-4">
        {status === "processing" && (
          <>
            <div className="w-8 h-8 border-2 border-oai-gray-600 border-t-white rounded-full animate-spin mx-auto" />
            <p className="text-oai-gray-400 text-sm">{copy("auth.callback.processing")}</p>
          </>
        )}
        {status === "redirecting" && (
          <>
            <div className="w-12 h-12 mx-auto rounded-full bg-green-500/15 flex items-center justify-center">
              <svg className="w-6 h-6 text-green-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </div>
            <p className="text-white text-sm font-medium">{copy("auth.callback.success")}</p>
            <p className="text-oai-gray-500 text-xs">
              {copy("auth.callback.redirecting")}
            </p>
          </>
        )}
        {status === "failed" && (
          <div className="space-y-3">
            <p className="text-oai-gray-300 text-sm">{copy("auth.callback.failed")}</p>
            <button
              type="button"
              onClick={() => window.close()}
              className="px-4 py-2 rounded-lg bg-oai-gray-800 text-sm text-white hover:bg-oai-gray-700 transition-colors"
            >
              {copy("auth.callback.close")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
