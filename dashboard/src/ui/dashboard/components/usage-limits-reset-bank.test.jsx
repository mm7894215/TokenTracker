import { createElement } from "react";
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copy, setCopyLocale } from "../../../lib/copy";
import { EN_LOCALE, JA_LOCALE, KO_LOCALE } from "../../../lib/locale";
import { UsageLimitsPanel } from "./UsageLimitsPanel.jsx";
import { buildResetBankRows } from "./usage-limits-reset-bank.js";

const CODEX_WINDOWS = {
  primary_window: { used_percent: 12, reset_at: 1_800_000_000, limit_window_seconds: 18000 },
  secondary_window: { used_percent: 30, reset_at: 1_800_604_800, limit_window_seconds: 604800 },
  spark_primary_window: { used_percent: 4, reset_at: 1_800_000_001, limit_window_seconds: 18000 },
  spark_secondary_window: { used_percent: 18, reset_at: 1_800_604_801, limit_window_seconds: 604800 },
};

const NOW = new Date("2030-01-06T00:00:00.000Z");

function usageLimitsPanelElement(resetCredits) {
  return createElement(UsageLimitsPanel, {
    codex: {
      configured: true,
      error: null,
      ...CODEX_WINDOWS,
      reset_credits: resetCredits,
    },
    order: ["codex"],
  });
}

function renderCodex(resetCredits) {
  render(usageLimitsPanelElement(resetCredits));
  const group = screen.getByText("Codex").closest("[role='button']");
  expect(group).not.toBeNull();
  return within(group);
}

function formatExpiry(iso, locale = EN_LOCALE) {
  return new Intl.DateTimeFormat(locale, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function credit(granted_at, expires_at) {
  return { status: "available", reset_type: "weekly", granted_at, expires_at };
}

let getContextSpy;

beforeEach(() => {
  getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    font: "",
    measureText: (text) => ({ width: String(text).length * 6 }),
  });
});

afterEach(() => {
  getContextSpy?.mockRestore();
});

describe("buildResetBankRows", () => {
  afterEach(() => {
    setCopyLocale(EN_LOCALE);
  });

  it("returns one Reset row per credit with minute-precision expiry labels without years", () => {
    const firstExpiry = "2030-01-11T10:45:00.000Z";
    const secondExpiry = "2030-01-12T08:30:00.000Z";

    const model = buildResetBankRows(
      {
        available_count: 2,
        total_earned_count: 2,
        credits: [
          credit("2030-01-01T10:45:00.000Z", firstExpiry),
          credit("2030-01-02T08:30:00.000Z", secondExpiry),
        ],
      },
      { now: NOW },
    );

    expect(model).toMatchObject({
      kind: "rows",
      availableCount: 2,
      rows: [
        {
          label: copy("limits.codex_reset_bank.row_label", { index: 1 }),
          expiresAt: formatExpiry(firstExpiry),
          percent: 54,
        },
        {
          label: copy("limits.codex_reset_bank.row_label", { index: 2 }),
          expiresAt: formatExpiry(secondExpiry),
          percent: 64,
        },
      ],
    });
    expect(model.rows[0].expiresAt).not.toMatch(/\b2030\b/);
    expect(model.rows[1].expiresAt).not.toMatch(/\b2030\b/);
  });

  it("keeps expiry rows with a full neutral bar when granted time is unusable", () => {
    const expiry = "2030-01-11T10:45:00.000Z";

    const model = buildResetBankRows(
      {
        available_count: 1,
        total_earned_count: 1,
        credits: [credit("not-a-date", expiry)],
      },
      { now: NOW },
    );

    expect(model).toMatchObject({
      kind: "rows",
      rows: [{ label: copy("limits.codex_reset_bank.row_label", { index: 1 }), expiresAt: formatExpiry(expiry), percent: 100 }],
    });
  });

  it("returns no section for null or malformed payloads", () => {
    expect(buildResetBankRows(null, { now: NOW })).toBeNull();
    expect(buildResetBankRows("bad", { now: NOW })).toBeNull();
    expect(buildResetBankRows({}, { now: NOW })).toBeNull();
    expect(buildResetBankRows({ available_count: -1, credits: [] }, { now: NOW })).toBeNull();
  });

  it("returns no Reset Bank section for zero available count and count-only state for positive count", () => {
    expect(
      buildResetBankRows(
        {
          available_count: 0,
          total_earned_count: 2,
          credits: [credit("2030-01-01T10:45:00.000Z", "2030-01-11T10:45:00.000Z")],
        },
        { now: NOW },
      ),
    ).toBeNull();

    expect(
      buildResetBankRows(
        {
          available_count: 2,
          total_earned_count: 2,
          credits: [credit("2030-01-01T10:45:00.000Z", "not-a-date")],
        },
        { now: NOW },
      ),
    ).toMatchObject({ kind: "count_only", availableCount: 2, rows: [] });
  });
});

