import { afterEach, expect, it } from "vitest";
import { hostConnectionState, setHostClient } from "./host-client-context";
import { createFakeHostClient } from "./test-support/fake-host-client";

afterEach(() => setHostClient(undefined));

it("reads the current ambient connection, including before extension activation and after a switch", () => {
  expect(hostConnectionState()).toBeUndefined();
  setHostClient(createFakeHostClient({ getConnectionState: () => "reconnecting" }));
  expect(hostConnectionState()).toBe("reconnecting");
  setHostClient(createFakeHostClient({ getConnectionState: () => "connected" }));
  expect(hostConnectionState()).toBe("connected");
});
