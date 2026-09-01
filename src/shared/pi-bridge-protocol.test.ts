import { describe, expect, it } from "vitest";
import {
  encodePiBridgeFrame,
  PI_BRIDGE_CLIENT_CAPABILITIES,
  PI_BRIDGE_PROTOCOL_VERSION,
  transcriptPagingNegotiated,
  type PiBridgeClientFrame,
} from "./pi-bridge-protocol.js";

describe("Pi bridge paging negotiation", () => {
  it("keeps legacy v1 semantics unless the host explicitly advertises paging", () => {
    const legacyHello: PiBridgeClientFrame = {
      protocolVersion: PI_BRIDGE_PROTOCOL_VERSION,
      type: "hello",
      id: "legacy",
      epoch: "epoch",
      token: "token",
      expectedSessionId: "thread",
    };
    const pagedHello: PiBridgeClientFrame = {
      ...legacyHello,
      id: "paged",
      capabilities: PI_BRIDGE_CLIENT_CAPABILITIES,
    };

    expect(transcriptPagingNegotiated(legacyHello.capabilities)).toBe(false);
    expect(transcriptPagingNegotiated({ transcriptPaging: false })).toBe(false);
    expect(transcriptPagingNegotiated(pagedHello.capabilities)).toBe(true);
    expect(JSON.parse(encodePiBridgeFrame(legacyHello))).toEqual(legacyHello);
  });

  it("does not interpret unknown capability values as paging support", () => {
    expect(transcriptPagingNegotiated({ transcriptPaging: "true" as unknown as boolean })).toBe(false);
    expect(transcriptPagingNegotiated({ transcriptPaging: undefined })).toBe(false);
  });
});
