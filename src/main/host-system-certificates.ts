import * as tls from "node:tls";

type CertificateStore = Partial<Pick<typeof tls, "getCACertificates" | "setDefaultCACertificates">>;

/** Node uses bundled roots by default; a host also trusts the owner's OS roots. */
export function useHostSystemCertificates(store: CertificateStore = tls): boolean {
  // Older standalone Node hosts retain their configured trust store. Packaged
  // hosts support this API; NODE_EXTRA_CA_CERTS still works on older runtimes.
  if (!store.getCACertificates || !store.setDefaultCACertificates) return false;
  const certificates = new Set([...store.getCACertificates("default"), ...store.getCACertificates("system")]);
  store.setDefaultCACertificates([...certificates]);
  return true;
}
