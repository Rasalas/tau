// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { expectKitActivatesCleanly } from "../test-support/kit-harness";
import { bundledExtensions } from "./index";

afterEach(cleanup);

describe("bundled kits", () => {
  for (const extension of bundledExtensions) {
    it(`${extension.id} activates into core slots and leaves nothing behind`, async () => {
      await expect(expectKitActivatesCleanly(extension)).resolves.toBeUndefined();
    });
  }
});
