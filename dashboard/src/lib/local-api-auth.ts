let localApiAuthToken: string | null = null;

export function clearLocalApiAuthToken(): void {
  localApiAuthToken = null;
}

export async function getLocalApiAuthToken(fetchImpl: typeof fetch = fetch): Promise<string> {
  if (localApiAuthToken) return localApiAuthToken;

  const res = await fetchImpl("/api/local-auth", {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Local auth request failed with HTTP ${res.status}`);
  }
  const data = (await res.json().catch(() => null)) as { token?: string } | null;
  const token = typeof data?.token === "string" ? data.token.trim() : "";
  if (!token) {
    throw new Error("Local auth token missing from response");
  }
  localApiAuthToken = token;
  return token;
}

export async function getLocalApiAuthHeaders(fetchImpl: typeof fetch = fetch): Promise<Record<string, string>> {
  const token = await getLocalApiAuthToken(fetchImpl);
  return { "x-tokentracker-local-auth": token };
}
