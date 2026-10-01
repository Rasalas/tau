import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronRight, RotateCcw, Settings2, Smartphone } from "lucide-react";
import { Button, HelpTip, Select, Slider } from "tau";
import type { Device, FoldState } from "./protocol.js";
import { articulated, bodyProfile, captureRegion, captureSurface, nativeAngle, panelGeometry, type BodyLayout, type PanelGeometry, type ScreenSize } from "./pose-model.js";

type Vars = CSSProperties & Record<`--${string}`, string | number>;
function Screen({ image, crop, cover = false, source }: { image: string; crop: PanelGeometry["crop"]; cover?: boolean; source?: HTMLCanvasElement }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const output = canvas.current, context = output?.getContext("2d");
    if (!source || !output || !context) return;
    let frame: number;
    const draw = () => {
      const { x, y, width, height } = captureRegion(source, crop);
      if (output.width !== width || output.height !== height) { output.width = width; output.height = height; }
      if (width > 0 && height > 0) context.drawImage(source, x, y, width, height, 0, 0, width, height);
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [source, crop.x, crop.y, crop.width, crop.height]);
  return <div className={`devices-pose-display${cover ? " devices-pose-cover" : ""}`} data-crop={`${crop.x},${crop.y},${crop.width},${crop.height}`}>
    {source ? <canvas ref={canvas} /> : <img src={image} alt="" draggable={false} style={{ width: `${100 / crop.width}%`, height: `${100 / crop.height}%`, left: `${-100 * crop.x / crop.width}%`, top: `${-100 * crop.y / crop.height}%`, objectFit: cover ? "contain" : "fill" }} />}
  </div>;
}
function Panel({ panel, image, front, cover, index, source }: { panel: PanelGeometry; image: string; front: boolean; cover: boolean; index: number; source?: HTMLCanvasElement }) {
  return <div className="devices-pose-panel" data-panel={index} style={{ left: panel.x, top: panel.y, width: panel.width, height: panel.height, transformOrigin: panel.origin, transform: panel.transform }}>
    <div className="devices-pose-front">{front && <Screen source={source} image={image} crop={panel.crop} />}</div>
    <div className="devices-pose-back">{cover && <Screen source={source} image={image} crop={{ x: 0, y: 0, width: 1, height: 1 }} cover />}</div>
    <span className="devices-pose-edge devices-pose-edge-left" /><span className="devices-pose-edge devices-pose-edge-right" /><span className="devices-pose-edge devices-pose-edge-top" /><span className="devices-pose-edge devices-pose-edge-bottom" />
  </div>;
}
/** Presentation owns no native actions. Its preview hinge never changes the emulator. */
export default function DevicePoseView({ image, device, fold, source, captureReady = true, onInteract }: { image: string; device: Device; fold?: FoldState; source?: HTMLCanvasElement; captureReady?: boolean; onInteract?: () => void }) {
  const profile = bodyProfile(device, fold);
  const [layoutChoice, setLayoutChoice] = useState<BodyLayout>();
  const layout = layoutChoice ?? profile.layout;
  const [decoded, setDecoded] = useState<{ image: string; size: ScreenSize }>();
  const size = source?.width && source.height ? { width: source.width, height: source.height } : decoded?.image === image ? decoded.size : undefined;
  const inner = useRef<ScreenSize | undefined>(undefined);
  const scene = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 400, height: 400 });
  const [yaw, setYaw] = useState(-24), [pitch, setPitch] = useState(12), [zoom, setZoom] = useState(1);
  const [preview, setPreview] = useState<number>();
  const dragging = useRef<{ id: number; x: number; y: number; yaw: number; pitch: number } | undefined>(undefined);
  const actualAngle = nativeAngle(fold);
  const angle = preview ?? actualAngle ?? 180;
  useEffect(() => {
    const element = scene.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setViewport({ width: entry.contentRect.width, height: entry.contentRect.height }); });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { setPreview(undefined); }, [actualAngle]);
  // Keep the last confirmed interior dimensions when the native display switches to the cover.
  if (captureReady && size && (!articulated(layout) || fold?.posture === "opened" || fold?.posture === "half_opened") &&
    (!inner.current || Math.abs(size.width / size.height - inner.current.width / inner.current.height) < .025)) inner.current = size;
  const surface = captureReady && size ? captureSurface(layout, size, inner.current, fold) : "unmapped";
  const dimensions = inner.current ?? size;
  const aspect = dimensions ? dimensions.width / dimensions.height : 1;
  // Initial closed captures have no interior dimensions. A generic body is explicit in the caption.
  const bodyAspect = articulated(layout) && !inner.current && fold?.posture === "closed" ? (layout === "flip" ? .5 : 1) : aspect;
  const height = Math.min(700, Math.max(40, viewport.height - 48), Math.max(40, viewport.width - 80) / bodyAspect);
  const width = height * bodyAspect;
  const depth = Math.max(6, Math.min(12, height * .026));
  const front = surface === "front" && angle > 5;
  const cover = surface === "cover" && angle < 90;
  const panels = panelGeometry(layout, width, height, angle);
  const reset = () => { setYaw(-24); setPitch(12); setZoom(1); setPreview(undefined); };
  return <div className="devices-pose">
    {image && <img className="devices-pose-probe" src={image} alt="" onLoad={(event) => { const { naturalWidth, naturalHeight } = event.currentTarget; if (naturalWidth && naturalHeight) setDecoded({ image, size: { width: naturalWidth, height: naturalHeight } }); }} />}
    <div ref={scene} className="devices-pose-scene" aria-label={`${device.name} 3D inspection`} role="img" onPointerDown={(event) => {
      if (event.button !== 0) return;
      dragging.current = { id: event.pointerId, x: event.clientX, y: event.clientY, yaw, pitch };
      event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerMove={(event) => {
      const start = dragging.current;
      if (!start || start.id !== event.pointerId) return;
      setYaw(start.yaw + (event.clientX - start.x) * .6);
      setPitch(Math.max(-85, Math.min(85, start.pitch - (event.clientY - start.y) * .6)));
    }} onPointerUp={() => { dragging.current = undefined; }} onPointerCancel={() => { dragging.current = undefined; }} onLostPointerCapture={() => { dragging.current = undefined; }} onWheel={(event) => { setZoom((value) => Math.max(.5, Math.min(1.8, value - event.deltaY * .001))); }}>
      {size ? <div className="devices-pose-body" data-layout={layout} data-angle={angle} data-surface={surface} style={{ width, height, transform: `scale(${zoom}) rotateX(${pitch}deg) rotateY(${yaw - (articulated(layout) ? (180 - Math.min(180, angle)) / 2 : 0)}deg)`, "--device-depth": `${depth}px`, "--device-half-depth": `${depth / 2}px`, "--device-radius": `${layout === "tablet" ? 12 : 18}px` } as Vars}>
        {panels.map((panel, index) => <Panel key={index} panel={panel} index={index} image={image} source={source} front={front} cover={cover && index === 1} />)}
        {articulated(layout) && <span className={`devices-pose-hinge${layout === "flip" ? " devices-pose-hinge-horizontal" : ""}`} />}
      </div> : <span>Loading screen dimensions…</span>}
    </div>
    <div className="devices-pose-caption">
      <span>Drag to rotate · Scroll to zoom</span>
      <HelpTip text={`${layoutChoice ? "User-selected generic layout" : profile.label}. Generic frame and back, not a measured hardware model. Switch to the flat screen for touch input.`} />
      {onInteract && <Button variant="ghost" icon={<Smartphone size={13} />} onClick={onInteract}>Control screen</Button>}
    </div>
    {preview !== undefined && <div className="devices-pose-preview-note" role="status"><span>Preview hinge changes this view only.</span><Button variant="ghost" onClick={() => setPreview(undefined)}>Follow device posture</Button></div>}
    {!captureReady && <p className="devices-pose-note" role="status">Updating the device screen…</p>}
    {articulated(layout) && captureReady && <p className="devices-pose-note">{surface === "unmapped" ? "Open the device to match its screen to the 3D view." : surface === "cover" ? "Cover screen" : "Interior screen"}</p>}
    <details className="devices-pose-options">
      <summary><Settings2 size={13} />View controls<ChevronRight size={13} /></summary>
      <div className="devices-pose-options-body">
        <div className="devices-pose-adjustments">
          <label className="devices-pose-adjustment"><span>Turn</span><Slider label="3D turn" min={-180} max={180} value={((yaw + 180) % 360 + 360) % 360 - 180} unit="°" onPreview={setYaw} onCommit={setYaw} /></label>
          <label className="devices-pose-adjustment"><span>Tilt</span><Slider label="3D tilt" min={-85} max={85} value={pitch} unit="°" onPreview={setPitch} onCommit={setPitch} /></label>
          <label className="devices-pose-adjustment"><span>Zoom</span><Slider label="3D zoom" min={.5} max={1.8} step={.05} value={zoom} format={(value) => `${Math.round(value * 100)}%`} onPreview={setZoom} onCommit={setZoom} /></label>
        </div>
        {articulated(layout) && <><div className="devices-pose-hinge-control"><label>Preview hinge</label><Slider label="3D preview hinge" min={0} max={layout === "dual" ? 360 : 180} value={angle} unit="°" onPreview={setPreview} onCommit={setPreview} /></div><p className="devices-pose-note">Changes the preview only. Use Fold or Unfold to change the device.</p></>}
        <div className="devices-pose-options-footer">
          {fold?.supported && !profile.identified && <Select label="3D fold layout" value={layout} options={[{ value: "book", label: "Book" }, { value: "flip", label: "Clamshell" }, { value: "dual", label: "Dual screen" }]} onChange={(value) => { setLayoutChoice(value as BodyLayout); inner.current = undefined; }} />}
          <Button variant="ghost" icon={<RotateCcw size={13} />} aria-label="Reset view" onClick={reset}>Reset view</Button>
        </div>
      </div>
    </details>
  </div>;
}
