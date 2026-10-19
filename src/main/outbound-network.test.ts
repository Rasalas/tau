import { getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { expect, it } from "vitest";
import { configureOutboundNetwork } from "./outbound-network.js";

it.each([[50, 1000], [5000, 5000]])("uses a connection timeout floor while preserving %i ms", (initial, expected) => {
  const previous = getDefaultAutoSelectFamilyAttemptTimeout();
  try {
    setDefaultAutoSelectFamilyAttemptTimeout(initial);
    configureOutboundNetwork();
    expect(getDefaultAutoSelectFamilyAttemptTimeout()).toBe(expected);
  } finally {
    setDefaultAutoSelectFamilyAttemptTimeout(previous);
  }
});
