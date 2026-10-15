import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("ships client routing metadata without host argument decoders", async () => {
  const bundle = await build({
    absWorkingDir: fileURLToPath(new URL("../..", import.meta.url)),
    stdin: {
      contents: 'export { createHostClient } from "./src/workbench/host-client"; export { methodAccess } from "./src/shared/host-method-access";',
      resolveDir: fileURLToPath(new URL("../..", import.meta.url)),
    },
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const inputs = Object.keys(bundle.metafile.inputs);
  expect(inputs.filter((path) => /host-(?:command-input|(?:core|factory|turn)-commands)\.ts$/u.test(path)))
    .toEqual([]);
});
