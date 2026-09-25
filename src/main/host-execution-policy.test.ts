import { describe, expect, it, vi } from "vitest";
import {
  ExecutionPolicyRegistry,
  UNLIMITED_EXECUTION_POLICY,
  executionPolicyRefusal,
  mergeExecutionPolicies,
  normalizeAllowedHost,
} from "./host-execution-policy.js";
import { extensionServices, type HostExtensionServices } from "./host-extensions.js";

describe("execution policy", () => {
  it("is unlimited without a limiting rule", () => {
    expect(mergeExecutionPolicies([])).toEqual(UNLIMITED_EXECUTION_POLICY);
    expect(mergeExecutionPolicies([{ source: "a", rule: { network: "any", allowHosts: ["example.com"] } }])).toEqual(UNLIMITED_EXECUTION_POLICY);
  });

  it("keeps the strictest: loopback wins, and only hosts every limiting rule allows", () => {
    const merged = mergeExecutionPolicies([
      { source: "a", rule: { network: "loopback", allowHosts: ["registry.npmjs.org", "*.GitHub.com", "pypi.org"], reason: "A limits." } },
      { source: "b", rule: { network: "any", allowHosts: ["evil.example"] } },
      { source: "c", rule: { network: "loopback", allowHosts: ["pypi.org", "*.github.com."], reason: " C limits. " } },
    ]);
    expect(merged).toEqual({ network: "loopback", allowHosts: ["*.github.com", "pypi.org"], reasons: ["A limits.", "C limits."], sources: ["a", "c"] });
  });

  it("takes host names and *.domain only", () => {
    expect(normalizeAllowedHost(" Registry.NPMJS.org ")).toBe("registry.npmjs.org");
    expect(normalizeAllowedHost("*.packagist.org")).toBe("*.packagist.org");
    for (const bad of ["*", "https://github.com", "github.com:443", "a..b", "*.*.x", "", 12, "white space.com"]) expect(normalizeAllowedHost(bad)).toBeUndefined();
  });

  it("names the reasons when a runtime cannot hold a limit, and nothing without one", () => {
    expect(executionPolicyRefusal(undefined, "Cursor")).toBeUndefined();
    expect(executionPolicyRefusal(UNLIMITED_EXECUTION_POLICY, "Cursor")).toBeUndefined();
    const refusal = executionPolicyRefusal({ network: "loopback", allowHosts: [], reasons: ["This project deploys to a server."], sources: ["x"] }, "Cursor");
    expect(refusal).toMatch(/^This project deploys to a server\. Cursor cannot enforce that limit/u);
  });
});

describe("ExecutionPolicyRegistry", () => {
  it("merges every provider's rule for the folder it is asked about", async () => {
    const registry = new ExecutionPolicyRegistry();
    registry.forExtension("tau.one").provide((cwd) => (cwd === "/server" ? { network: "loopback", allowHosts: ["pypi.org"], reason: "One." } : undefined));
    registry.forExtension("tau.two").provide(async () => ({ network: "any" }));
    expect(await registry.for("/plain")).toEqual(UNLIMITED_EXECUTION_POLICY);
    expect(await registry.for("/server")).toEqual({ network: "loopback", allowHosts: ["pypi.org"], reasons: ["One."], sources: ["tau.one"] });
  });

  it("limits a folder whose provider fails, and logs it", async () => {
    const log = vi.fn();
    const registry = new ExecutionPolicyRegistry(log);
    registry.forExtension("tau.broken").provide(() => { throw new Error("disk gone"); });
    const policy = await registry.for("/any");
    expect(policy.network).toBe("loopback");
    expect(policy.allowHosts).toEqual([]);
    expect(policy.reasons[0]).toContain("disk gone");
    expect(log).toHaveBeenCalledWith("execution-policy.provider-failed", "tau.broken: disk gone");
  });

  it("keeps one provider per extension and tells observers about changes", async () => {
    const registry = new ExecutionPolicyRegistry();
    const facade = registry.forExtension("tau.one");
    const heard: unknown[] = [];
    const stop = registry.forExtension("tau.reader").observe((change) => heard.push(change));
    facade.provide(() => ({ network: "loopback" }));
    const withdraw = facade.provide(() => ({ network: "loopback", allowHosts: ["pypi.org"] }));
    expect((await registry.for("/x")).allowHosts).toEqual(["pypi.org"]);
    facade.changed("/x");
    withdraw();
    expect(await registry.for("/x")).toEqual(UNLIMITED_EXECUTION_POLICY);
    stop();
    facade.changed();
    expect(heard).toEqual([{ source: "tau.one" }, { source: "tau.one" }, { source: "tau.one", cwd: "/x" }, { source: "tau.one" }]);
  });

  it("gives each extension a facade that speaks for its own id", async () => {
    const registry = new ExecutionPolicyRegistry();
    const services = { executionPolicy: registry, log: () => undefined, cwd: () => "/" } as unknown as HostExtensionServices;
    const one = extensionServices(services, { id: "tau.one", permissions: ["workspace:read"] });
    one.executionPolicy!.provide(() => ({ network: "loopback" }));
    expect((await registry.for("/")).sources).toEqual(["tau.one"]);
    const denied = extensionServices(services, { id: "tau.none", permissions: [] });
    expect(() => denied.executionPolicy).toThrow("lacks permission workspace:read");
  });
});
