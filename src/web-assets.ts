/**
 * Web assets bolted onto the proxied PiKVM pages.
 *
 * `htmlInjection()` returns markup spliced into proxied HTML (head + body).
 * `serve()` serves our own bundle under `/_agent/...` (sidebar.html/js/css).
 *
 * The agent UI runs in a same-origin iframe so its Tailwind/React tree stays
 * isolated from the PiKVM page. A floating button toggles a slide-in panel.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ServerResponse, IncomingMessage } from "node:http";

/** Cookie the desktop shell sets on the proxy origin to suppress the injected UI. */
export const DESKTOP_SHELL_COOKIE = "agent_shell";

// Built assets sit beside the compiled server in dist/views (CJS bundle, so
// __dirname is the dist root — matching how main.ts resolves its views).
const assetDir = resolve(__dirname, "views");

const MIME: Record<string, string> = {
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
};

function asset(file: string): string | null {
    const p = resolve(assetDir, file);
    // Stay inside the asset dir.
    if (!p.startsWith(assetDir)) return null;
    if (!existsSync(p) || !statSync(p).isFile()) return null;
    return p;
}

// The agent UI is hosted in a same-origin iframe (pointing at our own
// /_agent/sidebar.html) so its Tailwind CSS and React tree are fully isolated
// from the PiKVM page we inject into. A floating button toggles a slide-in panel
// that is a docked sidebar on desktop and a full-screen sheet on mobile.
// Viewport + PWA install metadata so the client can be added to a phone's home
// screen and launch full-screen (standalone), vaultwarden-style. iOS honours the
// apple-* tags over plain HTTP; the manifest + theme-color drive Android/desktop.
const HEAD_INJECT =
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5, user-scalable=yes, viewport-fit=cover" data-pikvm-agent>' +
    '<link rel="manifest" href="/_agent/manifest.webmanifest" data-pikvm-agent>' +
    '<meta name="theme-color" content="#0b0d12" data-pikvm-agent>' +
    '<meta name="mobile-web-app-capable" content="yes" data-pikvm-agent>' +
    '<meta name="apple-mobile-web-app-capable" content="yes" data-pikvm-agent>' +
    '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" data-pikvm-agent>' +
    '<meta name="apple-mobile-web-app-title" content="PiKVM" data-pikvm-agent>' +
    '<link rel="apple-touch-icon" href="/_agent/icon.png" data-pikvm-agent>';

const BODY_INJECT = `
<style data-pikvm-agent>
  #pikvm-agent-host{position:fixed;top:0;right:0;height:100%;width:min(440px,100vw);transform:translateX(105%);
    transition:transform .22s cubic-bezier(.2,0,0,1);z-index:2147483004;background:#0b0d12;
    box-shadow:-10px 0 40px rgba(0,0,0,.5);display:flex;flex-direction:column}
  #pikvm-agent-host.open{transform:none}
  #pikvm-agent-frame{flex:1;width:100%;height:100%;border:0;display:block;background:#0b0d12}
  #pikvm-agent-close{position:absolute;top:max(10px,env(safe-area-inset-top));right:12px;width:34px;height:34px;
    border-radius:9px;border:0;cursor:pointer;z-index:2;display:none;align-items:center;justify-content:center;
    color:#e7e9ee;background:rgba(120,128,150,.18);-webkit-tap-highlight-color:transparent}
  #pikvm-agent-host.open #pikvm-agent-close{display:flex}
  #pikvm-agent-close svg{width:18px;height:18px}
  #pikvm-agent-fab{position:fixed;bottom:max(16px,env(safe-area-inset-bottom));right:16px;width:52px;height:52px;
    border-radius:50%;border:0;cursor:pointer;z-index:2147483003;display:flex;align-items:center;justify-content:center;
    color:#fff;background:#3b6ef0;box-shadow:0 6px 20px rgba(0,0,0,.45);-webkit-tap-highlight-color:transparent;
    transition:opacity .15s,transform .15s}
  #pikvm-agent-fab.hidden{opacity:0;transform:scale(.6);pointer-events:none}
  #pikvm-agent-fab svg{width:24px;height:24px}
  @media (max-width:640px){#pikvm-agent-host{width:100vw}}
</style>
<div id="pikvm-agent-host" aria-hidden="true">
  <button id="pikvm-agent-close" type="button" aria-label="Close agent" title="Close">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
  </button>
</div>
<button id="pikvm-agent-fab" type="button" aria-label="Toggle agent" title="Agent">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/><circle cx="18" cy="17" r="2.4"/></svg>
</button>
<script data-pikvm-agent>(function(){
  if (window.top !== window.self) return; // never inject inside our own iframe
  var host=document.getElementById('pikvm-agent-host');
  var fab=document.getElementById('pikvm-agent-fab');
  var closeBtn=document.getElementById('pikvm-agent-close');
  var loaded=false;
  function setOpen(open){
    host.classList.toggle('open', open);
    host.setAttribute('aria-hidden', open?'false':'true');
    // Hide the FAB while the panel is open so it never sits over the chat; the
    // in-panel close button takes over.
    fab.classList.toggle('hidden', open);
    if(open && !loaded){
      var f=document.createElement('iframe');
      f.id='pikvm-agent-frame'; f.title='Agent'; f.src='/_agent/sidebar.html';
      host.appendChild(f); loaded=true;
    }
  }
  function toggle(){ setOpen(!host.classList.contains('open')); }
  fab.addEventListener('click',toggle);
  closeBtn.addEventListener('click',function(){ setOpen(false); });
  // Install the agent-shell service worker only in a secure context (HTTPS or
  // localhost); over a plain-http LAN it is skipped silently (no console noise).
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', function(){
      navigator.serviceWorker.register('/_agent/sw.js', {scope:'/_agent/'}).catch(function(){});
    });
  }
})();</script>
<script data-pikvm-agent src="/_agent/touch.js" defer></script>
`;

export const webAssets = {
    /**
     * Markup injected into proxied HTML: head (viewport) + body (agent UI). The
     * desktop shell (identified by its cookie) gets the viewport only - it has its
     * own native sidebar, so the floating panel would be a duplicate.
     */
    htmlInjection(req: IncomingMessage): { head: string; body: string } {
        const isDesktopShell = (req.headers.cookie ?? "").includes(`${DESKTOP_SHELL_COOKIE}=desktop`);
        return { head: HEAD_INJECT, body: isDesktopShell ? "" : BODY_INJECT };
    },

    /** Serve `/_agent/<file>`; returns true if handled. */
    serve(subPath: string, res: ServerResponse): boolean {
        const file = subPath.replace(/^\/+/, "");
        if (!file) return false;
        const p = asset(file);
        if (!p) return false;
        const ext = file.slice(file.lastIndexOf("."));
        res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "no-cache" });
        res.end(readFileSync(p));
        return true;
    },
};
