import { useCallback, useEffect, useRef, useState } from "react";

export type ToastKind = "info" | "success" | "error";
export type Toast = { id: number; kind: ToastKind; text: string };
export type ShareAction = null | "copy" | "download" | "x";

export function isNativeEmbed(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean((window as any)?.webkit?.messageHandlers?.nativeBridge);
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function pickAvatarUrl(user: any): string | null {
  if (!user) return null;
  const meta = user.user_metadata || {};
  const prof = user.profile || {};
  const url = cleanText(meta.avatar_url || meta.picture || prof.avatar_url || user.avatar_url);
  return url || null;
}

export function makeColorSeed(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function useToast() {
  const [toast, setToast] = useState<Toast | null>(null);
  const timerRef = useRef<number | null>(null);
  const push = useCallback((text: string, kind: ToastKind = "info") => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    setToast({ id: Date.now(), kind, text });
    timerRef.current = window.setTimeout(() => setToast(null), 2800);
  }, []);
  useEffect(
    () => () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    },
    [],
  );
  return { toast, push };
}
