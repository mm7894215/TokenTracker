export function getNotificationPermission(): string;

export function watchNotificationPermission(
  onChange: (permission: string) => void,
): () => void;

export function ensureNotificationPermission(): Promise<void>;
