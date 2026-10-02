import { readFileSync } from "node:fs";

export const CONNECT_USAGE = `Usage: tau connect register --relay <https://relay> [--token-file <file>]
       tau connect status [--json]
       tau connect link
       tau connect disconnect

Register this host with your own Tau Connect relay. Enrollment uses the relay's
administration token from --token-file or TAU_CONNECT_ENROLLMENT_TOKEN, never an
argument containing a secret. The relay must already have a trusted HTTPS address.
Paste a link in Settings → Machines on another Tau desktop. This release supports
desktop clients. A browser cannot open the end-to-end TLS byte tunnel.
Disconnect revokes this machine's relay route and stops its outbound connection.`;

export function parseConnectArgs(args) {
  const [action, ...rest] = args;
  if (!action || args.includes("--help")) return { help: true };
  if (!["register", "status", "link", "disconnect"].includes(action)) throw new Error(CONNECT_USAGE);
  const result = { action, json: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--json" && action === "status") result.json = true;
    else if (["--relay", "--token-file"].includes(rest[i]) && action === "register" && rest[i + 1] && !rest[i + 1].startsWith("--")) result[rest[i++].slice(2)] = rest[i];
    else throw new Error(`Unknown tau connect argument ${rest[i]}.`);
  }
  if (action === "register" && !result.relay) throw new Error("tau connect register requires --relay.");
  return result;
}

export async function runConnect(options, { session, out, env = process.env, read = readFileSync }) {
  if (options.help) { out(CONNECT_USAGE); return 0; }
  if (options.action === "link") { out((await session.request("connect-link")).link); return 0; }
  let status;
  if (options.action === "register") {
    const enrollmentToken = (options["token-file"] ? read(options["token-file"], "utf8") : env.TAU_CONNECT_ENROLLMENT_TOKEN ?? "").trim();
    if (!enrollmentToken) throw new Error("Provide --token-file or TAU_CONNECT_ENROLLMENT_TOKEN.");
    status = await session.request("connect-configure", [{ relay: options.relay, enrollmentToken }], 60_000);
  } else status = await session.request(options.action === "disconnect" ? "connect-remove" : "connect-status", [], 60_000);
  out(options.json ? JSON.stringify(status) : `${status.phase}${status.relay ? ` · ${status.relay}` : ""}${status.detail ? `\n${status.detail}` : ""}`);
  return status.phase === "offline" ? 1 : 0;
}
