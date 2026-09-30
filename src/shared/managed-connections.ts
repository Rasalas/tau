export interface ConnectRoute { relay: string; id: string; token: string; port: number }
export interface ManagedRoute {
  ssh?: { target: string; platform: "linux" | "darwin"; port: number };
  connect?: ConnectRoute;
  wsl?: string;
}

export function decodeManagedRoute(value: unknown): ManagedRoute | undefined {
  const item = value as ManagedRoute | undefined;
  if (!item || typeof item !== "object") return undefined;
  if (item.ssh && typeof item.ssh.target === "string" && /^[\w][\w.@:[\]-]{0,254}$/u.test(item.ssh.target) && ["linux", "darwin"].includes(item.ssh.platform) && validPort(item.ssh.port)) return { ssh: item.ssh };
  if (item.connect && validConnectRoute(item.connect)) return { connect: item.connect };
  if (typeof item.wsl === "string" && item.wsl.length <= 100 && item.wsl.trim() && !/[\r\n\0]/u.test(item.wsl)) return { wsl: item.wsl };
  return undefined;
}
function validPort(port: number): boolean { return Number.isInteger(port) && port > 0 && port < 65_536; }
export function validConnectRoute(route: ConnectRoute): boolean {
  try {
    const url = new URL(route.relay);
    return url.protocol === "https:" && !url.username && !url.password && /^[a-f0-9-]{36}$/u.test(route.id) && /^[A-Za-z0-9_-]{43}$/u.test(route.token) && validPort(route.port);
  } catch { return false; }
}

export interface ConnectOffer { version: 1; relay: string; id: string; token: string; link: string }
export function encodeConnectOffer(offer: ConnectOffer): string {
  return `tau-connect:${encodeURIComponent(JSON.stringify(offer))}`;
}
export function decodeConnectOffer(text: string): ConnectOffer | undefined {
  if (!text.startsWith("tau-connect:") || text.length > 16_384) return undefined;
  try {
    const offer = JSON.parse(decodeURIComponent(text.slice("tau-connect:".length))) as ConnectOffer;
    return offer.version === 1 && validConnectRoute({ ...offer, port: 1 }) && typeof offer.link === "string" ? offer : undefined;
  } catch { return undefined; }
}
