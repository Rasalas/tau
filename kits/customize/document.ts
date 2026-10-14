import { preparePageDocument } from "../html-pages/document.js";
import { SCRIPT_MESSAGES } from "./protocol.js";

// `window.tau` in a user script: shared data, a page, a command. Requests go to the client drawing the frame.
const BRIDGE = `(function(){var n=0,subs={};function post(m){try{window.parent.postMessage(m,"*");}catch(e){}}`
  + `function request(method,params){post({jsonrpc:"2.0",id:"tau-"+(++n),method:method,params:params||{}});}`
  + `window.addEventListener("message",function(e){if(e.source!==window.parent)return;var m=e.data;if(!m||m.method!==${JSON.stringify(SCRIPT_MESSAGES.data)}||!m.params)return;`
  + `var l=subs[m.params.id];if(l)l.forEach(function(f){try{f(m.params.value);}catch(err){console.error(err);}});});`
  + `window.tau={`
  + `data:function(id,f){(subs[id]=subs[id]||[]).push(f);if(subs[id].length===1)request(${JSON.stringify(SCRIPT_MESSAGES.subscribe)},{id:id});`
  + `return function(){subs[id]=(subs[id]||[]).filter(function(g){return g!==f;});if(!subs[id].length){delete subs[id];request(${JSON.stringify(SCRIPT_MESSAGES.unsubscribe)},{id:id});}};},`
  + `openPage:function(id,params){request(${JSON.stringify(SCRIPT_MESSAGES.openPage)},{id:id,params:params||{}});},`
  + `runCommand:function(id){request(${JSON.stringify(SCRIPT_MESSAGES.runCommand)},{id:id});}`
  + `};})();`;

const WIDTH_REPORTER = `(function(){var w;function z(){var v=Math.ceil(document.documentElement.getBoundingClientRect().width);if(v===w)return;w=v;try{window.parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(SCRIPT_MESSAGES.width)},params:{width:v}},"*");}catch(e){}}`
  + `if(window.ResizeObserver)new ResizeObserver(z).observe(document.documentElement);document.addEventListener("DOMContentLoaded",z);window.addEventListener("load",z);})();`;

/**
 * A user script as its frame loads it: html-pages' theme, height and link
 * reporter, then the `tau` bridge, then the user's own markup.
 */
export function prepareScriptDocument(html: string, options: { theme?: unknown; inline?: boolean } = {}): string {
  // A fragment ("<div>…</div><script>…</script>") is the common case; give it a transparent body.
  const document = /<html[\s>]/iu.test(html) ? html : `<!doctype html><html><head><style>html,body{background:transparent}</style></head><body>${html}</body></html>`;
  const prepared = preparePageDocument(document, options);
  const head = /<head(?:\s[^>]*)?>/iu.exec(prepared);
  const at = head ? head.index + head[0].length : 0;
  // After the theme and the reporter preparePageDocument put first in the head.
  const after = prepared.indexOf("</script>", at);
  const insert = after >= 0 ? after + "</script>".length : at;
  // Inside a row the frame is as wide as what the script drew, so the document reports its own width too.
  const inline = options.inline ? `<style>html{width:max-content}</style><script>${WIDTH_REPORTER}</script>` : "";
  return `${prepared.slice(0, insert)}<script>${BRIDGE}</script>${inline}${prepared.slice(insert)}`;
}
