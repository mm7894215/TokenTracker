import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CostAnalysisModal } from "../CostAnalysisModal.jsx";

it("invokes onClose when clicking the backdrop", async () => {
  const onClose = vi.fn();
  const user = userEvent.setup();
  const { container } = render(
    <CostAnalysisModal isOpen={true} onClose={onClose} fleetData={[]} />,
  );

  const backdropSelector = '[data-cost-analysis-backdrop="true"]';
  const backdrop = document.querySelector(backdropSelector) ?? container.firstElementChild;

  if (!backdrop) {
    throw new Error(`Expected backdrop element (${backdropSelector}) to exist.`);
  }

  await act(async () => {
    await user.click(backdrop);
  });

  expect(onClose).toHaveBeenCalledTimes(1);
});
