// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TestProviders } from "../test-support/test-providers";
import { PairingRequestDialog } from "./PairingRequestDialog";

afterEach(cleanup);

it("identifies the website asking to pair alongside the claimed device name", async () => {
  render(<TestProviders><PairingRequestDialog
    request={{
      id: "r1", name: "Tau", device: { kind: "desktop", browser: "Chrome", os: "macOS" },
      address: "127.0.0.1", origin: "http://localhost:7788", verification: "482913", access: "full",
      createdAt: "2026-10-13T10:00:00Z", expiresAt: "2026-10-13T10:02:00Z",
    }}
    onAllow={vi.fn()} onDeny={vi.fn()} onClose={vi.fn()}
  /></TestProviders>);
  expect(await screen.findByText("Tau wants to connect")).toBeTruthy();
  expect(await screen.findByText("Website: http://localhost:7788")).toBeTruthy();
  expect(await screen.findByText("482 913")).toBeTruthy();
});
