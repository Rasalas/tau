import { useState } from "react";
/** A small inspection shell. Platform rotation and fold changes remain explicit device actions. */
export default function DevicePoseView({ image, name }: { image: string; name: string }) {
  const [yaw, setYaw] = useState(-18), [pitch, setPitch] = useState(8), [zoom, setZoom] = useState(1);
  return <div className="devices-pose">
    <div className="devices-pose-scene"><div className="devices-pose-shell" style={{ transform: `scale(${zoom}) rotateX(${pitch}deg) rotateY(${yaw}deg)` }}><img src={image} alt={`${name} 3D inspection`} draggable={false} /><span className="devices-pose-side" /></div></div>
    <div className="devices-toolbar"><label>Turn <input aria-label="3D turn" type="range" min="-70" max="70" value={yaw} onChange={(event) => setYaw(Number(event.target.value))} /></label><label>Tilt <input aria-label="3D tilt" type="range" min="-45" max="45" value={pitch} onChange={(event) => setPitch(Number(event.target.value))} /></label><label>Zoom <input aria-label="3D zoom" type="range" min="0.5" max="1.3" step="0.05" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /></label><button onClick={() => { setYaw(-18); setPitch(8); setZoom(1); }}>Reset view</button></div>
    <small>Inspect the screen in perspective. Switch to the flat screen for touch input. Device rotation and fold posture use the controls below.</small>
  </div>;
}
