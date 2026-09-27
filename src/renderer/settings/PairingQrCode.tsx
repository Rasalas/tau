import { useEffect, useState } from "react";
import { Dialog } from "../components/ui/Dialog";
import { DialogClose } from "../pairing/dialog-parts";

/** One path of unit squares for the dark modules; the SVG scales it. */
export function qrPath(modules: readonly (readonly boolean[])[]): string {
  let path = "";
  modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) path += `M${x} ${y}h1v1h-1z`; }));
  return path;
}

interface EncodedQr { value: string; size: number; version: number; path: string }

/**
 * The smallest code the value fits in: a screen neither covers nor wears it,
 * so larger modules help a camera more than correction. Unused room in that
 * version still goes to correction (`boostEcc`).
 */
export async function encodePairingQr(value: string): Promise<EncodedQr> {
  const { encode } = await import("uqr");
  const { data, size, version } = encode(value, { ecc: "L", boostEcc: true, border: 2 });
  return { value, size, version, path: qrPath(data) };
}

function QrSvg({ code, size, className }: { code: EncodedQr; size?: number; className: string }) {
  return (
    <svg className={className} {...(size ? { width: size, height: size } : {})} viewBox={`0 0 ${code.size} ${code.size}`} shapeRendering="crispEdges" role="img" aria-label="Pairing link as a QR code">
      <rect width={code.size} height={code.size} />
      <path d={code.path} />
    </svg>
  );
}

/** A pairing URL as a QR code; a click shows it as large as the window allows. The encoder loads with the first code, not with Settings. */
export function PairingQrCode({ value, size = 208 }: { value: string; size?: number }) {
  const [code, setCode] = useState<EncodedQr>();
  const [large, setLarge] = useState(false);
  useEffect(() => {
    let live = true;
    void encodePairingQr(value).then((encoded) => { if (live) setCode(encoded); });
    return () => { live = false; };
  }, [value]);
  if (!code || code.value !== value) return <div className="pairing-qr pending" style={{ width: size, height: size }} aria-busy="true" />;
  return (
    <>
      <button type="button" className="pairing-qr-button" title="Show larger" aria-label="Show the QR code larger" onClick={() => setLarge(true)}>
        <QrSvg code={code} size={size} className="pairing-qr" />
      </button>
      {large ? (
        <Dialog className="pairing-qr-dialog" label="Pairing QR code" onClose={() => setLarge(false)}>
          <button type="button" className="pairing-qr-dialog-code" aria-label="Close the large QR code" onClick={() => setLarge(false)}>
            <QrSvg code={code} className="pairing-qr" />
          </button>
          <p>Scan it with the Tau app or the phone's camera. Esc or a click closes it.</p>
          <DialogClose onClose={() => setLarge(false)} />
        </Dialog>
      ) : null}
    </>
  );
}
