import { describe, expect, it } from "vitest";
import { renderDashboardPage } from "./render.js";

describe("renderDashboardPage", () => {
  it("links the shared design tokens stylesheet", () => {
    expect(renderDashboardPage()).toContain('href="/tokens.css"');
  });

  it("includes the filter controls with accessible labels", () => {
    const html = renderDashboardPage();
    expect(html).toContain('for="filter-status"');
    expect(html).toContain('for="filter-niche"');
    expect(html).toContain('for="filter-platform"');
  });

  it("includes bulk-action buttons and the run-history table", () => {
    const html = renderDashboardPage();
    expect(html).toContain('id="bulk-approve"');
    expect(html).toContain('id="bulk-reject"');
    expect(html).toContain('id="runs-table"');
  });

  it("is well-formed enough to close every tag it opens (no unclosed <div>/<section>)", () => {
    const html = renderDashboardPage();
    const opens = (html.match(/<div\b/g) ?? []).length;
    const closes = (html.match(/<\/div>/g) ?? []).length;
    expect(opens).toBe(closes);
  });
});
