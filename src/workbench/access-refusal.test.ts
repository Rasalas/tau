import { describe, expect, it } from "vitest";
import { ACCESS_CLOSE_REASON } from "../shared/connections";
import { accessRefusal } from "./access-refusal";

describe("accessRefusal", () => {
  it("says what to do next in words a person who never saw a console can follow", () => {
    for (const reason of [ACCESS_CLOSE_REASON.revoked, ACCESS_CLOSE_REASON.rotated, ACCESS_CLOSE_REASON.unauthorized]) {
      expect(accessRefusal(reason)).not.toMatch(/\bhost\b|token|~\/|\.tau/iu);
    }
    expect(accessRefusal(ACCESS_CLOSE_REASON.revoked)).toMatch(/Settings → Connections/u);
    expect(accessRefusal(ACCESS_CLOSE_REASON.rotated)).toMatch(/new key/u);
  });
});
