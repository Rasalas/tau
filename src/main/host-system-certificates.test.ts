import { describe, expect, it, vi } from "vitest";
import { useHostSystemCertificates } from "./host-system-certificates.js";

describe("host certificate trust", () => {
  it("adds OS-trusted roots without dropping bundled or explicitly configured roots", () => {
    const getCACertificates = vi.fn((type?: string) => type === "system" ? ["system", "bundled"] : ["bundled", "extra"]);
    const setDefaultCACertificates = vi.fn();
    expect(useHostSystemCertificates({ getCACertificates, setDefaultCACertificates })).toBe(true);
    expect(getCACertificates.mock.calls).toEqual([["default"], ["system"]]);
    expect(setDefaultCACertificates).toHaveBeenCalledWith(["bundled", "extra", "system"]);
  });
  it("does not change TLS defaults on older standalone runtimes", () => {
    expect(useHostSystemCertificates({})).toBe(false);
    const setDefaultCACertificates = vi.fn();
    expect(useHostSystemCertificates({ setDefaultCACertificates })).toBe(false);
    expect(setDefaultCACertificates).not.toHaveBeenCalled();
  });
});
