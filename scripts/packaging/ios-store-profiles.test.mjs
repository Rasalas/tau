import { describe, expect, it } from "vitest";
import { GROUP, pickCertificate, profileEntitlements } from "./ios-store-profiles.mjs";

// Synthetic data only; no Apple account or real profile is read.
const plist = (groups) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Name</key><string>Tau</string>
  <key>Entitlements</key>
  <dict>
    <key>application-identifier</key><string>V4MWQ28RZ2.de.tbuck.tau.widgets</string>
    ${groups ? `<key>com.apple.security.application-groups</key><array><string>${GROUP}</string></array>` : ""}
    <key>keychain-access-groups</key><array><string>V4MWQ28RZ2.*</string></array>
  </dict>
</dict></plist>`;
const signed = (text) => Buffer.concat([Buffer.from([0x30, 0x82, 0x2f, 0xaa, 0x06, 0x09]), Buffer.from(text), Buffer.from([0xa0, 0x82, 0x0d])]);
const certificate = (id, type, expirationDate) => ({ id, attributes: { certificateType: type, serialNumber: `S${id}`, expirationDate } });

describe("ios-store-profiles", () => {
  it("reads the App Groups a signed profile allows", () => {
    expect(profileEntitlements(signed(plist(true)))).toEqual({ applicationIdentifier: "V4MWQ28RZ2.de.tbuck.tau.widgets", appGroups: [GROUP] });
    expect(profileEntitlements(signed(plist(false))).appGroups).toEqual([]);
  });

  it("signs with the one valid distribution certificate, or the one named", () => {
    const now = new Date("2026-10-01");
    const list = [certificate("a", "DISTRIBUTION", "2027-06-05T00:00:00Z"), certificate("b", "DEVELOPMENT", "2027-01-01T00:00:00Z"), certificate("c", "DISTRIBUTION", "2026-01-01T00:00:00Z")];
    expect(pickCertificate(list, undefined, now).id).toBe("a");
    expect(pickCertificate(list, "Sa", now).id).toBe("a");
    expect(() => pickCertificate(list, "c", now)).toThrow();
    expect(() => pickCertificate([...list, certificate("d", "IOS_DISTRIBUTION", "2027-02-01T00:00:00Z")], undefined, now)).toThrow(/pass --certificate/u);
  });
});
