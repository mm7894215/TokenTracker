export type AuthTokenProvider =
  | string
  | null
  | undefined
  | (() => string | null | undefined | Promise<string | null | undefined>)
  | {
      getAccessToken?: () => string | null | undefined | Promise<string | null | undefined>;
    };

export function normalizeAccessToken(token: unknown): string | null;
export function resolveAuthAccessToken(auth: AuthTokenProvider): Promise<string | null>;
export function resolveAuthAccessTokenWithRetry(
  auth: AuthTokenProvider,
  options?: { maxAttempts?: number; baseDelayMs?: number },
): Promise<string | null>;
export function isAccessTokenReady(token: AuthTokenProvider | unknown): boolean;
export function isValidJwtShape(token: unknown): boolean;
