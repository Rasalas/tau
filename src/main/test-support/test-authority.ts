import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { buildCertificate } from "../self-signed-certificate.js";

/** A throwaway certificate authority, in memory only: nothing is installed anywhere. */
export interface TestAuthority {
  cert: string;
  /** A server certificate for `names`, signed by this authority. */
  issue(names: { dnsNames?: string[]; ipAddresses?: string[] }): { cert: string; key: string };
}

export function createTestAuthority(commonName = "Tau Test CA"): TestAuthority {
  const privateKey: KeyObject = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
  const cert = buildCertificate({ commonName, dnsNames: [], ipAddresses: [], days: 30, privateKey, issuer: { commonName, privateKey }, authority: true });
  return {
    cert,
    issue: ({ dnsNames = [], ipAddresses = [] }) => {
      const leafKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
      return {
        cert: buildCertificate({ commonName: dnsNames[0] ?? ipAddresses[0] ?? "leaf", dnsNames, ipAddresses, days: 30, privateKey: leafKey, issuer: { commonName, privateKey } }),
        key: leafKey.export({ type: "pkcs8", format: "pem" }).toString(),
      };
    },
  };
}
