import { describe, expect, it } from "vitest";
import { encodeConnectOffer } from "../../shared/managed-connections";
import { browserConnectOffer, browserRelayUrl, validBrowserConnectSession } from "./offer";

const offer = { version: 1 as const, relay: "https://relay.example", id: "12345678-1234-1234-1234-123456789abc", token: "r".repeat(43), link: `https://host.local:7788/path?keep=1#pair=code&pk=${"AB".repeat(32)}&host=id&name=Mini&ca=https://host.local:7788/` };
describe("browser Connect offers", () => {
  it("retains the inner host path, query and exact pin while keeping relay secrets out of URLs", () => {
    const parsed = browserConnectOffer(encodeConnectOffer(offer))!;
    expect(parsed).toMatchObject({ code: "code", name: "Mini", route: { url: "wss://host.local:7788/path?keep=1", key: true, pin: Array(32).fill("AB").join(":") } });
    expect(browserRelayUrl(parsed.route)).toBe(`wss://relay.example/v1/browser/${offer.id}`);
    expect(validBrowserConnectSession({ route: parsed.route, token: "paired-host-token" })).toBe(true);
  });
  it("refuses insecure relays, credentials in URLs, missing pins and plaintext inner hosts", () => {
    for (const change of [{ relay: "http://relay.example" }, { relay: "https://relay.example?token=secret" }, { relay: "https://user:secret@relay.example" }, { link: "https://host.local/#pair=code" }, { link: `http://host.local/#pair=code&pk=${"AB".repeat(32)}` }]) expect(browserConnectOffer(encodeConnectOffer({ ...offer, ...change }))).toBeUndefined();
  });
  it("gives key pins priority over legacy certificate pins and never accepts a CA fallback", () => {
    const parsed = browserConnectOffer(encodeConnectOffer({ ...offer, link: `${offer.link}&fp=${"CD".repeat(32)}` }))!;
    expect(parsed.route.key).toBe(true); expect(parsed.route.pin).toBe(Array(32).fill("AB").join(":"));
    expect(browserConnectOffer(encodeConnectOffer({ ...offer, link: `https://host.example/#pair=code&ca=https://host.example/` }))).toBeUndefined();
  });
});
