const V='sentinel-v1';
const CORE=['./','index.html','style.css','script.js','manifest.json','offline.html','favicon.ico','icon-192.png','icon-512.png','assets/og-image.png','assets/alarm.mp3','database/offline-tips.json','config/sources.json'];
self.addEventListener('install',e=>e.waitUntil(caches.open(V).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(n=>n!==V).map(n=>caches.delete(n)))).then(()=>self.clients.claim())));
async function ranged(req,res){
  const b=await res.arrayBuffer(),m=/bytes=(\d+)-(\d*)/.exec(req.headers.get('range')),s=+m[1],e=m[2]?+m[2]:b.byteLength-1;
  return new Response(b.slice(s,e+1),{status:206,headers:{'Content-Type':res.headers.get('Content-Type')||'audio/mpeg','Content-Range':'bytes '+s+'-'+e+'/'+b.byteLength,'Content-Length':e-s+1}});
}
self.addEventListener('fetch',e=>{
  const r=e.request,u=new URL(r.url);
  if(r.method!=='GET'||u.origin!==location.origin)return;
  e.respondWith((async()=>{
    const hit=await caches.match(r,{ignoreSearch:true});
    if(hit)return r.headers.get('range')?ranged(r,hit):hit;
    try{const n=await fetch(r);if(n.ok&&!r.headers.get('range')){const c=await caches.open(V);c.put(r,n.clone());}return n;}
    catch(err){if(r.mode==='navigate')return caches.match('offline.html');return new Response('',{status:504});}
  })());
});
