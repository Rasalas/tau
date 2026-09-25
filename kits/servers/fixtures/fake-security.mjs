#!/usr/bin/env node
// A stand-in for macOS `/usr/bin/security`, for tests and isolated instances
// only (TAU_SERVERS_SECURITY_COMMAND). It never runs the real tool and starts
// no process at all. Generic passwords live in `<state>/keychain.json`,
// base64-encoded so a grep for a password under .tau-dev finds only a leak.
//
// Simulated, with the real tool's output shape:
//   find-generic-password [-s svc] [-a acct] [-l label] [-g | -w]
//       attributes on stdout; -g adds `password: "…"` on stderr (0x<HEX>  "…" when
//       not printable ASCII); -w prints only the password. Not found: exit 44.
//   add-generic-password -s svc -a acct [-l label] -w pw [-U]
//       an existing item without -U: exit 45.
//   delete-generic-password [-s svc] [-a acct] [-l label]
//   dump-keychain           attributes only; -d/-r are refused
//   -i                      the same commands, one per line on stdin
// Anything else exits 2. Every call goes to `<state>/calls.log` (tool
// "security") with -w values and stdin passwords redacted.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const NOT_FOUND = 44;
const DUPLICATE = 45;
const REFUSED = 2;

const dir = process.env.FAKE_SERVERS_STATE ? resolve(process.env.FAKE_SERVERS_STATE)
  : process.env.TAU_USER_DATA ? resolve(process.env.TAU_USER_DATA, "..", "servers") : undefined;
if (!dir) {
  process.stderr.write("fake-security: FAKE_SERVERS_STATE (or TAU_USER_DATA) names the folder the stub keeps its items in\n");
  process.exit(REFUSED);
}
const storePath = join(dir, "keychain.json");

class Exit extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function load() {
  if (!existsSync(storePath)) return { items: [] };
  return JSON.parse(readFileSync(storePath, "utf8"));
}

function save(store) {
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

function log(record) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "calls.log"), `${JSON.stringify({ at: new Date().toISOString(), tool: "security", ...record })}\n`, { flag: "a" });
}

/** `-w` takes the password only when adding; in a lookup it is a flag. */
const redact = (args) => (args[0] === "add-generic-password" ? args.map((arg, index) => (args[index - 1] === "-w" ? "********" : arg)) : args);

/** Splits a `security -i` line the way a shell would: quotes and backslashes. */
function splitLine(line) {
  const words = [];
  let word;
  let quote;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && index + 1 < line.length) word += line[++index];
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      word ??= "";
    } else if (char === "\\" && index + 1 < line.length) {
      word = (word ?? "") + line[++index];
    } else if (/\s/u.test(char)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else {
      word = (word ?? "") + char;
    }
  }
  if (word !== undefined) words.push(word);
  return words;
}

const LOOKUP_OPTIONS = new Set(["-a", "-s", "-l", "-D", "-j", "-c", "-C", "-G", "-r"]);
const ADD_OPTIONS = new Set([...LOOKUP_OPTIONS, "-T", "-w"]);

function parseOptions(args, valueOptions) {
  const options = {};
  const flags = new Set();
  const rest = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (valueOptions.has(arg)) {
      if (index + 1 >= args.length) {
        // The real tool prompts for a missing -w; the stub has no one to ask.
        throw new Exit(REFUSED, `fake-security: ${arg} needs a value (the stub never prompts)`);
      }
      options[arg.slice(1)] = args[++index];
    } else if (/^-[A-Za-z]+$/u.test(arg)) {
      for (const flag of arg.slice(1)) flags.add(flag);
    } else {
      rest.push(arg);
    }
  }
  return { options, flags, rest };
}

const matches = (item, options) => ["s", "a", "l"].every((key) => options[key] === undefined || item[{ s: "service", a: "account", l: "label" }[key]] === options[key]);

const timedate = (iso) => {
  const stamp = `${iso.replace(/[-:T]/gu, "").slice(0, 14)}Z`;
  return `0x${Buffer.from(`${stamp}\0`).toString("hex").toUpperCase()}  "${stamp}\\000"`;
};

