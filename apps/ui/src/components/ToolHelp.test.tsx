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
});
