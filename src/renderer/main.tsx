import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
if (new URLSearchParams(window.location.search).has("rendererBenchmark")) {
  void import("./RendererBenchmark").then(({ default: RendererBenchmark }) => root.render(<RendererBenchmark />));
} else {
  root.render(<StrictMode><App /></StrictMode>);
}
