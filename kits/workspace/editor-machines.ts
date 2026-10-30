import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EditorMachineSetting, EditorOpenOn } from "./protocol.js";
import { formatSshDestination, parseSshDestination } from "./remote-editors.js";

const MACHINE_ID = /^[\w.:-]{1,200}$/u;
const MACHINES_KEPT = 200;
const isOpenOn = (value: unknown): value is EditorOpenOn => value === "here" || value === "machine";

function decode(raw: unknown): Record<string, EditorMachineSetting> {
  const machines = (raw as { machines?: unknown } | null)?.machines;
  if (!machines || typeof machines !== "object") return {};
  const settings: Record<string, EditorMachineSetting> = {};
  for (const [id, value] of Object.entries(machines as Record<string, unknown>).slice(0, MACHINES_KEPT)) {
    if (!MACHINE_ID.test(id) || !value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    const parsed = typeof item.ssh === "string" ? parseSshDestination(item.ssh) : undefined;
    const setting: EditorMachineSetting = {
      ...(parsed && "destination" in parsed ? { ssh: formatSshDestination(parsed.destination) } : {}),
      ...(isOpenOn(item.openOn) ? { openOn: item.openOn } : {}),
    };
    if (setting.ssh || setting.openOn) settings[id] = setting;
  }
  return settings;
}

/**
 * How this device reaches each other machine for an editor, kept by the
 * window machine's host in one file: the destination belongs to the device
 * that opens the editor, not to the machine it reaches, nor to a page that
 * may be showing that machine.
 */
export class EditorMachineSettings {
  private writing: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  async read(): Promise<Record<string, EditorMachineSetting>> {
    try { return decode(JSON.parse(await readFile(this.file, "utf8"))); } catch { return {}; }
  }

  /** A field set to `null` is cleared; an invalid destination is refused with the reason. */
  set(machine: string, patch: { ssh?: string | null; openOn?: EditorOpenOn | null }): Promise<Record<string, EditorMachineSetting>> {
    if (!MACHINE_ID.test(machine)) return Promise.reject(new Error("Name a machine by its id."));
    let ssh: string | null | undefined = patch.ssh;
    if (typeof ssh === "string") {
      if (!ssh.trim()) ssh = null;
      else {
        const parsed = parseSshDestination(ssh);
        if ("error" in parsed) return Promise.reject(new Error(parsed.error));
        ssh = formatSshDestination(parsed.destination);
      }
    }
    if (patch.openOn !== undefined && patch.openOn !== null && !isOpenOn(patch.openOn)) return Promise.reject(new Error("Choose where projects open."));
    const next = this.writing.then(async () => {
      const settings = await this.read();
      const current: EditorMachineSetting = { ...settings[machine] };
      if (ssh === null) delete current.ssh; else if (ssh !== undefined) current.ssh = ssh;
      if (patch.openOn === null) delete current.openOn; else if (patch.openOn !== undefined) current.openOn = patch.openOn;
      if (current.ssh || current.openOn) settings[machine] = current; else delete settings[machine];
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ version: 1, machines: settings }, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.file);
      return settings;
    });
    this.writing = next.catch(() => undefined);
    return next;
  }
}
