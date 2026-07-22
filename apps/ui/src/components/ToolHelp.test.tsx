import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IconButton } from "./IconButton";
import { ToolRow } from "./ToolRow";

describe("tool help", () => {
  it("lets IconButton use detailed hover text without changing the accessible name", () => {
    const html = renderToStaticMarkup(
      <IconButton icon={<span aria-hidden="true">x</span>} label="Save" tooltip="Write changes to the current PDF." />,
    );

    expect(html).toContain('aria-label="Save"');
    expect(html).toContain('title="Write changes to the current PDF."');
  });

  it("adds ToolRow descriptions as hover help without changing the visible label", () => {
    const html = renderToStaticMarkup(
      <ToolRow
        icon={<span aria-hidden="true">x</span>}
        label="Batch Cleanup"
        description="Clean several local PDFs at once."
        selected
        onHelp={() => undefined}
      />,
    );

    expect(html).toContain(">Batch Cleanup</span>");
    expect(html).toContain('title="Clean several local PDFs at once."');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('aria-label="Help: Batch Cleanup"');
  });

  it("keeps locked experimental tools operable with an accessible activation explanation", () => {
    const html = renderToStaticMarkup(
      <ToolRow icon={<span />} label="Edit Text" experimental locked onSelect={() => undefined} />,
    );
    expect(html).toContain("Experimental</span>");
    expect(html).toContain("Enable it in Settings");
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toMatch(/\sdisabled(?:=|\s|>)/);
  });

  it("gives separately rendered locked rows unique accessible descriptions and visible tooltips", () => {
    const html = renderToStaticMarkup(
      <>
        <ToolRow icon={<span />} label="Edit Text" experimental locked onSelect={() => undefined} />
        <ToolRow icon={<span />} label="Case Caption" experimental locked onSelect={() => undefined} />
      </>,
    );
    const ids = [...html.matchAll(/id="(experimental-feature-locked-description-[^"]+)"/g)].map((match) => match[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(html).toContain('role="tooltip"');
  });
});
