import { describe, expect, it } from "vitest";
import { grokAgentArgs, grokAuthMethod, grokEnvironment, parseGrokModels, parseGrokVersion } from "./cli.js";

describe("Grok CLI facts", () => {
  it("reads the version and the login and models `grok models` names", () => {
    expect(parseGrokVersion("grok v0.9.12 (abc)\n")).toBe("0.9.12");
    expect(parseGrokVersion("nothing")).toBeUndefined();
    expect(parseGrokModels("You are logged in with grok.com.\nDefault model: grok-4.6\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n")).toEqual({
      signedIn: true, account: "grok.com", models: [{ id: "grok-4.6", isDefault: true }, { id: "grok-4.5", isDefault: false }],
    });
    expect(parseGrokModels("You are not logged in. Run `grok login`.")).toEqual({ signedIn: false, models: [] });
    // Help text says nothing about the login.
    expect(parseGrokModels("Usage: grok [command]")).toEqual({ models: [] });
  });

  it("points the CLI at an instance's home and picks the sign-in method from the environment", () => {
    expect(grokEnvironment({ TAU_GROK_HOME: "/shadow", PATH: "/bin" })).toEqual({ TAU_GROK_HOME: "/shadow", PATH: "/bin", GROK_HOME: "/shadow" });
    expect(grokEnvironment({ PATH: "/bin" })).toEqual({ PATH: "/bin" });
    expect(grokAuthMethod({ XAI_API_KEY: "xai-1" })).toBe("xai.api_key");
    expect(grokAuthMethod({ XAI_API_KEY: " " })).toBe("cached_token");
  });

  it("starts the agent approving everything only for full access outside plan mode", () => {
    expect(grokAgentArgs("full", false)).toEqual(["agent", "--always-approve", "stdio"]);
    expect(grokAgentArgs("full", true)).toEqual(["--permission-mode", "default", "agent", "stdio"]);
    expect(grokAgentArgs("ask", false)).toEqual(["--permission-mode", "default", "agent", "stdio"]);
    expect(grokAgentArgs("read-only", true)).toEqual(["--permission-mode", "default", "agent", "stdio"]);
  });
});
