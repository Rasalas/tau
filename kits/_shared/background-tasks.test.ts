import { expect, it } from "vitest";
import { BackgroundTasks } from "./background-tasks.js";

it("does not let an old turn acknowledge a newer result with the same task ID", () => {
  const work = new BackgroundTasks();
  work.start({ id: "build", kind: "command", label: "First build" });
  work.report("build");
  const first = work.snapshot();
  work.start({ id: "build", kind: "command", label: "Second build" });
  work.report("build");
  expect(work.handled(first)).toBe(false);
  expect(work.current()[0]?.label).toBe("Second build");
  expect(work.handled(work.snapshot())).toBe(true);
  expect(work.current()).toEqual([]);
});

it("holds ordinary commands by default and allows only a running command to become an independent service", () => {
  const work = new BackgroundTasks();
  work.start({ id: "watch", kind: "monitor", label: "Watch PR" });
  expect(() => work.release("watch")).toThrow("Only a checked command");
  work.start({ id: "server", kind: "command", label: "Devserver" });
  work.release("server");
  work.report("server");
  expect(work.current().map((task) => task.id)).toEqual(["watch"]);
  work.report("watch");
  expect(work.current()[0]?.state).toBe("reported");
});
