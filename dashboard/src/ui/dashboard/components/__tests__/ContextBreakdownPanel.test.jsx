import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContextBreakdownPanel } from "../ContextBreakdownPanel.jsx";
import { getUsageCategoryBreakdown } from "../../../../lib/api";
import { copy } from "../../../../lib/copy";

vi.mock("../../../../lib/api", () => ({
  getUsageCategoryBreakdown: vi.fn(),
}));

vi.mock("../../../../lib/timezone", () => ({
  getBrowserTimeZone: () => "Asia/Shanghai",
  getBrowserTimeZoneOffsetMinutes: () => -480,
}));

describe("ContextBreakdownPanel", () => {
  it("uses generic loading copy while session logs are being scanned", async () => {
    getUsageCategoryBreakdown.mockReturnValueOnce(new Promise(() => {}));

    render(<ContextBreakdownPanel from="2026-05-09" to="2026-05-09" source="codex" />);

    expect(await screen.findByText(copy("dashboard.context_breakdown.loading_hint"))).toBeInTheDocument();
    expect(screen.queryByText("Scanning Claude Code session logs…")).not.toBeInTheDocument();
    expect(screen.queryByText("Scanning Codex session logs…")).not.toBeInTheDocument();
  });

  it("renders Codex tool calls from total token attribution", async () => {
    getUsageCategoryBreakdown.mockResolvedValueOnce({
      source: "codex",
      scope: "supported",
      totals: {
        input_tokens: 100,
        cached_input_tokens: 900,
        cache_creation_input_tokens: 0,
        output_tokens: 20,
        reasoning_output_tokens: 5,
        total_tokens: 1020,
      },
      session_count: 1,
      message_count: 2,
      tool_calls_breakdown: {
        total_calls: 1,
        categories: [
          {
            name: "Execution",
            calls: 1,
            totals: {
              input_tokens: 100,
              cached_input_tokens: 900,
              cache_creation_input_tokens: 0,
              output_tokens: 20,
              reasoning_output_tokens: 5,
              total_tokens: 1020,
            },
            tools: [],
          },
        ],
      },
      exec_command_breakdown: { by_type: [], by_exit: [] },
    });

    render(<ContextBreakdownPanel from="2026-05-09" to="2026-05-09" source="codex" />);

    await waitFor(() => {
      expect(getUsageCategoryBreakdown).toHaveBeenCalledWith(
        expect.objectContaining({
          from: "2026-05-09",
          to: "2026-05-09",
          source: "codex",
        }),
      );
    });

    const toolCallsRow = screen
      .getByText(copy("dashboard.context_breakdown.category.tool_calls"))
      .closest("li");
    expect(toolCallsRow).toHaveTextContent("99.5%");
  });

  it("scales displayed categories to the provider model total when supplied", async () => {
    getUsageCategoryBreakdown.mockResolvedValueOnce({
      source: "claude",
      scope: "supported",
      totals: {
        input_tokens: 100,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 100,
        reasoning_output_tokens: 0,
        total_tokens: 200,
      },
      categories: [
        {
          key: "user_input",
          totals: {
            input_tokens: 100,
            cached_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: 100,
          },
        },
        {
          key: "assistant_response",
          totals: {
            input_tokens: 0,
            cached_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 100,
            reasoning_output_tokens: 0,
            total_tokens: 100,
          },
        },
      ],
      session_count: 1,
      message_count: 2,
      message_breakdown: { categories: [] },
      tool_calls_breakdown: {
        tool_calls: { total_calls: 0, categories: [] },
        subagents: { total_calls: 0, categories: [] },
      },
      exec_command_breakdown: { by_type: [], by_exit: [] },
    });

    render(
      <ContextBreakdownPanel
        from="2026-05-09"
        to="2026-05-09"
        source="claude"
        referenceTotalTokens={100}
      />,
    );

    const messagesRow = await screen.findByText(copy("dashboard.context_breakdown.category.messages"));
    expect(messagesRow.closest("li")).toHaveTextContent("100");
    expect(messagesRow.closest("li")).toHaveTextContent("100.0%");
  });

  it("shows Codex queue fallback notice when tool details are unavailable", async () => {
    getUsageCategoryBreakdown.mockResolvedValueOnce({
      source: "codex",
      scope: "supported",
      breakdown_status: "queue_fallback",
      fallback: "queue_totals",
      totals: {
        input_tokens: 100,
        cached_input_tokens: 200,
        cache_creation_input_tokens: 0,
        output_tokens: 50,
        reasoning_output_tokens: 10,
        total_tokens: 350,
      },
      session_count: 0,
      message_count: 2,
      tool_calls_breakdown: {
        total_calls: 0,
        categories: [],
      },
      exec_command_breakdown: { by_type: [], by_exit: [] },
    });

    render(<ContextBreakdownPanel from="2026-05-09" to="2026-05-09" source="codex" />);

    expect(
      await screen.findByText(copy("dashboard.context_breakdown.tool_details.unavailable_codex")),
    ).toBeInTheDocument();
  });

  it("expands Messages row inline to show message sub-categories", async () => {
    getUsageCategoryBreakdown.mockResolvedValueOnce({
      source: "claude",
      scope: "supported",
      totals: {
        input_tokens: 100,
        cached_input_tokens: 200,
        cache_creation_input_tokens: 50,
        output_tokens: 80,
        reasoning_output_tokens: 0,
        total_tokens: 430,
      },
      categories: [
        {
          key: "user_input",
          totals: {
            input_tokens: 100,
            cached_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: 100,
          },
          percent: 23.26,
        },
        {
          key: "conversation_history",
          totals: {
            input_tokens: 0,
            cached_input_tokens: 200,
            cache_creation_input_tokens: 50,
            output_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: 250,
          },
          percent: 58.14,
        },
        {
          key: "assistant_response",
          totals: {
            input_tokens: 0,
            cached_input_tokens: 0,
            cache_creation_input_tokens: 0,
            output_tokens: 80,
            reasoning_output_tokens: 0,
            total_tokens: 80,
          },
          percent: 18.6,
        },
      ],
      session_count: 1,
      message_count: 2,
      message_breakdown: {
        categories: [
          {
            key: "conversation_history",
            totals: {
              input_tokens: 0,
              cached_input_tokens: 200,
              cache_creation_input_tokens: 50,
              output_tokens: 0,
              reasoning_output_tokens: 0,
              total_tokens: 250,
            },
          },
          {
            key: "user_input",
            totals: {
              input_tokens: 100,
              cached_input_tokens: 0,
              cache_creation_input_tokens: 0,
              output_tokens: 0,
              reasoning_output_tokens: 0,
              total_tokens: 100,
            },
          },
          {
            key: "assistant_response",
            totals: {
              input_tokens: 0,
              cached_input_tokens: 0,
              cache_creation_input_tokens: 0,
              output_tokens: 80,
              reasoning_output_tokens: 0,
              total_tokens: 80,
            },
          },
        ],
      },
      tool_calls_breakdown: {
        tool_calls: { total_calls: 0, categories: [] },
        subagents: { total_calls: 0, categories: [] },
      },
    });

    render(<ContextBreakdownPanel from="2026-05-09" to="2026-05-09" source="claude" />);

    // Wait for data to load
    await screen.findByText(copy("dashboard.context_breakdown.category.messages"));

    // Click the Messages disclosure button (has aria-expanded)
    const messagesBtn = screen.getByRole("button", { name: copy("dashboard.context_breakdown.category.messages") });
    fireEvent.click(messagesBtn);

    // Sub-rows appear inline (no modal)
    expect(await screen.findByText(copy("dashboard.context_breakdown.message_details.conversation_history"))).toBeInTheDocument();
    expect(screen.getByText(copy("dashboard.context_breakdown.message_details.user_input"))).toBeInTheDocument();
    expect(screen.getByText(copy("dashboard.context_breakdown.message_details.assistant_response"))).toBeInTheDocument();

    // Confirm no dialog/modal is present
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows short Codex MCP tool names in tool details inline", async () => {
    getUsageCategoryBreakdown.mockResolvedValueOnce({
      source: "codex",
      scope: "supported",
      breakdown_status: "ok",
      totals: {
        input_tokens: 100,
        cached_input_tokens: 200,
        cache_creation_input_tokens: 0,
        output_tokens: 50,
        reasoning_output_tokens: 10,
        total_tokens: 350,
      },
      session_count: 1,
      message_count: 2,
      tool_calls_breakdown: {
        total_calls: 2,
        categories: [
          {
            name: "MCP: chrome-devtools",
            calls: 2,
            totals: {
              input_tokens: 100,
              cached_input_tokens: 200,
              cache_creation_input_tokens: 0,
              output_tokens: 50,
              reasoning_output_tokens: 10,
              total_tokens: 350,
            },
            tools: [
              {
                name: "chrome-devtools/emulate",
                calls: 1,
                totals: {
                  input_tokens: 50,
                  cached_input_tokens: 100,
                  cache_creation_input_tokens: 0,
                  output_tokens: 25,
                  reasoning_output_tokens: 5,
                  total_tokens: 175,
                },
              },
            ],
          },
        ],
      },
      exec_command_breakdown: { by_type: [], by_exit: [] },
    });

    render(<ContextBreakdownPanel from="2026-05-09" to="2026-05-09" source="codex" />);

    await screen.findByText(copy("dashboard.context_breakdown.category.tool_calls"));
    // Click the tool calls disclosure button
    fireEvent.click(screen.getByRole("button", { name: copy("dashboard.context_breakdown.category.tool_calls") }));

    // MCP category appears
    expect(await screen.findByText("MCP: chrome-devtools")).toBeInTheDocument();

    // Expand the category to see the tool
    fireEvent.click(screen.getByRole("button", { name: "MCP: chrome-devtools" }));

    expect(await screen.findByText(/emulate/)).toBeInTheDocument();
    expect(screen.queryByText("chrome-devtools/emulate")).not.toBeInTheDocument();
  });

  it("shows skills disclosure row when the breakdown includes them", async () => {
    getUsageCategoryBreakdown.mockResolvedValueOnce({
      source: "codex",
      scope: "supported",
      totals: {
        input_tokens: 100,
        cached_input_tokens: 200,
        cache_creation_input_tokens: 0,
        output_tokens: 50,
        reasoning_output_tokens: 10,
        total_tokens: 350,
      },
      session_count: 1,
      message_count: 2,
      tool_calls_breakdown: {
        total_calls: 1,
        categories: [
          {
            name: "Execution",
            calls: 1,
            totals: {
              input_tokens: 100,
              cached_input_tokens: 200,
              cache_creation_input_tokens: 0,
              output_tokens: 50,
              reasoning_output_tokens: 0,
              total_tokens: 350,
            },
            tools: [],
          },
        ],
      },
      skills_breakdown: {
        total_calls: 1,
        skills: [
          {
            name: "frontend-design",
            calls: 1,
            totals: { total_tokens: 350 },
          },
        ],
      },
      exec_command_breakdown: { by_type: [], by_exit: [] },
    });

    render(<ContextBreakdownPanel from="2026-05-09" to="2026-05-09" source="codex" />);

    // Skills disclosure row should be present
    const skillsLabel = await screen.findByText(copy("dashboard.context_breakdown.category.skills"));
    expect(skillsLabel).toBeInTheDocument();

    // Click to expand it
    fireEvent.click(screen.getByRole("button", { name: copy("dashboard.context_breakdown.category.skills") }));

    // Skill name appears inline
    expect(await screen.findByText("frontend-design")).toBeInTheDocument();
  });

  it("shows short Claude MCP tool names in inline tool details", async () => {
    getUsageCategoryBreakdown.mockResolvedValueOnce({
      source: "claude",
      scope: "supported",
      totals: {
        input_tokens: 100,
        cached_input_tokens: 200,
        cache_creation_input_tokens: 0,
        output_tokens: 50,
        reasoning_output_tokens: 10,
        total_tokens: 350,
      },
      categories: [
        {
          key: "tool_calls",
          totals: {
            input_tokens: 100,
            cached_input_tokens: 200,
            cache_creation_input_tokens: 0,
            output_tokens: 50,
            reasoning_output_tokens: 0,
            total_tokens: 350,
          },
          percent: 100,
        },
      ],
      session_count: 1,
      message_count: 2,
      tool_calls_breakdown: {
        tool_calls: {
          total_calls: 1,
          categories: [
            {
              name: "MCP: chrome-devtools",
              calls: 1,
              totals: {
                input_tokens: 100,
                cached_input_tokens: 200,
                cache_creation_input_tokens: 0,
                output_tokens: 50,
                reasoning_output_tokens: 0,
                total_tokens: 350,
              },
              tools: [
                {
                  name: "mcp__chrome-devtools__emulate",
                  calls: 1,
                  totals: {
                    input_tokens: 100,
                    cached_input_tokens: 200,
                    cache_creation_input_tokens: 0,
                    output_tokens: 50,
                    reasoning_output_tokens: 0,
                    total_tokens: 350,
                  },
                },
              ],
            },
          ],
        },
        subagents: { total_calls: 0, categories: [] },
      },
    });

    render(<ContextBreakdownPanel from="2026-05-09" to="2026-05-09" source="claude" />);

    await screen.findByText(copy("dashboard.context_breakdown.category.tool_calls"));
    // Expand tool calls
    fireEvent.click(screen.getByRole("button", { name: copy("dashboard.context_breakdown.category.tool_calls") }));

    // Expand the MCP category
    fireEvent.click(await screen.findByRole("button", { name: "MCP: chrome-devtools" }));

    expect(await screen.findByText(/emulate/)).toBeInTheDocument();
    expect(screen.queryByText("mcp__chrome-devtools__emulate")).not.toBeInTheDocument();
  });

  it("shows Claude execution drill-down inline when Bash tool is expanded", async () => {
    getUsageCategoryBreakdown.mockResolvedValueOnce({
      source: "claude",
      scope: "supported",
      totals: {
        input_tokens: 100,
        cached_input_tokens: 200,
        cache_creation_input_tokens: 0,
        output_tokens: 50,
        reasoning_output_tokens: 10,
        total_tokens: 350,
      },
      categories: [
        {
          key: "tool_calls",
          totals: {
            input_tokens: 100,
            cached_input_tokens: 200,
            cache_creation_input_tokens: 0,
            output_tokens: 50,
            reasoning_output_tokens: 0,
            total_tokens: 350,
          },
          percent: 100,
        },
      ],
      session_count: 1,
      message_count: 2,
      tool_calls_breakdown: {
        tool_calls: {
          total_calls: 1,
          categories: [
            {
              name: "Execution",
              calls: 1,
              totals: {
                input_tokens: 100,
                cached_input_tokens: 200,
                cache_creation_input_tokens: 0,
                output_tokens: 50,
                reasoning_output_tokens: 0,
                total_tokens: 350,
              },
              tools: [{ name: "Bash", calls: 1, totals: { total_tokens: 350 } }],
            },
          ],
        },
        subagents: { total_calls: 0, categories: [] },
      },
      exec_command_breakdown: {
        by_type: [{ name: "test", calls: 1, totals: { total_tokens: 350 } }],
        by_executable: [{ name: "npm", calls: 1, totals: { total_tokens: 350 } }],
        by_command: [{ name: "npm test", calls: 1, totals: { total_tokens: 350 } }],
        by_duration: [],
        by_output: [],
        by_exit: [],
      },
    });

    render(<ContextBreakdownPanel from="2026-05-09" to="2026-05-09" source="claude" />);

    await screen.findByText(copy("dashboard.context_breakdown.category.tool_calls"));

    // Expand tool calls
    fireEvent.click(screen.getByRole("button", { name: copy("dashboard.context_breakdown.category.tool_calls") }));

    // Expand the Execution category
    fireEvent.click(await screen.findByRole("button", { name: "Execution" }));

    // Click the Bash disclosure button to open exec drill-down
    fireEvent.click(await screen.findByRole("button", { name: /Bash/ }));

    // Exec drill-down data appears inline (no modal)
    expect(await screen.findByText("test")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
