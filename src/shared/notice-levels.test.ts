import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A failure reported through `notify` is an error toast: it stays until
 * dismissed and offers Copy. This reads the source for the calls that pass a
 * caught error on without saying so, and for ids that would reach the toast.
 */
const NOTIFY_CALL = /(?<![\w$])(?:[\w$]+(?:\?)?\.)*(notify|onNotify|onNotice|setNotice)(?:\?\.)?\(/gu;
/** Receivers whose `notify` is not a toast: the OS, a socket, a store's listeners. */
const NOT_A_TOAST = /(?:attention|client|connection|server|platform)\??\.$/u;
const FAILURE_TEXT = /errorMessage\(|errorOf\(|instanceof Error|\b(?:error|reason|failure|cause)\.message\b/u;
/** `String(error)` after the check for an Error is the message of a thrown non-Error. */
const SAFE_STRING = /(\w+) instanceof Error \? \1\.message : String\(\1\)/gu;
/** What turns an id or an `Error: ` prefix into text a person reads. */
const INTERNAL_TEXT = /\bString\((?:error|reason|failure|failed|cause)\)|\b(?:command|hook|match\.command)\.id\b|\bcommandId\b/u;

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      if (name === "node_modules" || name === "fixtures" || name.startsWith(".")) continue;
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.[cm]?tsx?$/u.test(name) && !/\.test\.[cm]?tsx?$/u.test(name)) found.push(path);
    }
  };
  walk(root);
  return found;
}

/** The text of the call's arguments from `start` (just after its `(`), split at the top-level commas. */
function argumentsAt(source: string, start: number): string[] {
  const parts: string[] = [];
  const open: string[] = ["("];
  let from = start;
  for (let at = start; at < source.length; at += 1) {
    const char = source[at]!;
    if (open.at(-1) === "`") {
      if (char === "\\") at += 1;
      else if (char === "`") open.pop();
      else if (char === "$" && source[at + 1] === "{") { open.push("${"); at += 1; }
    } else if (char === "\"" || char === "'") {
      for (at += 1; at < source.length && source[at] !== char; at += 1) if (source[at] === "\\") at += 1;
    } else if (char === "`") open.push("`");
    else if (char === "(" || char === "[" || char === "{") open.push(char);
    else if (char === ")" || char === "]" || char === "}") {
      open.pop();
      if (open.length === 0) { parts.push(source.slice(from, at)); return parts; }
    } else if (char === "," && open.length === 1) { parts.push(source.slice(from, at)); from = at + 1; }
  }
  return parts;
}

interface Call { path: string; line: number; text: string; message: string; level: string }

function notifyCalls(root: string): Call[] {
  const calls: Call[] = [];
  for (const path of sourceFiles(root)) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(NOTIFY_CALL)) {
      const before = source.slice(Math.max(0, match.index - 40), match.index + match[0].length - match[1]!.length - 1);
      if (NOT_A_TOAST.test(before)) continue;
      // In a kit `setNotice` is a component's own state, drawn inline.
      if (match[1] === "setNotice" && path.startsWith("kits/")) continue;
      const [message = "", level = ""] = argumentsAt(source, match.index + match[0].length);
      // A declaration (`notify(message: string, level?: …)`) or a call without arguments.
      if (!message.trim() || /^\s*\w+\??:/u.test(message)) continue;
      calls.push({ path, line: source.slice(0, match.index).split("\n").length, text: match[0], message, level });
    }
  }
  return calls;
}

const CALLS = [...notifyCalls("kits"), ...notifyCalls("src/renderer"), ...notifyCalls("src/workbench")];
const where = (call: Call) => `${call.path}:${call.line}`;

describe("notifications of a failure", () => {
  it("finds the calls it checks", () => {
    expect(CALLS.length).toBeGreaterThan(150);
  });

  it("report a caught error at the error level", () => {
    const offenders = CALLS.filter((call) => FAILURE_TEXT.test(call.message) && !call.level.includes("\"error\"")).map(where);
    expect(offenders).toEqual([]);
  });

  it("carry no command id, hook id or stringified Error in their text", () => {
    const offenders = CALLS.filter((call) => INTERNAL_TEXT.test(call.message.replace(SAFE_STRING, ""))).map(where);
    expect(offenders).toEqual([]);
  });
});