describe("UsageLimitsPanel Codex Reset Bank", () => {
  afterEach(() => {
    setCopyLocale(EN_LOCALE);
  });

  it("renders Reset rows inside the Codex group with minute precision and no years", () => {
    const firstExpiry = "2030-01-11T10:45:00.000Z";
    const secondExpiry = "2030-01-12T08:30:00.000Z";

    const codexGroup = renderCodex({
      available_count: 2,
      total_earned_count: 2,
      credits: [
        credit("2030-01-01T10:45:00.000Z", firstExpiry),
        credit("2030-01-02T08:30:00.000Z", secondExpiry),
      ],
    });

    expect(codexGroup.getByText("5h")).toBeInTheDocument();
    expect(codexGroup.getByText("7d")).toBeInTheDocument();
    expect(codexGroup.getByText(copy("limits.codex_reset_bank.title"))).toBeInTheDocument();
    expect(codexGroup.getByText(copy("limits.codex_reset_bank.row_label", { index: 1 }))).toBeInTheDocument();
    expect(codexGroup.getByText(copy("limits.codex_reset_bank.row_label", { index: 2 }))).toBeInTheDocument();
    expect(codexGroup.getByText(formatExpiry(firstExpiry))).toHaveClass("tabular-nums", "w-[4.25rem]");
    expect(codexGroup.getByText(formatExpiry(secondExpiry))).toHaveClass("tabular-nums", "w-[4.25rem]");
    expect(codexGroup.queryByText(/\b2030\b/)).not.toBeInTheDocument();
  });

  it("localizes Codex Reset Bank labels for Japanese and Korean users", () => {
    const resetCredits = {
      available_count: 1,
      total_earned_count: 1,
      credits: [credit("2030-01-01T10:45:00.000Z", "2030-01-11T10:45:00.000Z")],
    };

    setCopyLocale(JA_LOCALE);
    const { unmount } = render(usageLimitsPanelElement(resetCredits));
    let codexGroup = within(screen.getByText("Codex").closest("[role='button']"));
    expect(codexGroup.getByText(copy("limits.codex_reset_bank.title"))).toBeInTheDocument();
    expect(codexGroup.getByText(copy("limits.codex_reset_bank.row_label", { index: 1 }))).toBeInTheDocument();
    expect(codexGroup.queryByText("Resets")).not.toBeInTheDocument();
    expect(codexGroup.queryByText("Reset 1")).not.toBeInTheDocument();
    unmount();

    setCopyLocale(KO_LOCALE);
    render(usageLimitsPanelElement(resetCredits));
    codexGroup = within(screen.getByText("Codex").closest("[role='button']"));
    expect(codexGroup.getByText(copy("limits.codex_reset_bank.title"))).toBeInTheDocument();
    expect(codexGroup.getByText(copy("limits.codex_reset_bank.row_label", { index: 1 }))).toBeInTheDocument();
    expect(codexGroup.getByText(formatExpiry(resetCredits.credits[0].expires_at, KO_LOCALE))).toBeInTheDocument();
    expect(codexGroup.queryByText(/오전|오후/)).not.toBeInTheDocument();
    expect(codexGroup.queryByText("Resets")).not.toBeInTheDocument();
    expect(codexGroup.queryByText("Reset 1")).not.toBeInTheDocument();
  });

  it("localizes Codex Reset Bank count-only fallback for Japanese and Korean users", () => {
    const resetCredits = {
      available_count: 2,
      total_earned_count: 2,
      credits: [credit("2030-01-01T10:45:00.000Z", "not-a-date")],
    };

    setCopyLocale(JA_LOCALE);
    const { unmount } = render(usageLimitsPanelElement(resetCredits));
    let codexGroup = within(screen.getByText("Codex").closest("[role='button']"));
    expect(codexGroup.getByText(copy("limits.codex_reset_bank.count_only", { count: 2 }))).toBeInTheDocument();
    expect(codexGroup.queryByText(/Reset Bank/)).not.toBeInTheDocument();
    unmount();

    setCopyLocale(KO_LOCALE);
    render(usageLimitsPanelElement(resetCredits));
    codexGroup = within(screen.getByText("Codex").closest("[role='button']"));
    expect(codexGroup.getByText(copy("limits.codex_reset_bank.count_only", { count: 2 }))).toBeInTheDocument();
    expect(codexGroup.queryByText(/Reset Bank/)).not.toBeInTheDocument();
  });

  it("renders five credits as five rows instead of +N more", () => {
    const dates = [
      "2030-01-10T10:00:00.000Z",
      "2030-02-11T10:01:00.000Z",
      "2030-03-12T10:02:00.000Z",
      "2030-04-13T10:03:00.000Z",
      "2030-05-14T10:04:00.000Z",
    ];

    const codexGroup = renderCodex({
      available_count: 5,
      total_earned_count: 5,
      credits: dates.map((expires_at, index) => credit(`2030-01-0${index + 1}T10:00:00.000Z`, expires_at)),
    });

    for (const [index, expiresAt] of dates.entries()) {
      expect(codexGroup.getByText(copy("limits.codex_reset_bank.row_label", { index: index + 1 }))).toBeInTheDocument();
      expect(codexGroup.getByText(formatExpiry(expiresAt))).toBeInTheDocument();
    }
    expect(codexGroup.queryByText(/\+\d+ more/i)).not.toBeInTheDocument();
  });

  it("does not render a Resets section for null or malformed payloads", () => {
    const { rerender } = render(usageLimitsPanelElement(null));

    expect(screen.queryByText(copy("limits.codex_reset_bank.title"))).not.toBeInTheDocument();

    rerender(usageLimitsPanelElement({}));

    expect(screen.queryByText(copy("limits.codex_reset_bank.title"))).not.toBeInTheDocument();
  });

  it("does not render a Reset Bank section when no manual resets are available", () => {
    const codexGroup = renderCodex({
      available_count: 0,
      total_earned_count: 2,
      credits: [credit("2030-01-01T10:45:00.000Z", "2030-01-11T10:45:00.000Z")],
    });

    expect(codexGroup.queryByText(copy("limits.codex_reset_bank.title"))).not.toBeInTheDocument();
    expect(codexGroup.queryByText(copy("limits.codex_reset_bank.row_label", { index: 1 }))).not.toBeInTheDocument();
  });

  it("shows Codex no-data fallback when Reset Bank has nothing displayable and no quota windows exist", () => {
    const { rerender } = render(
      createElement(UsageLimitsPanel, {
        codex: {
          configured: true,
          error: null,
          reset_credits: {
            available_count: 0,
            total_earned_count: 2,
            credits: [credit("2030-01-01T10:45:00.000Z", "2030-01-11T10:45:00.000Z")],
          },
        },
        order: ["codex"],
      }),
    );

    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText(copy("limits.status.no_data"))).toBeInTheDocument();

    rerender(
      createElement(UsageLimitsPanel, {
        codex: {
          configured: true,
          error: null,
          reset_credits: null,
        },
        order: ["codex"],
      }),
    );

    expect(screen.getByText(copy("limits.status.no_data"))).toBeInTheDocument();
  });

  it("renders passive expiry-unavailable copy when count exists without usable expiry rows", () => {
    const codexGroup = renderCodex({
      available_count: 2,
      total_earned_count: 2,
      credits: [credit("2030-01-01T10:45:00.000Z", "not-a-date")],
    });

    expect(codexGroup.getByText(copy("limits.codex_reset_bank.count_only", { count: 2 }))).toBeInTheDocument();
    expect(codexGroup.queryByText(copy("limits.codex_reset_bank.row_label", { index: 1 }))).not.toBeInTheDocument();
  });

  it("keeps the Reset Bank surface passive without action controls", () => {
    renderCodex({
      available_count: 1,
      total_earned_count: 1,
      credits: [credit("2030-01-01T10:45:00.000Z", "2030-01-11T10:45:00.000Z")],
    });

    expect(document.querySelectorAll("button")).toHaveLength(0);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    expect(screen.queryByText(/redeem|claim|action/i)).not.toBeInTheDocument();
  });
});
