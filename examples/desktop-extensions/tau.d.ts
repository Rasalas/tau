// Editor support for extension files kept inside this repository. Copy the
// file next to your own extensions and point the path at your Tau checkout.
declare module "tau" {
  export * from "../../src/renderer/extension-api";
}
