/** Suffixes under which a site is three labels, not two; the rest is an approximation of the public suffix list. */
const TWO_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.jp", "ne.jp", "or.jp", "co.nz",
  "com.br", "com.cn", "com.mx", "co.in", "co.kr", "com.tr", "com.tw", "co.za", "com.sg", "com.hk",
  "github.io", "gitlab.io", "vercel.app", "netlify.app", "pages.dev", "web.app", "firebaseapp.com", "herokuapp.com",
]);

/** The host a stored cookie belongs to, without the dot a domain cookie carries. */
export const bareHost = (host: string): string => host.startsWith(".") ? host.slice(1) : host;

/** The site a host belongs to: `accounts.example.co.uk` → `example.co.uk`; an address or `localhost` stays whole. */
export function siteOf(host: string): string {
  const bare = bareHost(host.trim()).toLowerCase();
  if (!bare.includes(".") || /^[\d.]+$/u.test(bare) || bare.includes(":")) return bare;
  const labels = bare.split(".");
  const size = TWO_LABEL_SUFFIXES.has(labels.slice(-2).join(".")) ? 3 : 2;
  return labels.slice(-size).join(".");
}
