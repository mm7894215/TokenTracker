import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DeviceUsageCard } from "./DeviceUsageCard";

const devices = [
  { id: "d1", device_name: "MacBook Pro", platform: "darwin", total_tokens: 600 },
  { id: "d2", device_name: "Mac mini", platform: "darwin", total_tokens: 400 },
];

describe("DeviceUsageCard", () => {
  it("shows each device with its token count and share of total", () => {
    const { container } = render(
      <DeviceUsageCard devices={devices} selectedDeviceId="" onSelectDevice={() => {}} />,
    );
    expect(screen.getByText("MacBook Pro")).toBeTruthy();
    // Token count is the primary metric, percentage share the secondary; they
    // render together (e.g. "600 · 60.0%"), so assert against concatenated text.
    const text = container.textContent || "";
    expect(text).toContain("600");
    expect(text).toContain("60.0%");
    expect(text).toContain("400");
    expect(text).toContain("40.0%");
  });

  it("selects a device on click and clears it when re-clicked", async () => {
    const onSelectDevice = vi.fn();
    const { rerender } = render(
      <DeviceUsageCard devices={devices} selectedDeviceId="" onSelectDevice={onSelectDevice} />,
    );
    await userEvent.click(screen.getByText("MacBook Pro"));
    expect(onSelectDevice).toHaveBeenCalledWith("d1");

    rerender(<DeviceUsageCard devices={devices} selectedDeviceId="d1" onSelectDevice={onSelectDevice} />);
    await userEvent.click(screen.getByText("MacBook Pro"));
    expect(onSelectDevice).toHaveBeenLastCalledWith("");
  });

  it("renders the cleaned-up label for an auto-named device", () => {
    render(
      <DeviceUsageCard
        devices={[{ id: "d9", device_name: "Token Tracker (dashboard) #32fda7ee", platform: "MacIntel", total_tokens: 10 }]}
        selectedDeviceId=""
        onSelectDevice={() => {}}
      />,
    );
    expect(screen.getByText("Mac · 32fda7ee")).toBeTruthy();
  });

  it("does not show a rename affordance without an onRenameDevice handler", () => {
    render(<DeviceUsageCard devices={devices} selectedDeviceId="" onSelectDevice={() => {}} />);
    expect(screen.queryByLabelText("Rename device")).toBeNull();
  });

  it("renames a device through inline edit and exits edit mode on success", async () => {
    const onRenameDevice = vi.fn().mockResolvedValue({ ok: true });
    render(
      <DeviceUsageCard devices={devices} selectedDeviceId="" onSelectDevice={() => {}} onRenameDevice={onRenameDevice} />,
    );
    await userEvent.click(screen.getAllByLabelText("Rename device")[0]);
    const input = screen.getByPlaceholderText("Device name");
    await userEvent.clear(input);
    await userEvent.type(input, "Work laptop");
    await userEvent.click(screen.getByLabelText("Save name"));
    expect(onRenameDevice).toHaveBeenCalledWith("d1", "Work laptop");
  });

  it("keeps edit mode and surfaces an error when rename fails", async () => {
    const onRenameDevice = vi.fn().mockRejectedValue(new Error("HTTP 409"));
    render(
      <DeviceUsageCard devices={devices} selectedDeviceId="" onSelectDevice={() => {}} onRenameDevice={onRenameDevice} />,
    );
    await userEvent.click(screen.getAllByLabelText("Rename device")[0]);
    await userEvent.type(screen.getByPlaceholderText("Device name"), "Dup");
    await userEvent.click(screen.getByLabelText("Save name"));
    expect(await screen.findByText(/Couldn't rename/i)).toBeTruthy();
    expect(screen.getByPlaceholderText("Device name")).toBeTruthy();
  });

  it("hides devices with zero usage in the selected range", () => {
    render(
      <DeviceUsageCard
        devices={[...devices, { id: "d3", device_name: "Ghost Mac", platform: "darwin", total_tokens: 0 }]}
        selectedDeviceId=""
        onSelectDevice={() => {}}
      />,
    );
    expect(screen.queryByText("Ghost Mac")).toBeNull();
    expect(screen.getByText("MacBook Pro")).toBeTruthy();
  });

  it("lists account-level sources as non-clickable rows inside the shared denominator", async () => {
    const onSelectDevice = vi.fn();
    const { container } = render(
      <DeviceUsageCard
        devices={devices}
        accountSources={[{ source: "cursor", total_tokens: 1000 }]}
        selectedDeviceId=""
        onSelectDevice={onSelectDevice}
      />,
    );
    const row = screen.getByText("Cursor");
    // Denominator = 600 + 400 devices + 1000 account = 2000 -> 30% / 20% / 50%.
    const text = container.textContent || "";
    expect(text).toContain("30.0%");
    expect(text).toContain("20.0%");
    expect(text).toContain("50.0%");
    // Account-level usage has no device to filter by — clicking must not select.
    await userEvent.click(row);
    expect(onSelectDevice).not.toHaveBeenCalled();
  });

  it("uses the official AnythingLLM name and provider icon", () => {
    const { container } = render(
      <DeviceUsageCard
        devices={[]}
        accountSources={[{ source: "anythingllm", total_tokens: 1000 }]}
        selectedDeviceId=""
        onSelectDevice={() => {}}
      />,
    );

    expect(screen.getByText("AnythingLLM")).toBeTruthy();
    expect(container.querySelector('img[src="/brand-logos/anythingllm.svg"]')).not.toBeNull();
  });
});
