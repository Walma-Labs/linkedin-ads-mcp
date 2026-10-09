import { describe, it, expect } from "vitest";
import { defaultRange, derive, epochMs, idOf, label, restliDate, restliList, targetingCriteria } from "../src/logic.js";
import { assertPublicImageUrl, isPrivateAddress } from "../src/server.js";

describe("logic", () => {
  it("encodes Rest.li lists and dates", () => {
    expect(restliList(["urn:li:sponsoredAccount:1", 2])).toBe("List(urn%3Ali%3AsponsoredAccount%3A1,2)");
    expect(restliDate("2026-01-05")).toBe("(year:2026,month:1,day:5)");
  });

  it("derives CTR, CPC, CPM and cost per lead", () => {
    const r = derive({ impressions: 1000, clicks: 10, costInLocalCurrency: 500, oneClickLeads: 2 });
    expect(r).toMatchObject({ ctr: 0.01, cpc: 50, cpm: 500, costPerConversionOrLead: 250 });
    expect(derive({ impressions: 0, clicks: 0, costInLocalCurrency: 0 })).toMatchObject({ ctr: 0, cpc: null, cpm: null });
  });

  it("labels standard taxonomies and named URNs", () => {
    expect(label("urn:li:function:13")).toBe("Information Technology");
    expect(label("urn:li:seniority:8")).toBe("CXO");
    expect(label("urn:li:sponsoredCampaign:9", { "urn:li:sponsoredCampaign:9": "Q4" })).toBe("Q4");
  });

  it("handles ids, ranges and epoch dates", () => {
    expect(idOf("urn:li:sponsoredCampaign:123")).toBe("123");
    expect(defaultRange(28, new Date("2026-10-09T12:00:00Z"))).toEqual({ start: "2026-09-11", end: "2026-10-08" });
    expect(epochMs("2026-10-20")).toBe(Date.UTC(2026, 9, 20));
  });

  it("builds targeting criteria and rejects unknown facets", () => {
    expect(targetingCriteria({ locations: ["urn:li:geo:1"], titles: ["urn:li:title:2"] }, { employers: ["urn:li:organization:3"] })).toEqual({
      include: { and: [
        { or: { "urn:li:adTargetingFacet:locations": ["urn:li:geo:1"] } },
        { or: { "urn:li:adTargetingFacet:titles": ["urn:li:title:2"] } },
      ] },
      exclude: { or: { "urn:li:adTargetingFacet:employers": ["urn:li:organization:3"] } },
    });
    expect(() => targetingCriteria({ nope: ["x"] })).toThrow(/Unknown targeting facet/);
  });

  it("classifies private addresses", () => {
    for (const ip of ["10.0.0.4", "127.0.0.1", "169.254.169.254", "192.168.1.1", "172.20.0.1", "100.64.0.1", "::1", "fd00::1", "::ffff:10.1.2.3"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["104.21.3.4", "8.8.8.8", "2606:4700::1"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("rejects non-public image URLs without touching the network", async () => {
    for (const bad of ["http://walma.ai/a.png", "https://localhost/a", "https://10.0.0.4/a", "https://169.254.169.254/x",
      "https://ca-mcp-orange.internal.yellowhill.swedencentral.azurecontainerapps.io/x", "https://[::1]/a", "https://printer.local/a"]) {
      await expect(assertPublicImageUrl(bad), bad).rejects.toThrow();
    }
  });
});
