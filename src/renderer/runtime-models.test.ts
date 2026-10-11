import { describe, expect, it } from "vitest";
import type { HostSnapshot } from "../shared/contracts";
import { listRuntimeModels } from "./runtime-models";

const backends = [{ kind: "pi", label: "Pi" }, { kind: "codex", label: "Codex", disabled: true }, { kind: "cursor", label: "Cursor" }];

describe("listRuntimeModels", () => {
  it("leaves out a runtime the project turned off, so the palette cannot start a thread there", async () => {
    const listed = await listRuntimeModels(undefined, backends, undefined);
    expect(listed.map((entry) => entry.backend.kind)).toEqual(["pi", "cursor"]);
  });

  it("keeps the runtime of the thread on screen, which is only read", async () => {
    const listed = await listRuntimeModels(undefined, backends, { backendKind: "codex", models: [] } as unknown as HostSnapshot);
    expect(listed.map((entry) => entry.backend.kind)).toEqual(["pi", "codex", "cursor"]);
  });
});