function attributes(item) {
  const blob = (value) => (value === undefined ? "<NULL>" : `"${value}"`);
  return [
    `keychain: "${storePath}"`,
    "version: 512",
    'class: "genp"',
    "attributes:",
    `    0x00000007 <blob>=${blob(item.label)}`,
    "    0x00000008 <blob>=<NULL>",
    `    "acct"<blob>=${blob(item.account)}`,
    `    "cdat"<timedate>=${timedate(item.created)}`,
    '    "crtr"<uint32>=<NULL>',
    '    "cusi"<sint32>=<NULL>',
    '    "desc"<blob>=<NULL>',
    '    "gena"<blob>=<NULL>',
    '    "icmt"<blob>=<NULL>',
    '    "invi"<sint32>=<NULL>',
    `    "mdat"<timedate>=${timedate(item.modified)}`,
    '    "nega"<sint32>=<NULL>',
    '    "prot"<blob>=<NULL>',
    '    "scrp"<sint32>=<NULL>',
    `    "svce"<blob>=${blob(item.service)}`,
    '    "type"<uint32>=<NULL>',
    "",
  ].join("\n");
}

const printable = (bytes) => bytes.every((byte) => byte >= 0x20 && byte < 0x7f);

/** How `security -g` prints a password: quoted when printable ASCII, else hex plus an octal-escaped copy. */
function passwordLine(password) {
  const bytes = Buffer.from(password, "utf8");
  if (printable([...bytes])) return `password: "${password}"`;
  const escaped = [...bytes].map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : `\\${byte.toString(8).padStart(3, "0")}`)).join("");
  return `password: 0x${bytes.toString("hex").toUpperCase()}  "${escaped}"`;
}

const notFound = () => new Exit(NOT_FOUND, "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.");

function run(args, io) {
  const [command, ...rest] = args;
  const { options, flags } = parseOptions(rest, command === "add-generic-password" ? ADD_OPTIONS : LOOKUP_OPTIONS);
  const store = load();
  if (command === "find-generic-password") {
    const item = store.items.find((candidate) => matches(candidate, options));
    if (!item) throw notFound();
    const password = Buffer.from(item.password, "base64").toString("utf8");
    if (flags.has("w")) {
      const bytes = Buffer.from(password, "utf8");
      io.out(`${printable([...bytes]) ? password : bytes.toString("hex")}\n`);
      return;
    }
    io.out(attributes(item));
    if (flags.has("g")) io.err(`${passwordLine(password)}\n`);
    return;
  }
  if (command === "add-generic-password") {
    if (options.s === undefined || options.a === undefined || options.w === undefined) {
      throw new Exit(REFUSED, "fake-security: add-generic-password needs -s, -a and -w <password>");
    }
    const now = new Date().toISOString();
    const existing = store.items.find((candidate) => candidate.service === options.s && candidate.account === options.a);
    if (existing && !flags.has("U")) throw new Exit(DUPLICATE, "security: SecKeychainItemCreateFromContent (<default>): The specified item already exists in the keychain.");
    const item = existing ?? { service: options.s, account: options.a, created: now };
    item.label = options.l ?? existing?.label ?? options.s;
    item.password = Buffer.from(options.w, "utf8").toString("base64");
    item.modified = now;
    if (!existing) store.items.push(item);
    save(store);
    return;
  }
  if (command === "delete-generic-password") {
    const index = store.items.findIndex((candidate) => matches(candidate, options));
    if (index === -1) throw notFound();
    const [item] = store.items.splice(index, 1);
    save(store);
    io.out(attributes(item));
    io.out("password has been deleted.\n");
    return;
  }
  if (command === "dump-keychain") {
    if (flags.has("d") || flags.has("r")) throw new Exit(REFUSED, "fake-security: dump-keychain -d/-r would reveal secrets; the stub refuses it");
    for (const item of store.items) io.out(attributes(item));
    return;
  }
  throw new Exit(REFUSED, `fake-security: "${command ?? ""}" is not simulated`);
}

function main(argv) {
  const out = (text) => process.stdout.write(text);
  const err = (text) => process.stderr.write(text);
  if (argv[0] === "-i") {
    const lines = readFileSync(0, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
    log({ args: ["-i"], stdin: lines.map((line) => redact(splitLine(line)).join(" ")) });
    let code = 0;
    for (const line of lines) {
      try { run(splitLine(line), { out, err }); } catch (error) {
        if (!(error instanceof Exit)) throw error;
        err(`${error.message}\n`);
        code = error.code;
      }
    }
    return code;
  }
  log({ args: redact(argv) });
  try {
    run(argv, { out, err });
    return 0;
  } catch (error) {
    if (!(error instanceof Exit)) throw error;
    err(`${error.message}\n`);
    return error.code;
  }
}

process.exitCode = main(process.argv.slice(2));
