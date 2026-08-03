import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceStatusPage, STATUS_PROVIDERS } from "./ServiceStatusPage.jsx";

function statusBody(indicator, description) {
  return {
    page: { updated_at: "2026-07-26T08:00:00.000Z" },
    status: { indicator, description },
  };
}

function okResponse(body) {
  return { ok: true, json: async () => body };
}

const isGoogleFeed = (url) => String(url).includes("appsstatus");
const isInstatusFeed = (url) => String(url).includes("summary.json");

function instatusBody(status, activeIncidents = []) {
  return { page: { status }, activeIncidents };
}

/** Route a fetch stub by feed shape: Google → incidents array, Instatus → summary, rest → Statuspage JSON. */
function stubFetch({
  google = [],
  instatus = () => instatusBody("UP"),
  statuspage = () => statusBody("none", "All Systems Operational"),
} = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (isGoogleFeed(url)) return okResponse(google);
      if (isInstatusFeed(url)) return okResponse(instatus(url));
      return okResponse(statuspage(url));
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ServiceStatusPage", () => {
  it("renders one card per provider with its probed state", async () => {
    stubFetch({
      statuspage: (url) =>
        String(url).includes("status.claude.com")
          ? statusBody("major", "Elevated errors on Claude models")
          : statusBody("none", "All Systems Operational"),
    });

    render(<ServiceStatusPage />);

    for (const provider of STATUS_PROVIDERS) {
      expect(screen.getByText(provider.name)).toBeInTheDocument();
    }

    // Claude carries the incident state + description; the rest are operational.
    await waitFor(() => {
      expect(screen.getByText("Major incident")).toBeInTheDocument();
    });
    expect(screen.getByText("Elevated errors on Claude models")).toBeInTheDocument();
    expect(screen.getAllByText("Operational")).toHaveLength(STATUS_PROVIDERS.length - 1);
  });

  it("maps open Google-feed incidents onto the Gemini card", async () => {
    stubFetch({
      google: [
        // Closed incident (has `end`) must be ignored.
        { service_name: "Gemini", severity: "high", end: "2026-07-01T00:00:00Z", external_desc: "old" },
        { service_name: "Gemini", severity: "medium", external_desc: "Gemini API elevated latency" },
        // Other Google products never leak onto the card.
        { service_name: "Gmail", severity: "high", external_desc: "unrelated" },
      ],
    });

    render(<ServiceStatusPage />);

    await waitFor(() => {
      expect(screen.getByText("Major incident")).toBeInTheDocument();
    });
    expect(screen.getByText("Gemini API elevated latency")).toBeInTheDocument();
    expect(screen.getAllByText("Operational")).toHaveLength(STATUS_PROVIDERS.length - 1);
  });

  it("maps Instatus HASISSUES summaries onto the matching card", async () => {
    stubFetch({
      instatus: (url) =>
        String(url).includes("zed.dev")
          ? instatusBody("HASISSUES", [{ name: "Collab server degraded", impact: "PARTIALOUTAGE" }])
          : instatusBody("UP"),
    });

    render(<ServiceStatusPage />);

    await waitFor(() => {
      expect(screen.getByText("Major incident")).toBeInTheDocument();
    });
    expect(screen.getByText("Collab server degraded")).toBeInTheDocument();
    expect(screen.getAllByText("Operational")).toHaveLength(STATUS_PROVIDERS.length - 1);
  });

  it("shows the unreachable state when a probe fails, without breaking others", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (String(url).includes("githubstatus")) throw new Error("network down");
        if (isGoogleFeed(url)) return okResponse([]);
        if (isInstatusFeed(url)) return okResponse(instatusBody("UP"));
        return okResponse(statusBody("none", "All Systems Operational"));
      }),
    );

    render(<ServiceStatusPage />);

    await waitFor(() => {
      expect(screen.getByText("Unreachable")).toBeInTheDocument();
    });
    expect(screen.getAllByText("Operational")).toHaveLength(STATUS_PROVIDERS.length - 1);
  });

  it("treats unexpected payloads as unreachable instead of crashing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okResponse({ totally: "unexpected" })),
    );

    render(<ServiceStatusPage />);

    await waitFor(() => {
      expect(screen.getAllByText("Unreachable")).toHaveLength(STATUS_PROVIDERS.length);
    });
  });

  it("links every card to the provider's public status page", async () => {
    stubFetch();

    render(<ServiceStatusPage />);
    await waitFor(() => {
      expect(screen.getAllByText("Operational")).toHaveLength(STATUS_PROVIDERS.length);
    });

    const hrefs = Array.from(document.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    for (const provider of STATUS_PROVIDERS) {
      expect(hrefs).toContain(provider.pageUrl);
    }
  });
});
