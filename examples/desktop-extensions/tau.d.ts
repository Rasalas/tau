// Editor support for extension files kept inside this repository. Copy the
// file next to your own extensions and point the path at your Tau checkout.
declare module "tau" {
  export * from "../../src/renderer/extension-api";
}

// The host half of a package, as it looks from inside its worker.
declare module "tau/host" {
  export * from "../../src/main/host-extension-worker-protocol";
}
