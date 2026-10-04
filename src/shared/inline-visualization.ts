import { VISUALIZATION_ICONS } from "./visualization-icons.js";

export const VISUALIZATION_MAX_BYTES = 1024 * 1024;
/** Applied as a response header, independently of the workbench's CSP. */
export const VISUALIZATION_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

// Local-only state and basic controls. No bridge to prompts, tools, files, or parent DOM.
const runtime = `(() => {
  let state = null;
  window.openai = Object.freeze({get widgetState(){return state},setWidgetState:async value=>{
    const serialized=JSON.stringify(value);if(typeof serialized!=='string'||new TextEncoder().encode(serialized).length>16384)throw new Error('Visualization state exceeds 16 KiB.');
    state=JSON.parse(serialized);
  }});
  const icons = ICONS;
  window.lucide = {createIcons:()=>document.querySelectorAll('[data-lucide]').forEach(placeholder=>{
    const nodes=icons[placeholder.getAttribute('data-lucide')]; if(!nodes)return;
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    for(const [key,value] of Object.entries({viewBox:'0 0 24 24',width:'16',height:'16',fill:'none',stroke:'currentColor','stroke-width':'2','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))svg.setAttribute(key,value);
    for(const [tag,attrs] of nodes){const child=document.createElementNS(svg.namespaceURI,tag);for(const [key,value] of Object.entries(attrs))if(key!=='key')child.setAttribute(key,String(value));svg.append(child)}
    placeholder.replaceWith(svg);
  })};
  document.addEventListener('click',event=>{
    const tab=event.target.closest('[role="tab"]');if(!tab||tab.disabled||tab.getAttribute('aria-disabled')==='true')return;
    const group=tab.closest('[role="tablist"]');if(!group)return;
    group.querySelectorAll('[role="tab"]').forEach(other=>{const active=other===tab;other.classList.toggle('active',active);other.setAttribute('aria-selected',String(active));const panel=document.getElementById(other.getAttribute('aria-controls'));if(panel)panel.hidden=!active});
  });
  document.addEventListener('DOMContentLoaded',()=>{
    window.lucide.createIcons();
    const post=()=>parent.postMessage({type:'tau-visualization-height',height:Math.ceil(document.body.getBoundingClientRect().height)},'*');
    new ResizeObserver(post).observe(document.body);post();
    // Link interactions stay local; the host separately denies frame navigation.
    document.addEventListener('click',event=>{if(event.target.closest('a'))event.preventDefault()},true);
  });
})();`;

const styles = `
:root{color-scheme:light;--background:#fff;--foreground:#242424;--card:#f5f5f4;--card-foreground:#242424;--primary:#292929;--primary-foreground:#fff;--secondary:#eee;--secondary-foreground:#242424;--muted:#eee;--muted-foreground:#666;--accent:#eee;--accent-foreground:#242424;--border:#ddd;--input:#ddd;--ring:#777;--destructive:#b42318;--blue:#2563eb;--orange:#b45309;--green:#15803d;--red:#b91c1c;--purple:#7e22ce;--yellow:#a16207;--font-size-base:14px;--viz-series-1:var(--blue);--viz-series-2:var(--orange);--viz-series-3:var(--green);--viz-series-4:var(--purple);--viz-series-5:var(--red);--viz-series-6:var(--yellow)}
:root[data-theme=dark]{color-scheme:dark;--background:#181818;--foreground:#e4e4e4;--card:#242424;--card-foreground:#e4e4e4;--primary:#ddd;--primary-foreground:#181818;--secondary:#303030;--secondary-foreground:#ddd;--muted:#303030;--muted-foreground:#aaa;--accent:#303030;--accent-foreground:#ddd;--border:#444;--input:#444;--blue:#86b4ff;--orange:#f1aa63;--green:#85cda0;--red:#ee9696;--purple:#c4a3ee;--yellow:#e2c877;--destructive:#ee9696}
*{box-sizing:border-box}html,body{margin:0;padding:0;background:transparent;color:var(--foreground);font:400 var(--font-size-base)/1.5 system-ui,sans-serif}body{overflow-wrap:anywhere}button,input,select,textarea{font:inherit;color:inherit}button,.cursor-interaction{cursor:pointer}[hidden]{display:none!important}h1,h2,h3{font-weight:500}h1{font-size:1.4rem}h2{font-size:1.2rem}h3{font-size:1rem}.card{background:var(--card);color:var(--card-foreground);padding:16px;border-radius:10px}.viz-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:12px}.viz-row,.viz-controls{display:flex;flex-wrap:wrap;align-items:center;gap:12px}.viz-stat-value{font-size:1.7em;font-weight:500}.text-small{font-size:max(11px,.85em)}.text-muted{color:var(--muted-foreground)}.text-destructive{color:var(--destructive)}.tabular-nums,.text-end{font-variant-numeric:tabular-nums}.text-end{text-align:right}.text-center{text-align:center}.text-nowrap{white-space:nowrap}.btn,.nav-link{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--border);border-radius:6px;padding:6px 10px;background:var(--secondary);color:var(--secondary-foreground)}.btn-primary,.btn[aria-pressed=true]{background:var(--primary);color:var(--primary-foreground)}.btn-ghost,.nav-link{background:transparent;border-color:transparent}.btn-block{width:100%}.nav{display:flex;flex-wrap:wrap;gap:4px}.nav-link.active{background:var(--secondary)}.form-label{display:flex;flex-direction:column;gap:4px}.form-control,.form-select{border:1px solid var(--input);border-radius:6px;background:var(--background);padding:6px 8px;max-width:100%}.form-range{accent-color:var(--primary);max-width:100%}.form-check{display:inline-flex;align-items:center;gap:8px}.form-check-input{accent-color:var(--primary)}.progress{background:var(--muted);height:8px;border-radius:4px;overflow:hidden}.progress-bar{background:var(--viz-series-1);height:100%}.viz-badge{border-radius:20px;padding:2px 8px;background:var(--accent);color:var(--accent-foreground)}.table{border-collapse:collapse;width:100%}.table td,.table th{text-align:left;padding:8px;border-bottom:1px solid var(--border)}.table-sm td,.table-sm th{padding:4px}.table-responsive{overflow-x:auto}hr{border:0;border-top:1px solid var(--border)}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}code{font-family:monospace}svg{max-width:100%}@media(pointer:coarse){.btn,.nav-link,input,select{min-height:44px}input,textarea,select{font-size:16px}}
`;

/** Host-owned wrapper for a bounded HTML fragment, never injected into the workbench DOM. */
export function buildVisualizationDocument(fragment: string, theme: "light" | "dark" = "light"): string {
  const bootstrap = runtime.replace("ICONS", JSON.stringify(VISUALIZATION_ICONS));
  return `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}</style><script>${bootstrap}</script></head><body>${fragment}</body></html>`;
}
