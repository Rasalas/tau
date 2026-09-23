import { describe, expect, it } from "vitest";
import type { ExtensionUiAnswer } from "../shared/contracts.js";
import { askElicitation, elicitationFields } from "./elicitation-form.js";
import type { BackendPrompt } from "./host-extensions.js";

const schema = {
  type: "object",
  properties: {
    repo: { type: "string", title: "Repository", description: "owner/name", minLength: 3 },
    count: { type: "integer", title: "How many", minimum: 1, maximum: 5, default: 2 },
    draft: { type: "boolean", title: "Open as draft" },
    env: { type: "string", title: "Environment", oneOf: [{ const: "stg", title: "Staging" }, { const: "prd", title: "Production" }] },
    legacy: { type: "string", enum: ["a", "b"], enumNames: ["Alpha", "Beta"] },
    tags: { type: "array", title: "Tags", items: { anyOf: [{ const: "bug", title: "Bug" }, { const: "ui", title: "UI" }, { const: "perf", title: "Speed" }] } },
    note: { type: "string", title: "Note" },
  },
  required: ["repo", "draft", "env"],
};

function script(answers: ExtensionUiAnswer[]) {
  const asked: BackendPrompt[] = [];
  return {
    asked,
    ask: async (prompt: BackendPrompt): Promise<ExtensionUiAnswer> => {
      asked.push(prompt);
      return answers.shift() ?? { cancelled: true };
    },
  };
}

describe("elicitationFields", () => {
  it("reads every field kind MCP allows, in order, with what is required", () => {
    const fields = elicitationFields(schema)!;
    expect(fields.map((field) => [field.key, field.kind, field.required])).toEqual([
      ["repo", "text", true], ["count", "integer", false], ["draft", "boolean", true], ["env", "choice", true],
      ["legacy", "choice", false], ["tags", "choices", false], ["note", "text", false],
    ]);
    expect(fields[4]!.options).toEqual([{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }]);
    expect(fields[5]!.options!.map((option) => option.label)).toEqual(["Bug", "UI", "Speed"]);
  });

  it("answers an empty form with no fields, and a field of an unknown kind with nothing", () => {
    expect(elicitationFields({ type: "object", properties: {} })).toEqual([]);
    expect(elicitationFields({ type: "object" })).toEqual([]);
    expect(elicitationFields({ properties: { blob: { type: "object" } } })).toBeUndefined();
    expect(elicitationFields(null)).toBeUndefined();
  });
});

describe("askElicitation", () => {
  it("asks one dialog per field and sends the content in the schema's own values", async () => {
    const { asked, ask } = script([
      { value: "acme/demo" }, { value: "" }, { value: "No" }, { value: "Production" }, { cancelled: true }, { value: "1, 3" }, { value: "  " },
    ]);
    const tagged: number[] = [];
    const outcome = await askElicitation({ source: "github", message: "Where should the PR go?", fields: elicitationFields(schema)!, ask, decorate: (_prompt, index) => tagged.push(index) });
    expect(outcome).toEqual({ action: "accept", content: { repo: "acme/demo", count: 2, draft: false, env: "prd", tags: ["bug", "perf"] } });
    expect(tagged).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(asked[0]).toMatchObject({ kind: "input", title: "Repository", message: "Where should the PR go?\n\nowner/name" });
    expect(asked[1]).toMatchObject({ kind: "input", title: "How many (optional)", placeholder: "2" });
    expect(asked[2]).toMatchObject({ kind: "select", options: ["Yes", "No"] });
    expect(asked[3]).toMatchObject({ kind: "select", options: ["Staging", "Production"] });
    expect(asked[5]!.title).toContain("1. Bug\n2. UI\n3. Speed");
    expect(asked[5]!.title).toContain("Where should the PR go?");
  });

  it("asks again, with the reason, when an answer does not fit, and gives up after three tries", async () => {
    const number = elicitationFields({ properties: { n: { type: "integer", minimum: 1 } }, required: ["n"] })!;
    const retried = script([{ value: "1.5" }, { value: "0" }, { value: "4" }]);
    expect(await askElicitation({ source: "s", message: "", fields: number, ask: retried.ask })).toEqual({ action: "accept", content: { n: 4 } });
    expect(retried.asked.map((prompt) => prompt.message)).toEqual([undefined, "Enter a whole number.", "Enter at least 1."]);

    const stubborn = script([{ value: "x" }, { value: "y" }, { value: "z" }]);
    expect(await askElicitation({ source: "s", message: "", fields: number, ask: stubborn.ask })).toEqual({ action: "decline" });
  });

  it("declines when a required field is skipped, or every field is", async () => {
    const fields = elicitationFields(schema)!;
    expect(await askElicitation({ source: "s", message: "", fields, ask: script([{ cancelled: true }]).ask })).toEqual({ action: "decline" });
    const optional = elicitationFields({ properties: { a: { type: "string" }, b: { type: "boolean" } } })!;
    expect(await askElicitation({ source: "s", message: "", fields: optional, ask: script([{ cancelled: true }, { cancelled: true }]).ask })).toEqual({ action: "decline" });
  });

  it("reads typed words for a choice and a yes or no", async () => {
    const fields = elicitationFields({ properties: { env: schema.properties.env, ok: { type: "boolean" } }, required: ["env", "ok"] })!;
    const typed = script([{ value: "staging", typed: true }, { confirmed: true }]);
    expect(await askElicitation({ source: "s", message: "", fields, ask: typed.ask })).toEqual({ action: "accept", content: { env: "stg", ok: true } });
  });
});
