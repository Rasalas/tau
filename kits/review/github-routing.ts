import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HostCommandError, type HostCommandCall, type HostExtensionContext } from "tau/host-extension";
import { REVIEW_HOST_EXTENSION_ID } from "./protocol.js";
import type { ProviderTools, SourceControlProvider } from "./provider.js";

export type GitHubSharing = "off" | "read" | "act";
export interface GitHubRoutingRow { id: string; name: string; direction: "machine" | "device"; mode: GitHubSharing; host: string; status: string; machine?: string; preferred?: boolean }
const READS = new Set(["detail", "checks", "threads", "candidates", "viewed-states", "stack"]);
const ACTIONS = new Set(["comment", "reply", "lineComment", "update", "review", "resolve", "editComment", "reviewers", "labels", "viewed-set", "merge", "autoMerge", "revert", "stackAction"]);
interface Grant { mode: GitHubSharing; host: string; account: string; address?: string; access?: string; machine?: string; trust?: string; preferred?: boolean }
const object = (input: unknown): Record<string, unknown> => input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
function fail(message: string): never { throw new HostCommandError(message); }
const endpoint = (raw: unknown): string => typeof raw === "string" && /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/u.test(raw) ? raw : fail("Name the GitHub endpoint, such as github.com.");

/** No filesystem operations, shell arguments or credentials cross this boundary. */
function argumentsFor(operation: string, raw: unknown, host: string): unknown[] {
  if (!READS.has(operation) && !ACTIONS.has(operation)) fail("This GitHub operation cannot be shared.");
  if (!Array.isArray(raw) || raw.length > 5 || JSON.stringify(raw).length > 256_000) fail("Invalid shared GitHub request.");
  const ref = object(raw[0]);
  if (ref.service !== "github" || ref.host !== host || typeof ref.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/u.test(ref.repo)
    || typeof ref.number !== "number" || !Number.isSafeInteger(ref.number) || ref.number < 1
    || ref.url !== `https://${host}/${ref.repo}/pull/${ref.number}`) fail("Invalid GitHub pull request.");
  const string = (value: unknown): value is string => typeof value === "string";
  const strings = (value: unknown) => Array.isArray(value) && value.length <= 200 && value.every(string);
  const line = (value: unknown) => {
    const input = object(value);
    return string(input.path) && string(input.body) && Number.isSafeInteger(input.line) && Number(input.line) > 0 && (input.side === "old" || input.side === "new");
  };
  const input = object(raw[1]);
  let valid = false;
  switch (operation) {
    case "detail": case "threads": case "viewed-states": case "stack": valid = raw.length <= 2 && (raw[1] === undefined || typeof raw[1] === "boolean"); break;
    case "checks": case "candidates": valid = raw.length === 1; break;
    case "comment": valid = raw.length === 2 && string(raw[1]); break;
    case "reply": valid = raw.length === 3 && string(raw[1]) && string(raw[2]); break;
    case "resolve": valid = raw.length === 3 && string(raw[1]) && typeof raw[2] === "boolean"; break;
    case "viewed-set": valid = raw.length === 3 && string(raw[1]) && typeof raw[2] === "boolean"; break;
    case "update": valid = raw.length === 2 && (string(input.title) || string(input.body)) && (input.title === undefined || string(input.title)) && (input.body === undefined || string(input.body)); break;
    case "lineComment": valid = raw.length === 3 && line(raw[1]) && (object(raw[2]).headSha === undefined || string(object(raw[2]).headSha)); break;
    case "review": valid = raw.length === 3 && ["comment", "approve", "request-changes"].includes(String(input.event)) && string(input.body) && Array.isArray(input.comments) && input.comments.every(line) && (object(raw[2]).headSha === undefined || string(object(raw[2]).headSha)); break;
    case "editComment": valid = raw.length === 2 && string(input.id) && string(input.body) && ["comment", "review", "review-comment"].includes(String(input.kind)); break;
    case "merge": valid = raw.length <= 4 && object(raw[1]).number === ref.number && ["merge", "squash", "rebase"].includes(String(raw[2])) && (object(raw[3]).deleteBranch === undefined || typeof object(raw[3]).deleteBranch === "boolean"); break;
    case "autoMerge": valid = raw.length <= 5 && object(raw[1]).number === ref.number && typeof raw[2] === "boolean" && (raw[3] === undefined || raw[3] === null || ["merge", "squash", "rebase"].includes(String(raw[3]))); break;
    case "revert": valid = raw.length === 2 && string(input.nodeId); break;
    case "stackAction": {
      const seen = object(input.seen);
      valid = raw.length === 2 && ["merge", "rebase"].includes(String(input.action)) && (input.method === undefined || ["merge", "squash", "rebase"].includes(String(input.method)))
        && Number.isSafeInteger(seen.number) && Number(seen.number) > 0 && string(seen.base) && Array.isArray(seen.layers) && seen.layers.length > 0 && seen.layers.length <= 200
        && seen.layers.every((rawLayer) => { const layer = object(rawLayer); return Number.isSafeInteger(layer.number) && Number(layer.number) > 0 && layer.url === `https://${host}/${ref.repo}/pull/${layer.number}` && string(layer.headRef) && string(layer.headSha) && ["open", "closed", "merged"].includes(String(layer.state)); });
      break;
    }
    case "reviewers": case "labels": valid = raw.length === 3 && strings(raw[1]) && strings(raw[2]); break;
  }
  if (!valid) fail("Invalid arguments for the shared GitHub operation.");
  // Pass a newly built ref: no cwd, path or caller authority can be forwarded.
  return [{ service: "github", host, repo: ref.repo, number: ref.number, url: ref.url }, ...raw.slice(1)];
}

