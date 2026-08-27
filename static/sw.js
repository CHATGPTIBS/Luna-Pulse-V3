const C="luna-v33-shell-1";
self.addEventListener("install",e=>{
  self.skipWaiting();
  e.waitUntil(caches.open(C).then(x=>x.addAll(["/","/manifest.json"])));
});
self.addEventListener("activate",e=>{
  e.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(k=>k!==C).map(k=>caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch",e=>{
  const u=new URL(e.request.url);
  if(u.pathname.startsWith("/api/")) return;
  e.respondWith(fetch(e.request).catch(()=>caches.match(e.request)));
});
