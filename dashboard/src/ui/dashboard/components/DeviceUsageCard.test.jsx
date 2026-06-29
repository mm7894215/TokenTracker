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
});
