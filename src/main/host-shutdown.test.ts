import { expect, it, vi } from "vitest";
import { createHostShutdown } from "./host-shutdown.js";

it("finishes disposal before closing sockets and shares shutdown across repeated requests", async () => {
  let release = (): void => undefined;
  const disposing = new Promise<void>((resolve) => { release = resolve; });
  let entered = (): void => undefined;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const dispose = vi.fn(() => { entered(); return disposing; });
  const finish = vi.fn(async (_code: number) => undefined);
  const shutdown = createHostShutdown(dispose, finish);

  const first = shutdown(75);
  await started;
  const repeated = shutdown();
  try {
    expect(finish).not.toHaveBeenCalled();
    expect(repeated).toBe(first);
    expect(dispose).toHaveBeenCalledOnce();
  } finally {
    release();
    await Promise.all([first, repeated]);
  }
  expect(finish).toHaveBeenCalledExactlyOnceWith(75);
  expect(shutdown()).toBe(first);
  expect(dispose).toHaveBeenCalledOnce();
});

it("shares shutdown when disposal itself requests it again", async () => {
  let repeated: Promise<void> | undefined;
  const dispose = vi.fn(async () => { repeated = shutdown(); });
  const finish = vi.fn(async (_code: number) => undefined);
  const shutdown = createHostShutdown(dispose, finish);

  const first = shutdown(75);
  await first;
  expect(repeated).toBe(first);
  expect(dispose).toHaveBeenCalledOnce();
  expect(finish).toHaveBeenCalledExactlyOnceWith(75);
});
