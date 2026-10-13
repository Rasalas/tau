import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const updaterRequire = createRequire(require.resolve("electron-updater/package.json"));
const { HttpExecutor } = updaterRequire("builder-util-runtime") as typeof import("builder-util-runtime");

describe("updater redirect credentials", () => {
  it.each(["PRIVATE-TOKEN", "Private-Token", "Authorization", "aUtHoRiZaTiOn"])("strips %s on a cross-origin redirect", (header) => {
    const redirected = HttpExecutor.prepareRedirectUrlOptions("https://downloads.example.invalid/Tau.exe", {
      protocol: "https:", hostname: "releases.example.invalid", path: "/Tau.exe",
      headers: { [header]: "test-token", Accept: "application/octet-stream" },
    });
    expect(redirected.headers).not.toHaveProperty(header);
    expect(redirected.headers).toMatchObject({ Accept: "application/octet-stream" });
  });

  it("keeps authentication on a same-origin redirect", () => {
    const redirected = HttpExecutor.prepareRedirectUrlOptions("https://releases.example.invalid/files/Tau.exe", {
      protocol: "https:", hostname: "releases.example.invalid", path: "/Tau.exe",
      headers: { "PRIVATE-TOKEN": "test-token", Authorization: "Bearer test-token" },
    });
    expect(redirected.headers).toMatchObject({ "PRIVATE-TOKEN": "test-token", Authorization: "Bearer test-token" });
  });
});
