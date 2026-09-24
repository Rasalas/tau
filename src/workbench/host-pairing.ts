// The device's side of pairing lives in `src/shared/`, so the window's process can pair too (ADR 0025).
export { pairWithHost, type PairWithHostOptions, type PairingResult, type PairingSocket } from "../shared/host-pairing.js";
