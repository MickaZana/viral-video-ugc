import { describe, expect, it } from "vitest";
import { renderPrivacyPolicy, renderTerms } from "./legal.js";

const identity = { entityName: "Example AB", privacyEmail: "privacy@example.test", address: "Stockholm, Sweden" };

describe("OAuth-facing legal pages", () => {
  it("privacy policy identifies the controller, YouTube scopes, revocation, deletion and GDPR DSR rights", () => {
    const html = renderPrivacyPolicy(identity);
    expect(html).toContain("Example AB");
    expect(html).toContain("privacy@example.test");
    expect(html).toContain("youtube.upload");
    expect(html).toContain("youtube.readonly");
    expect(html).toContain("Google Security Settings");
    expect(html).toContain("seven calendar days");
    expect(html).toContain("Data Subject Request");
    expect(html).toContain("within one month");
  });

  it("terms link YouTube's terms and the product privacy policy", () => {
    const html = renderTerms(identity);
    expect(html).toContain("https://www.youtube.com/t/terms");
    expect(html).toContain("href=\"/privacy\"");
    expect(html).toContain("human reviewer");
  });
});
