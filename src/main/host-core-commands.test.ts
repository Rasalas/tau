import { describe, expect, expectTypeOf, it } from "vitest";
import { HOST_CORE_COMMANDS } from "../shared/host-core-commands.js";
import type { HostCommandArgs, HostCommandClient, HostCommandResult } from "../shared/host-command-definition.js";
import type { HostActionResult } from "../shared/host-protocol.js";
import type { TauConfig } from "../shared/contracts.js";
import { bindHostCommand } from "./host-command-handler.js";
import { NO_JOB_CONTEXT } from "./host-jobs.js";

describe("core host command contracts", () => {
  it("keeps optional wire fields distinct from normalized decoder values", () => {
    const decoded = HOST_CORE_COMMANDS["desktop-extensions"].decode(["workspace", {}, undefined, ["a".repeat(32)]]);
    expect(decoded).toEqual(["workspace", {}, undefined, new Set(["a".repeat(32)])]);
    expect(HOST_CORE_COMMANDS["update-config"].decode([{}, undefined])).toEqual([{}, "global", undefined]);
    // Old clients' unknown scopes have always selected the global layer.
    expect(HOST_CORE_COMMANDS["clear-config"].decode([["model"], "other"])[1]).toBe("global");
    expectTypeOf<HostCommandArgs<typeof HOST_CORE_COMMANDS["desktop-extensions"]>>()
      .toEqualTypeOf<[cwd: string, sharedExports: Record<string, string[]>, only?: readonly string[], held?: readonly string[]]>();
    expectTypeOf<HostCommandArgs<typeof HOST_CORE_COMMANDS["update-config"]>>()
      .toEqualTypeOf<[patch: Partial<TauConfig>, scope?: "global" | "project", workspaceId?: string]>();
  });

  it("validates before invoking a typed implementation", async () => {
    const received: string[] = [];
    const copy = bindHostCommand(HOST_CORE_COMMANDS["copy-text"], async ([text]) => { received.push(text); });
    await expect(copy([42], NO_JOB_CONTEXT)).rejects.toThrow('copy-text: text must be a non-empty string');
    expect(received).toEqual([]);
    await copy(["hello"], NO_JOB_CONTEXT);
    expect(received).toEqual(["hello"]);
  });

  it("keeps extension payloads opaque while validating routing names", () => {
    const payload = { custom: [1, null, { nested: true }] };
    expect(HOST_CORE_COMMANDS["host-extension"].decode(["tau.test", "read", payload])[2]).toBe(payload);
    expect(() => HOST_CORE_COMMANDS["host-extension"].decode(["tau.test", "", payload])).toThrow();
  });

  it("declares jobs and owner-only runtime changes beside their decoders", () => {
    expect(HOST_CORE_COMMANDS["rebuild-workbench"].job).toBe(true);
    expect(HOST_CORE_COMMANDS["runtime-tools"].access).toBe("read");
    expect(HOST_CORE_COMMANDS["runtime-tools-change"].access).toBe("owner");
    expect(HOST_CORE_COMMANDS["fork-thread"].audit).toEqual({ label: "forked a thread", thread: 1 });
    expect(() => HOST_CORE_COMMANDS["runtime-tools-change"].decode(["refresh", {}])).toThrow();
  });

  it("derives argument and result types for clients and host implementations", () => {
    expectTypeOf<HostCommandResult<typeof HOST_CORE_COMMANDS["set-model"]>>().toEqualTypeOf<HostActionResult>();
    expectTypeOf<HostCommandClient<typeof HOST_CORE_COMMANDS["copy-text"]>>().toEqualTypeOf<(text: string) => Promise<void>>();
    // Type-only assertions are never executed.
    const typecheck = (copy: HostCommandClient<typeof HOST_CORE_COMMANDS["copy-text"]>) => {
      // @ts-expect-error The declaration requires text, not an arbitrary payload.
      void copy({ text: "hello" });
      // @ts-expect-error Host handlers must return the command's declared result.
      bindHostCommand(HOST_CORE_COMMANDS["copy-text"], () => "unexpected result");
    };
    expect(typeof typecheck).toBe("function");
  });
});
