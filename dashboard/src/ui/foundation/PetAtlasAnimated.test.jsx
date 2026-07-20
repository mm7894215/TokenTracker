import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PetAtlasAnimated, petAtlasRowForState } from "./PetAtlasAnimated.jsx";

describe("PetAtlasAnimated", () => {
  it("maps live data states to distinct atlas actions", () => {
    expect(petAtlasRowForState("working-thinking")).toBe("review");
    expect(petAtlasRowForState("working-juggling")).toBe("running");
    expect(petAtlasRowForState("working-overheated")).toBe("failed");
    expect(petAtlasRowForState("happy")).toBe("jumping");
    expect(petAtlasRowForState("sleeping")).toBe("waiting");
  });

  it("loads the selected character's independent sprite atlas", () => {
    const { container } = render(<PetAtlasAnimated character="byte" state="happy" size={208} />);
    const sprite = container.firstElementChild;
    expect(sprite).toHaveStyle({
      width: "192px",
      height: "208px",
      backgroundImage: "url(/pets/byte/spritesheet.webp)",
      backgroundSize: "800% 900%",
    });
  });

  it("maps all 16 V2 look directions across rows 9 and 10", () => {
    const pet = {
      id: "samara-v2",
      spriteVersionNumber: 2,
      assetUrl: "/api/pets/local/samara-v2/spritesheet.webp",
    };
    const { container, rerender } = render(
      <PetAtlasAnimated character={pet.id} pet={pet} lookDirectionIndex={0} size={208} />,
    );
    expect(container.firstElementChild).toHaveStyle({
      backgroundImage: "url(/api/pets/local/samara-v2/spritesheet.webp)",
      backgroundSize: "800% 1100%",
      backgroundPosition: "0% 90%",
    });
    rerender(<PetAtlasAnimated character={pet.id} pet={pet} lookDirectionIndex={15} size={208} />);
    expect(container.firstElementChild).toHaveStyle({
      backgroundPosition: "100% 100%",
    });
    rerender(
      <PetAtlasAnimated character={pet.id} pet={pet} state="happy" lookDirectionIndex={15} size={208} />,
    );
    expect(container.firstElementChild).toHaveStyle({
      backgroundPosition: "0% 40%",
    });
  });

  it("uses the directional running row while a desktop drag is active", () => {
    const { container } = render(
      <PetAtlasAnimated
        character="byte"
        state="idle-living"
        dragState="running-left"
        size={208}
      />,
    );
    expect(container.firstElementChild).toHaveStyle({
      backgroundPosition: "0% 25%",
    });
  });
});
