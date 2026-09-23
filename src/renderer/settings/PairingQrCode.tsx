import { useEffect, useState } from "react";

/** One path of unit squares for the dark modules; the SVG scales it. */
export function qrPath(modules: readonly (readonly boolean[])[]): string {
  let path = "";
  modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) path += `M${x} ${y}h1v1h-1z`; }));
  return path;
}

/** A pairing URL as a QR code. The encoder loads with the first code, not with Settings. */
export function PairingQrCode({ value, size = 168 }: { value: string; size?: number }) {
  const [code, setCode] = useState<{ value: string; size: number; path: string }>();
  useEffect(() => {
    let live = true;
    void import("uqr").then(({ encode }) => {
      const { data, size: modules } = encode(value, { ecc: "M", border: 2 });
      if (live) setCode({ value, size: modules, path: qrPath(data) });
    });
    return () => { live = false; };
  }, [value]);
  if (!code || code.value !== value) return <div className="pairing-qr pending" style={{ width: size, height: size }} aria-busy="true" />;
  return (
    <svg className="pairing-qr" width={size} height={size} viewBox={`0 0 ${code.size} ${code.size}`} shapeRendering="crispEdges" role="img" aria-label="Pairing link as a QR code">
      <rect width={code.size} height={code.size} />
      <path d={code.path} />
    </svg>
  );
}
