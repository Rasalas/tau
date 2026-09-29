// `@tau/extension-api`: the declarations of `tau`, `tau/host` and
// `tau/host-extension` as a package of `.d.ts` files, for a package author's
// editor. A release ships it beside the app (electron-builder's
// extraResources); `tau kit new` and `tau kit types` copy it into a package.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const TYPES_OUTPUT = join(ROOT, "dist-types", "extension-api");

/** The three public modules, by the file each entry declaration re-exports. */
export const TYPE_ENTRIES = {
  "tau.d.ts": "./src/renderer/extension-api",
  "host.d.ts": "./src/main/host-extension-worker-protocol",
  "host-extension.d.ts": "./src/main/host-extension-api",
};

export async function extensionApiVersion(root = ROOT) {
  const source = await readFile(join(root, "src", "shared", "extension-compat.ts"), "utf8");
  const version = /EXTENSION_API_VERSION = "([^"]+)"/u.exec(source)?.[1];
  if (!version) throw new Error("EXTENSION_API_VERSION not found in src/shared/extension-compat.ts");
  return version;
}

/**
 * What the declarations and a package's own code import, copied in so an
 * editor has every type without an npm install: React's, the icons', Node's.
 * `files` narrows a package to what its types need; each keeps its licence.
 */
export const VENDORED_TYPES = [
  { name: "@types/react", to: "react", files: ["package.json", "LICENSE", "index.d.ts", "global.d.ts", "jsx-runtime.d.ts", "jsx-dev-runtime.d.ts", "canary.d.ts", "experimental.d.ts", "compiler-runtime.d.ts"] },
  { name: "csstype", to: "csstype", files: ["package.json", "LICENSE", "index.d.ts"] },
  { name: "lucide-react", to: "lucide-react", files: ["package.json", "LICENSE", "dist/lucide-react.d.ts"] },
  { name: "@types/node", to: "@types/node" },
  { name: "undici-types", to: "undici-types" },
];

async function vendorTypes(root, output) {
  const require = createRequire(join(root, "package.json"));
  for (const { name, to, files } of VENDORED_TYPES) {
    const source = dirname(require.resolve(`${name}/package.json`));
    const target = join(output, "vendor", to);
    if (!files) {
      await cp(source, target, { recursive: true, filter: (path) => !path.endsWith(".md") });
      continue;
    }
    for (const file of files) {
      if (!existsSync(join(source, file))) continue;
      await mkdir(dirname(join(target, file)), { recursive: true });
      await cp(join(source, file), join(target, file));
    }
  }
}

/** The package.json of the types package; its version is the extension API's. */
export function typesManifest(version) {
  return {
    name: "@tau/extension-api",
    version,
    description: "Types of Tau's extension API: the tau, tau/host and tau/host-extension modules a package imports.",
    license: "MIT",
    types: "./tau.d.ts",
    exports: {
      ".": { types: "./tau.d.ts" },
      "./host": { types: "./host.d.ts" },
      "./host-extension": { types: "./host-extension.d.ts" },
    },
  };
}

const README = (version) => `# @tau/extension-api ${version}

Types for a Tau package: \`tau\` (the desktop half), \`tau/host\` (a host half in
a worker) and \`tau/host-extension\` (an in-process host half). Tau compiles a
package itself; these are for the editor and \`tsc --noEmit\` only.

\`tau kit new <name>\` puts a copy into the new package as \`.tau-types/\`, with
a \`tsconfig.json\` that points \`tau\`, \`tau/host\`, \`tau/host-extension\`,
\`react\` and \`lucide-react\` at it; \`tau kit types\` refreshes the copy after
Tau was updated. \`vendor/\` holds the declarations of React, csstype,
lucide-react and Node the API refers to, each with its licence, so an editor
needs no \`npm install\`.
`;

export async function buildTypes({ output = TYPES_OUTPUT, root = ROOT } = {}) {
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(tsc)) throw new Error("TypeScript is not installed here; run npm install first.");
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  // Declarations only, and no type check: `npm run typecheck` does that.
  execFileSync(process.execPath, [
    tsc,
    "--declaration", "--emitDeclarationOnly", "--noCheck",
    "--target", "ES2022", "--lib", "ES2022,DOM,DOM.Iterable",
    "--module", "ESNext", "--moduleResolution", "Bundler", "--jsx", "react-jsx",
    "--skipLibCheck", "--esModuleInterop", "--allowSyntheticDefaultImports", "--resolveJsonModule",
    "--types", "node,vite/client",
    "--rootDir", root, "--outDir", output,
    ...Object.values(TYPE_ENTRIES).map((entry) => join(root, `${entry}.ts`)),
  ], { cwd: root, stdio: "inherit" });
  await vendorTypes(root, output);
  const version = await extensionApiVersion(root);
  for (const [file, target] of Object.entries(TYPE_ENTRIES)) {
    await writeFile(join(output, file), `export * from "${target}";\n`);
  }
  await writeFile(join(output, "package.json"), `${JSON.stringify(typesManifest(version), null, 2)}\n`);
  await writeFile(join(output, "README.md"), README(version));
  return { output, version };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { output, version } = await buildTypes();
  console.log(`Built @tau/extension-api ${version} into ${output}.`);
}
