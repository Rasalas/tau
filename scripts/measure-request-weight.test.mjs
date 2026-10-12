import { expect, it } from "vitest";
import { summary, weigh } from "./measure-request-weight.mjs";

it("counts the system prompt and each tool declaration of a request", () => {
  const tool = { type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object" } } };
  const weight = weigh({ messages: [{ role: "system", content: "x".repeat(40) }, { role: "user", content: "hi" }], tools: [tool, { ...tool, function: { ...tool.function, name: "bash" } }] });
  expect(weight).toMatchObject({ systemChars: 40, toolCount: 2, tools: [{ name: "read" }, { name: "bash" }] });
  expect(weight.toolChars).toBe(JSON.stringify(tool).length * 2);
  expect(summary(weight)).toMatchObject({ systemTokens: 10, totalTokens: Math.ceil(weight.totalChars / 4) });
});

it("reads a body without tools or a system message as empty", () => {
  expect(weigh({ messages: [{ role: "user", content: "hi" }] })).toMatchObject({ systemChars: 0, toolCount: 0, toolChars: 0 });
  expect(weigh(undefined).totalChars).toBe(0);
});