export function createGitHubRouting(context: HostExtensionContext, local: SourceControlProvider, tools: ProviderTools): { provider: SourceControlProvider; dispose(): Promise<void> } {
  const { services } = context;
  const machines = services.machines;
  const outgoing = new Map<string, Grant>();
  const incoming = new Map<string, Grant>();
  let generation = 0;
  const file = join(services.stateDir, "github-sharing.json");
  const ready = (async () => {
    try {
      const saved = object(JSON.parse(await readFile(file, "utf8")));
      if (saved.version !== 1) return;
      for (const [key, target] of [["outgoing", outgoing], ["incoming", incoming]] as const) {
        for (const raw of Array.isArray(saved[key]) ? saved[key] as unknown[] : []) {
          if (!Array.isArray(raw) || typeof raw[0] !== "string") continue;
          const grant = object(raw[1]);
          if ((grant.mode === "read" || grant.mode === "act") && typeof grant.account === "string" && typeof grant.host === "string"
            && typeof grant.address === "string" && typeof grant.trust === "string") target.set(raw[0], grant as unknown as Grant);
        }
      }
    } catch { /* Missing or malformed consent is Off. */ }
  })();
  let writes = Promise.resolve();
  const persist = () => {
    const contents = JSON.stringify({ version: 1, outgoing: [...outgoing], incoming: [...incoming] });
    writes = writes.catch(() => undefined).then(async () => {
      await mkdir(services.stateDir, { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, `${contents}\n`, { mode: 0o600 });
      await rename(temp, file);
    });
    return writes;
  };
  const devices = () => services.clients?.devices?.() ?? [];
  // Identity comes from GitHub's authenticated user endpoint, never auth-status text.
  const identity = async (host: string): Promise<string> => {
    let output: string;
    try { output = await tools.cli("github", { args: ["api", "--hostname", host, "user"] }, "Verifying the GitHub account", { host }); }
    catch (error) { throw new HostCommandError(error instanceof Error ? error.message : String(error)); }
    let raw: Record<string, unknown>;
    try { raw = object(JSON.parse(output)); } catch { fail("GitHub did not verify the signed-in account."); }
    return typeof raw.id === "number" && Number.isSafeInteger(raw.id) && raw.id > 0 ? String(raw.id) : fail("GitHub did not verify the signed-in account.");
  };
  const invalidate = () => {
    const count = outgoing.size + incoming.size;
    for (const [id, grant] of outgoing) {
      const machine = machines?.list().find((entry) => entry.id === id);
      if (!machine || machine.status === "refused" || machine.address !== grant.address || machine.trustIdentity !== grant.trust || machine.readOnly && grant.mode === "act") outgoing.delete(id);
    }
    for (const [id, grant] of incoming) {
      const device = devices().find((entry) => entry.id === id);
      const peer = machines?.list().find((entry) => entry.id === grant.machine);
      if (!device || device.access !== grant.access || !peer || peer.status === "refused" || peer.address !== grant.address || peer.trustIdentity !== grant.trust) incoming.delete(id);
    }
    if (count !== outgoing.size + incoming.size) void persist().catch(() => undefined);
  };
  const stops = [machines?.subscribe(invalidate), services.clients?.observe({ devicesChanged: invalidate })];
  context.registerCommand("github-sharing", async () => {
    await ready;
    invalidate();
    return [
      ...machines?.list().map((machine): GitHubRoutingRow => ({ id: machine.id, name: machine.name, direction: "machine", mode: outgoing.get(machine.id)?.mode ?? "off", host: outgoing.get(machine.id)?.host ?? "github.com", status: machine.readOnly ? "Read only" : machine.status, preferred: outgoing.get(machine.id)?.preferred })) ?? [],
      ...devices().map((device): GitHubRoutingRow => ({ id: device.id, name: device.name, direction: "device", mode: incoming.get(device.id)?.mode ?? "off", host: incoming.get(device.id)?.host ?? "github.com", status: device.access, machine: incoming.get(device.id)?.machine })),
    ];
  }, { access: "owner" });
  context.registerCommand("github-sharing-set", async (input) => {
    await ready;
    const started = ++generation;
    const fields = object(input);
    const id = typeof fields.id === "string" ? fields.id : fail("Choose a paired host or device.");
    const grants = fields.direction === "machine" ? outgoing : fields.direction === "device" ? incoming : fail("Choose the sharing direction.");
    // Changing an endpoint or a failed re-verification revokes the previous grant.
    grants.delete(id);
    await persist();
    if (fields.mode === "off") return;
    if (fields.mode !== "read" && fields.mode !== "act") fail("Choose Off, Read PRs or Read and act.");
    const host = endpoint(fields.host);
    const account = await identity(host);
    if (grants === outgoing) {
      const machine = machines?.list().find((entry) => entry.id === id);
      if (!machine || !machine.address || !machine.trustIdentity || machine.status !== "connected" || machine.id === machines?.self.id) fail("Connect a different trusted paired host first.");
      if (machine.readOnly && fields.mode === "act") fail("A Read only host cannot perform shared GitHub actions.");
      const remote = object(await machines!.call(id, REVIEW_HOST_EXTENSION_ID, "github-sharing-identity", { host }));
      if (remote.account !== account || remote.source !== id) fail("The hosts are signed into different GitHub accounts.");
      const current = machines!.list().find((entry) => entry.id === id);
      if (started !== generation || !current || current.address !== machine.address || current.trustIdentity !== machine.trustIdentity || current.status !== "connected" || fields.mode === "act" && current.readOnly) fail("Sharing changed during verification. No approval was saved.");
      if (fields.preferred === true) for (const other of outgoing.values()) if (other.host === host) other.preferred = false;
      grants.set(id, { mode: fields.mode, host, account, address: machine.address, trust: machine.trustIdentity, preferred: fields.preferred === true && fields.mode === "act" });
    } else {
      const device = devices().find((entry) => entry.id === id);
      if (!device) fail("That paired device is no longer allowed here.");
      if (device.access === "read-only" && fields.mode === "act") fail("A Read only device cannot perform shared GitHub actions.");
      const peer = machines?.list().find((entry) => entry.id === fields.machine && entry.status === "connected");
      if (!peer || !peer.address || !peer.trustIdentity || peer.id === machines?.self.id) fail("Choose the connected source host for this paired device.");
      const verified = object(await machines!.call(peer.id, REVIEW_HOST_EXTENSION_ID, "github-sharing-identity", { host }));
      if (verified.account !== account || verified.source !== peer.id) fail("The hosts are signed into different GitHub accounts.");
      const current = machines!.list().find((entry) => entry.id === peer.id);
      if (started !== generation || !devices().some((entry) => entry.id === id && entry.access === device.access) || !current || current.address !== peer.address || current.trustIdentity !== peer.trustIdentity || current.status !== "connected") fail("Sharing changed during verification. No approval was saved.");
      grants.set(id, { mode: fields.mode, host, account, access: device.access, machine: peer.id, address: peer.address, trust: peer.trustIdentity });
    }
    await persist();
  }, { access: "owner" });
  context.registerCommand("github-sharing-identity", async (input, call) => {
    if (!call.device) fail("Identity verification requires a paired device.");
    return { account: await identity(endpoint(object(input).host)), source: machines?.self.id };
  }, { access: "read" });

  const invokeLocal = async (operation: string, args: unknown[]): Promise<unknown> => {
    if (operation.startsWith("viewed-") && !local.viewedMarks) fail("This host does not support GitHub viewed marks.");
    if (operation === "viewed-states") return [...await local.viewedMarks!.states(args[0] as never, args[1] as boolean)];
    if (operation === "viewed-set") return local.viewedMarks!.set(args[0] as never, args[1] as string, args[2] as boolean, () => local.detail(args[0] as never, true));
    const method = local[operation as keyof SourceControlProvider];
    if (typeof method !== "function") fail("This host does not support that GitHub operation.");
    return (method as (...args: unknown[]) => unknown)(...args);
  };
  const receive = async (input: unknown, call: HostCommandCall, write: boolean) => {
    await ready;
    invalidate();
    const fields = object(input);
    const operation = typeof fields.operation === "string" ? fields.operation : "";
    if (!(write ? ACTIONS : READS).has(operation)) fail("This GitHub operation is not permitted by this command.");
    const grant = call.device ? incoming.get(call.device) : undefined;
    if (!grant || write && grant.mode !== "act" || fields.host !== grant.host || fields.account !== grant.account) fail("GitHub sharing is off for this device or endpoint.");
    if (fields.source !== grant.machine) fail("This request names a different source host.");
    const device = devices().find((entry) => entry.id === call.device);
    if (!device || write && device.access !== "full") fail("A Read only device cannot perform shared GitHub actions.");
    const peer = object(await machines!.call(grant.machine!, REVIEW_HOST_EXTENSION_ID, "github-sharing-identity", { host: grant.host }));
    if (peer.account !== grant.account || peer.source !== grant.machine) { incoming.delete(call.device!); await persist(); fail("The source host's GitHub account changed."); }
    const args = argumentsFor(operation, fields.args, grant.host);
    if (await identity(grant.host) !== grant.account) { incoming.delete(call.device!); await persist(); fail("The GitHub account changed. Enable sharing again after signing into the same account."); }
    if (incoming.get(call.device!) !== grant) fail("GitHub sharing was revoked while verifying the account.");
    // Only the raw local provider runs here. Forwarded calls never route again.
    return invokeLocal(operation, args);
  };
  const receiveCommand = async (input: unknown, call: HostCommandCall, write: boolean) => {
    try { return await receive(input, call, write); }
    catch (error) { throw new HostCommandError(error instanceof Error ? error.message : String(error)); }
  };
  context.registerCommand("github-sharing-read", (input, call) => receiveCommand(input, call, false), { access: "read" });
  context.registerCommand("github-sharing-act", (input, call) => receiveCommand(input, call, true));

  const route = async (operation: string, args: unknown[]) => {
    await ready;
    const write = ACTIONS.has(operation);
    // A write sent locally is never tried elsewhere, regardless of the error.
    // Local authentication is a preflight, before any mutation is started.
    const host = endpoint(object(args[0]).host);
    if ((operation === "merge" || operation === "autoMerge") && object(args[0]).cwd) return invokeLocal(operation, args);
    if (operation === "merge" || operation === "autoMerge") {
      const target = object(args[0]);
      const number = object(args[1]).number;
      args = [{ service: "github", host, repo: target.repo, number, url: `https://${host}/${target.repo}/pull/${number}` }, ...args.slice(1)];
    }
    if (![...outgoing.values()].some((grant) => grant.host === host)) return invokeLocal(operation, args);
    let account: string;
    try { account = await identity(host); } catch (error) {
      if (write && [...outgoing.values()].some((grant) => grant.host === host && grant.preferred)) throw new HostCommandError(`No GitHub action was sent because this host could not verify its account: ${error instanceof Error ? error.message : String(error)}`);
      return invokeLocal(operation, args);
    }
    let accountChanged = false;
    for (const [id, grant] of outgoing) if (grant.host === host && grant.account !== account) { outgoing.delete(id); accountChanged = true; await persist(); }
    if (write && accountChanged) fail("The GitHub account changed. No action was sent. Enable sharing again after verifying the account.");
    invalidate();
    const preferred = write ? [...outgoing].find(([, grant]) => grant.host === host && grant.account === account && grant.mode === "act" && grant.preferred)?.[0] : undefined;
    let localError: unknown;
    let routingError: string | undefined;
    if (write && !preferred) {
      try { await local.detail(args[0] as never, true); } catch (error) { localError = error; }
      if (!localError) return invokeLocal(operation, args);
    } else if (!write) {
      try { return await invokeLocal(operation, args); } catch (error) { localError = error; }
    }
    invalidate();
    for (const [id, grant] of outgoing) {
      const machine = machines?.list().find((entry) => entry.id === id);
      if (preferred && preferred !== id) continue;
      if (grant.host !== host || grant.account !== account || machine?.status !== "connected" || write && (grant.mode !== "act" || machine.readOnly)) continue;
      try {
        const remote = object(await machines!.call(id, REVIEW_HOST_EXTENSION_ID, "github-sharing-identity", { host }));
        if (remote.account !== account || remote.source !== id) { outgoing.delete(id); await persist(); routingError = `${machine.name} is signed into a different GitHub account.`; continue; }
      } catch (error) { routingError = `${machine.name}: ${error instanceof Error ? error.message : String(error)}`; continue; }
      if (outgoing.get(id) !== grant) continue;
      const request = { source: machines!.self.id, host, account, operation, args: argumentsFor(operation, args, host) };
      // Once a mutation leaves this host, its outcome may be unknown. Never retry it.
      if (write) {
        try { return await machines!.call(id, REVIEW_HOST_EXTENSION_ID, "github-sharing-act", request); }
        catch (error) { throw new HostCommandError(`${error instanceof Error ? error.message : String(error)} Tau did not retry the action. Check GitHub before trying again.`); }
      }
      try { return await machines!.call(id, REVIEW_HOST_EXTENSION_ID, "github-sharing-read", request); }
      catch (error) { routingError = `${machine.name}: ${error instanceof Error ? error.message : String(error)}`; }
    }
    if (preferred) fail("The selected GitHub action host could not verify its account. No action was sent. Check sharing on both hosts.");
    if (routingError) throw new HostCommandError(`${localError instanceof Error ? localError.message : String(localError)} Shared GitHub access failed: ${routingError}`);
    throw localError;
  };
  context.registerCommand("github-sharing-clear", async () => { await ready; ++generation; outgoing.clear(); incoming.clear(); await persist(); }, { access: "owner" });
  // Disposal closes listeners; persisted consent is checked against current trust on the next activation.
  const dispose = async () => { stops.forEach((stop) => stop?.()); await ready; await writes; outgoing.clear(); incoming.clear(); };
  const routed = { ...local };
  for (const operation of [...READS, ...ACTIONS].filter((name) => !name.startsWith("viewed-"))) {
    (routed as unknown as Record<string, unknown>)[operation] = (...args: unknown[]) => route(operation, args);
  }
  if (local.viewedMarks) routed.viewedMarks = {
    states: async (ref, fresh) => new Map(await route("viewed-states", [ref, fresh]) as never),
    set: async (ref, path, viewed) => { await route("viewed-set", [ref, path, viewed]); },
  };
  return { provider: routed, dispose };
}
