const C="luna-v3-shell-1";
self.addEventListener("install",e=>e.waitUntil(caches.open(C).then(x=>x.addAll(["/","/manifest.json"]))));
self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));
self.addEventListener("fetch",e=>{
  const u=new URL(e.request.url);
  if(u.pathname.startsWith("/api/")) return;
  e.respondWith(fetch(e.request).catch(()=>caches.match(e.request)));
});