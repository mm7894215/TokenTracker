import { describe, expect, it, vi } from "vitest";
import { fetchUsdRates, shouldRefetch, EXCHANGE_RATE_TTL_MS } from "./exchange-rate";

describe("shouldRefetch", () => {
  it("returns true when never fetched", () => {
    expect(shouldRefetch(null)).toBe(true);
    expect(shouldRefetch(undefined)).toBe(true);
    expect(shouldRefetch(0)).toBe(true);
  });

  it("returns false within TTL", () => {
    const now = 1_700_000_000_000;
    expect(shouldRefetch(now - 1000, EXCHANGE_RATE_TTL_MS, now)).toBe(false);
  });

  it("returns true after TTL", () => {
    const now = 1_700_000_000_000;
    expect(shouldRefetch(now - EXCHANGE_RATE_TTL_MS - 1, EXCHANGE_RATE_TTL_MS, now)).toBe(true);
  });
});

describe("fetchUsdRates", () => {
  it("picks supported rates from API response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        rates: { CNY: 7.0987, EUR: 0.92, GBP: 0.79, JPY: 155, HKD: 7.8, INR: 84.2, BTC: 0.00002 },
      }),
    });
    const result = await fetchUsdRates({ fetchImpl: fetchImpl as any });
    expect(result.rates.CNY).toBe(7.0987);
    expect(result.rates.EUR).toBe(0.92);
    expect(result.rates.GBP).toBe(0.79);
    expect(result.rates.JPY).toBe(155);
    expect(result.rates.HKD).toBe(7.8);
    expect(result.rates.INR).toBe(84.2);
    expect(result.rates.USD).toBe(1);
    // Unsupported codes are filtered out.
    expect(result.rates.BTC).toBeUndefined();
    expect(typeof result.fetchedAt).toBe("number");
  });

  it("throws when response is not ok", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(fetchUsdRates({ fetchImpl: fetchImpl as any })).rejects.toThrow();
  });

  it("throws when rates payload missing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    await expect(fetchUsdRates({ fetchImpl: fetchImpl as any })).rejects.toThrow();
  });

  it("throws when no supported currencies present", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ rates: { BTC: 0.00002 } }),
    });
    await expect(fetchUsdRates({ fetchImpl: fetchImpl as any })).rejects.toThrow();
  });

  it("respects custom url and codes", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ rates: { EUR: 0.9, JPY: 150 } }),
    });
    const r = await fetchUsdRates({
      fetchImpl: fetchImpl as any,
      url: "https://example.com/r",
      codes: ["EUR", "JPY"],
    });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://example.com/r");
    expect(r.rates.EUR).toBe(0.9);
    expect(r.rates.JPY).toBe(150);
    expect(r.rates.CNY).toBeUndefined();
  });
});
