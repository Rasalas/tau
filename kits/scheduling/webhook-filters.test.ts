import { expect, it } from "vitest";
import { decodeWebhookFilters, matchesWebhookFilters, MAX_WEBHOOK_FILTERS, MAX_WEBHOOK_FILTER_VISITS } from "./webhook-filters.js";

it("requires every rule and compares JSON values without converting types", () => {
  const filters = decodeWebhookFilters([
    { path: "action", op: "equals", value: "completed" },
    { path: "check.id", op: "equals", value: 7 },
    { path: "check.success", op: "equals", value: false },
    { path: "check.detail", op: "equals", value: null },
  ]);
  const check = { id: 7, success: false, detail: null };
  expect(matchesWebhookFilters(filters, { action: "completed", check })).toBe(true);
  for (const payload of [
    { action: "created", check }, { action: "completed", check: { ...check, id: "7" } },
    { action: "completed", check: { ...check, success: "false" } },
    { action: "completed", check: { id: 7, success: false } },
  ]) expect(matchesWebhookFilters(filters, payload)).toBe(false);
});

it("exists means an own JSON field, including null, false, zero, empty text, objects and arrays", () => {
  const filters = decodeWebhookFilters([{ path: "field", op: "exists" }]);
  for (const field of [null, false, 0, "", {}, []]) expect(matchesWebhookFilters(filters, { field })).toBe(true);
  for (const payload of [{}, null, 0, "text", [], Object.create({ field: true })]) expect(matchesWebhookFilters(filters, payload)).toBe(false);
  expect(matchesWebhookFilters(decodeWebhookFilters([{ path: "toString", op: "exists" }]), {})).toBe(false);
  expect(matchesWebhookFilters(decodeWebhookFilters([{ path: "constructor.name", op: "exists" }]), {})).toBe(false);
  expect(matchesWebhookFilters(decodeWebhookFilters([{ path: "__proto__.polluted", op: "exists" }]), {})).toBe(false);
  expect(matchesWebhookFilters(decodeWebhookFilters([{ path: "__proto__.label", op: "equals", value: "data" }]), JSON.parse('{"__proto__":{"label":"data"}}'))).toBe(true);
});

it("reads bounded point paths and explicit array indices without walking array or string metadata", () => {
  const payload = { issue: { labels: [{ name: "bug" }], title: "text" } };
  expect(matchesWebhookFilters(decodeWebhookFilters([{ path: "issue.labels.0.name", op: "equals", value: "bug" }]), payload)).toBe(true);
  for (const path of ["issue.labels.1.name", "issue.labels.length", "issue.labels.01.name", "issue.labels.constructor", "issue.title.length", "issue.title.0"]) expect(matchesWebhookFilters(decodeWebhookFilters([{ path, op: "exists" }]), payload)).toBe(false);
  expect(matchesWebhookFilters([], undefined)).toBe(true);
});

it.each([
  null, {}, "action", Array(MAX_WEBHOOK_FILTERS + 1).fill({ path: "action", op: "exists" }),
  [null], ["action"], [{ path: "action", op: "regex", value: ".*" }],
  [{ path: "action", op: "exists", value: "ignored" }], [{ path: "action", op: "exists", extra: true }],
  [{ path: "action", op: "equals" }], [{ path: "action", op: "equals", value: {} }],
  [{ path: "action", op: "equals", value: [] }], [{ path: "action", op: "equals", value: Infinity }],
  [{ path: "action", op: "equals", value: NaN }], [{ path: "action", op: "equals", value: "x".repeat(1025) }],
  [{ path: "action", op: "equals", value: "nul\0value" }],
  ...["", " action", "action ", "action..name", ".action", "action.", "issue.labels[0].name", "action.*", "x".repeat(257), Array(17).fill("a").join(".")].map((path) => [{ path, op: "exists" }]),
].map((input) => ({ input })))("rejects malformed or unbounded filters $input", ({ input }) => {
  expect(() => decodeWebhookFilters(input)).toThrow();
});

it("accepts the documented limits and empty-string equality", () => {
  const input = Array(MAX_WEBHOOK_FILTERS).fill({ path: "x".repeat(256), op: "equals", value: "x".repeat(1024) });
  expect(decodeWebhookFilters(input)).toEqual(input);
  expect(matchesWebhookFilters(decodeWebhookFilters([{ path: "field", op: "equals", value: "" }]), { field: "" })).toBe(true);
});

it("fans out across at most two array suffixes with existential typed equality and own-field existence", () => {
  const payload = { groups: [{ labels: [{ name: null }, { name: false }, {}] }, { labels: [{ name: "bug" }, { name: 7 }] }] };
  for (const value of [null, false, "bug", 7]) expect(matchesWebhookFilters(decodeWebhookFilters([{ path: "groups[].labels[].name", op: "equals", value }]), payload)).toBe(true);
  expect(matchesWebhookFilters(decodeWebhookFilters([{ path: "groups[].labels[].name", op: "equals", value: "7" }]), payload)).toBe(false);
  for (const field of [null, false, 0, "", {}, []]) {
    expect(matchesWebhookFilters(decodeWebhookFilters([{ path: "items[].field", op: "exists" }]), { items: [{}, { field }] })).toBe(true);
  }
  for (const items of [[], [{ other: true }], null, {}, "text"]) expect(matchesWebhookFilters(decodeWebhookFilters([{ path: "items[].field", op: "exists" }]), { items })).toBe(false);
  expect(matchesWebhookFilters(decodeWebhookFilters([{ path: "items[]", op: "exists" }]), { items: [null] })).toBe(true);
  expect(matchesWebhookFilters(decodeWebhookFilters([{ path: "items[].length", op: "exists" }]), { items: [[]] })).toBe(false);
  expect(matchesWebhookFilters(decodeWebhookFilters([{ path: "groups.1.labels[].name", op: "equals", value: "bug" }]), payload)).toBe(true);
});

it.each(["[]", "items[][]", "items[].[]", "items[0]", "a[].b[].c[]", "a.[].b", "a[]x"])("rejects malformed or excessive fan-out %s", (path) => {
  expect(() => decodeWebhookFilters([{ path, op: "exists" }])).toThrow();
});

it("bounds wildcard traversal and fails closed when an adversarial payload exhausts the shared budget", () => {
  const filters = decodeWebhookFilters([{ path: "items[].value", op: "equals", value: "last" }]);
  const items = Array.from({ length: MAX_WEBHOOK_FILTER_VISITS }, () => ({ value: "other" }));
  expect(matchesWebhookFilters(filters, { items: [...items, { value: "last" }] })).toBe(false);
  expect(matchesWebhookFilters(filters, { items: [{ value: "last" }, ...items] })).toBe(true);
});
