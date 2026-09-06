// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { expectKitActivatesCleanly } from "../src/renderer/test-support/kit-harness.js";
import access from "./access/desktop.js";
import serviceTier from "./service-tier/desktop.js";
import titleGenerator from "./thread-titles/desktop.js";
import worktreeNames from "./worktree-names/desktop.js";

// Every kit under `kits/` fills core slots and gives them all back. Add the
// kit's default export here when you move one; the shape of this list is the
// point, not its length.
const kits = [access, serviceTier, titleGenerator, worktreeNames];

afterEach(cleanup);

describe("packaged kits", () => {
  for (const extension of kits) {
    it(`${extension.id} activates into core slots and leaves nothing behind`, async () => {
      await expect(expectKitActivatesCleanly(extension)).resolves.toBeUndefined();
    });
  }
});
