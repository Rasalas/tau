/**
 * The transcript worker consumes only Pi's pure journal/parser/compaction exports.
 * Its public SDK imports are bundled and tree-shaken independently of the host.
 * Unused runtime and provider registration modules must not initialize in it.
 */
export function persistedTranscriptWorkerBuildOptions(root, outfile) {
  return {
    absWorkingDir: root,
    entryPoints: ["src/main/persisted-transcript-worker.ts"],
    outfile,
    bundle: true,
    treeShaking: true,
    platform: "node",
    format: "esm",
    target: "node20",
    logLevel: "silent",
    plugins: [{
      name: "persisted-transcript-pure-sdk",
      setup(api) {
        api.onResolve({ filter: /.*/ }, async (args) => {
          if (args.pluginData?.pureTranscriptSdk) return;
          const sdkRelative = /[\\/]@earendil-works[\\/]pi-coding-agent[\\/]/u.test(args.importer)
            && /^\.{1,2}\//u.test(args.path);
          if (args.path !== "@earendil-works/pi-coding-agent" && args.path !== "@earendil-works/pi-ai/compat" && !sdkRelative) return;
          const result = await api.resolve(args.path, {
            importer: args.importer, resolveDir: args.resolveDir, kind: args.kind,
            pluginData: { pureTranscriptSdk: true },
          });
          return { ...result, sideEffects: false };
        });
      },
    }],
  };
}
