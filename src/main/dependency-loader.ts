/** `@scope/name` or `name`; a path would let a caller load anything on the disk. */
const PACKAGE_NAME = /^(?:@[a-z0-9-][a-z0-9._-]*\/)?[a-z0-9-][a-z0-9._-]*$/u;

/** A dependency by name only; a path would let a caller load anything on the disk. */
export async function importDependency(packageName: string): Promise<{ default?: unknown }> {
  if (!PACKAGE_NAME.test(packageName)) throw new Error(`"${packageName}" is not a package name Tau can load.`);
  return await import(packageName) as { default?: unknown };
}

/** What `loadDependency` hands a kit: a CommonJS module's exports, or an ES module's namespace. */
export async function loadDependencyModule(packageName: string, load: (name: string) => Promise<{ default?: unknown }> = importDependency): Promise<unknown> {
  if (!PACKAGE_NAME.test(packageName)) throw new Error(`"${packageName}" is not a package name Tau can load.`);
  const module = await load(packageName);
  return module.default ?? module;
}
