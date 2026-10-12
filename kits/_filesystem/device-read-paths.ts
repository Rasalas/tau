import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";

const inside = (path: string) => !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
const gitInternals = (path: string) => path.split(/[\\/]/u).includes(".git");

/** Canonical paths for device reads; Home scopes need a walker that can skip protected ignore files. */
export async function deviceReadPaths(root: string) {
  const project = await realpath(root);
  const home = await realpath(homedir());
  const homeBelowProject = relative(project, home);
  return {
    containsHome: inside(homeBelowProject),
    async resolve(path: string): Promise<string | undefined> {
      try {
        if (gitInternals(path)) return undefined;
        const target = await realpath(path);
        const belowHome = relative(home, target);
        if (!inside(relative(project, target)) || gitInternals(target) || inside(belowHome) && belowHome.split(sep)[0].startsWith(".")) return undefined;
        return target;
      } catch { return undefined; }
    },
  };
}

export type DeviceReadPaths = Awaited<ReturnType<typeof deviceReadPaths>>;
