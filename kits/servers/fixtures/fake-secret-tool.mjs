#!/usr/bin/env node
// A stand-in for libsecret's `secret-tool`, for tests and isolated instances
// only (TAU_SERVERS_SECRET_TOOL_COMMAND). It never talks to a Secret Service
// and starts no process. Items live in `<state>/secret-tool.json`, the secret
// base64-encoded.
//
//   store --label=<label> <attr> <value>…   the secret is all of stdin
//   lookup <attr> <value>…                  prints the secret; none: exit 1
//   clear <attr> <value>…                   removes every match
//   search [--all] <attr> <value>…          what the real tool prints, secret included
// Anything else exits 2. Every call goes to `<state>/calls.log` (tool
// "secret-tool"); stdin never does.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const dir = process.env.FAKE_SERVERS_STATE ? resolve(process.env.FAKE_SERVERS_STATE)
  : process.env.TAU_USER_DATA ? resolve(process.env.TAU_USER_DATA, "..", "servers") : undefined;
if (!dir) {
  process.stderr.write("fake-secret-tool: FAKE_SERVERS_STATE (or TAU_USER_DATA) names the folder the stub keeps its items in\n");
  process.exit(2);
}
const storePath = join(dir, "secret-tool.json");

const load = () => (existsSync(storePath) ? JSON.parse(readFileSync(storePath, "utf8")) : { items: [] });

function save(store) {
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exitCode = code;
}

function attributePairs(words) {
  if (words.length === 0 || words.length % 2 !== 0) return undefined;
  const attributes = {};
  for (let index = 0; index < words.length; index += 2) attributes[words[index]] = words[index + 1];
  return attributes;
}

const matches = (item, attributes) => Object.entries(attributes).every(([key, value]) => item.attributes[key] === value);

function main(argv) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "calls.log"), `${JSON.stringify({ at: new Date().toISOString(), tool: "secret-tool", args: argv })}\n`, { flag: "a" });
  const [command, ...rest] = argv;
  const options = rest.filter((word) => word.startsWith("--"));
  const attributes = attributePairs(rest.filter((word) => !word.startsWith("--")));
  if (!["store", "lookup", "clear", "search"].includes(command)) return fail(`fake-secret-tool: "${command ?? ""}" is not simulated`);
  if (!attributes) return fail(`usage: secret-tool ${command} attribute value ...`);
  const store = load();
  if (command === "store") {
    const label = options.find((option) => option.startsWith("--label="))?.slice("--label=".length);
    if (!label) return fail("fake-secret-tool: store needs --label=<label>");
    const secret = readFileSync(0);
    const now = Math.floor(Date.now() / 1000);
    const existing = store.items.find((item) => Object.keys(item.attributes).length === Object.keys(attributes).length && matches(item, attributes));
    if (existing) Object.assign(existing, { label, secret: secret.toString("base64"), modified: now });
    else store.items.push({ label, attributes, secret: secret.toString("base64"), created: now, modified: now });
    return save(store);
  }
  const found = store.items.filter((item) => matches(item, attributes));
  if (command === "lookup") {
    if (found.length === 0) { process.exitCode = 1; return undefined; }
    process.stdout.write(Buffer.from(found[0].secret, "base64"));
    return undefined;
  }
  if (command === "clear") {
    store.items = store.items.filter((item) => !matches(item, attributes));
    return save(store);
  }
  for (const [index, item] of (options.includes("--all") ? found : found.slice(0, 1)).entries()) {
    process.stdout.write([
      `[/org/freedesktop/secrets/collection/login/${index + 1}]`,
      `label = ${item.label}`,
      `secret = ${Buffer.from(item.secret, "base64").toString("utf8")}`,
      `created = ${new Date(item.created * 1000).toISOString().replace("T", " ").slice(0, 19)}`,
      `modified = ${new Date(item.modified * 1000).toISOString().replace("T", " ").slice(0, 19)}`,
      ...Object.entries(item.attributes).map(([key, value]) => `attribute.${key} = ${value}`),
      "",
    ].join("\n"));
  }
  return undefined;
}

main(process.argv.slice(2));
