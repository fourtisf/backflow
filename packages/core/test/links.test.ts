import { describe, expect, it } from "vitest";
import { cleanLink, cleanMetadata, fetchableMetadataUri, gatewayImage, ipfsPath, isPlainTicker, isPrivateIp, LINK_HOSTS, safeHref } from "../src/links";

const GW = "https://gw.example/ipfs/";
const CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";

describe("links", () => {
  it("keeps https links and enforces host rules", () => {
    expect(cleanLink("x.com/backflow", LINK_HOSTS.x)).toBe("https://x.com/backflow");
    expect(cleanLink("https://evil.com/x.com", LINK_HOSTS.x)).toBeNull();
    expect(cleanLink("http://site.io")).toBeNull();
    expect(cleanLink("javascript:alert(1)")).toBeNull();
    expect(cleanLink("data:text/html,hi")).toBeNull();
    expect(cleanLink("https://user:pw@site.io")).toBeNull();
    expect(cleanLink(1)).toBeNull();
    expect(cleanLink("https://site.io/" + "a".repeat(300))).toBeNull();
    expect(safeHref("javascript:alert(1)", "website")).toBeUndefined();
    expect(safeHref("https://t.me/abc", "telegram")).toBe("https://t.me/abc");
  });

  it("only accepts IPFS images and rewrites them to our gateway", () => {
    expect(ipfsPath(`ipfs://${CID}`)).toBe(CID);
    expect(ipfsPath(`https://other.gw/ipfs/${CID}/img.png`)).toBe(`${CID}/img.png`);
    expect(gatewayImage(`ipfs://${CID}`, GW)).toBe(GW + CID);
    expect(gatewayImage("https://tracker.example/pixel.gif", GW)).toBeNull();
    expect(gatewayImage({}, GW)).toBeNull();
  });

  it("cleans metadata of any shape without throwing", () => {
    expect(cleanMetadata({ description: 1, image: {}, twitter: 1 }, GW)).toEqual({ description: null, imageUri: null, website: null, x: null, telegram: null });
    expect(cleanMetadata(null, GW).description).toBeNull();
    expect(cleanMetadata("str", GW).imageUri).toBeNull();
    const m = cleanMetadata({ description: "hi‮there" + "z".repeat(400), image: `ipfs://${CID}`, twitter: "https://phish.io", website: "javascript:x" }, GW);
    expect(m.description).toHaveLength(280);
    expect(m.description!.includes("‮")).toBe(false);
    expect(m.imageUri).toBe(GW + CID);
    expect(m.x).toBeNull();
    expect(m.website).toBeNull();
  });

  it("only fetches https/ipfs metadata from public hosts", () => {
    expect(fetchableMetadataUri(`ipfs://${CID}`, GW)).toBe(GW + CID);
    expect(fetchableMetadataUri("https://meta.example/a.json", GW)).toBe("https://meta.example/a.json");
    expect(fetchableMetadataUri('data:application/json,{"description":1}', GW)).toBeNull();
    expect(fetchableMetadataUri("http://meta.example/a.json", GW)).toBeNull();
    expect(fetchableMetadataUri("https://127.0.0.1/a", GW)).toBeNull();
    expect(fetchableMetadataUri("https://localhost/a", GW)).toBeNull();
    expect(fetchableMetadataUri("https://meta.example:8080/a", GW)).toBeNull();
    expect(isPrivateIp("169.254.169.254")).toBe(true);
    expect(isPrivateIp("10.1.2.3")).toBe(true);
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
  });

  it("rejects lookalike tickers", () => {
    expect(isPlainTicker("BACK")).toBe(true);
    expect(isPlainTicker("ВАСК")).toBe(false); // Cyrillic
  });
});
