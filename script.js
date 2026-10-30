'use strict';
/* Sentinel Alert Dubai - vanilla ES6, zero build. */
const POLL_MS = 60000;
const KEYWORDS = ['jebel ali','discovery gardens','dubai','uae','strike','missile','blast','evacuation','airspace','civil defense','civil defence'];
const GEO = ['jebel ali','discovery gardens','dubai','uae','united arab emirates','emirates'];
const CRIT = ['missile','strike','blast','explosion','attack','drone','evacuation','airspace','civil defense','civil defence','siren','shelter'];
const DEFAULT_SOURCES = [
  {id:'gn-incident',name:'Google News: Dubai incidents',type:'rss',url:'https://news.google.com/rss/search?q=(Dubai+OR+UAE+OR+%22Jebel+Ali%22)+(missile+OR+strike+OR+blast+OR+evacuation+OR+airspace+OR+%22civil+defense%22)+when:2d&hl=en&gl=AE&ceid=AE:en'},
  {id:'gn-local',name:'Google News: Jebel Ali / Discovery Gardens',type:'rss',url:'https://news.google.com/rss/search?q=%22Jebel+Ali%22+OR+%22Discovery+Gardens%22+when:2d&hl=en&gl=AE&ceid=AE:en'},
  {id:'gdacs',name:'GDACS Global Disaster Alerts',type:'rss',url:'https://www.gdacs.org/xml/rss.xml'},
  {id:'usgs',name:'USGS Earthquakes (M2.5+ 24h)',type:'usgs',url:'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson'}
];
const norm = s => String(s || '').toLowerCase();

function classify(item){
  const t = norm(item.title + ' ' + (item.summary || ''));
  const kw = KEYWORDS.filter(k => t.includes(k));
  const geo = GEO.some(g => t.includes(g));
  const crit = CRIT.filter(k => t.includes(k));
  let sev = 'info';
  if (item.forceSev) sev = item.forceSev;
  else if (geo && crit.length) sev = 'critical';
  else if (geo && kw.length > 1 || crit.length >= 2) sev = 'elevated';
  return Object.assign({}, item, {kw, geo, sev, match: kw.length > 0 || !!item.forceKeep});
}
function computeStatus(items, now){
  now = now || Date.now();
  const age = i => now - (i.ts || 0);
  if (items.some(i => i.sev === 'critical' && age(i) < 12*3600e3)) return 'critical';
  if (items.some(i => (i.sev === 'elevated' || i.sev === 'critical') && age(i) < 24*3600e3)) return 'heightened';
  return 'normal';
}
function parseDate(s){
  if (!s) return 0;
  if (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s)) s = s.replace(' ','T') + 'Z';
  const t = Date.parse(s); return isNaN(t) ? 0 : t;
}
function ago(ts){
  if (!ts) return 'time unknown';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now'; if (m < 60) return m + ' min ago';
  if (m < 1440) return Math.round(m/60) + ' h ago'; return Math.round(m/1440) + ' d ago';
}
const strip = h => { try { return (new DOMParser().parseFromString(String(h||''),'text/html').body.textContent||'').trim(); } catch(e){ return String(h||''); } };

if (typeof module !== 'undefined') module.exports = {classify, computeStatus, parseDate, KEYWORDS, GEO, CRIT};

if (typeof document !== 'undefined') (function(){
const $ = id => document.getElementById(id);
const S = {cache:{}, seen:new Set(), items:[], armed:false, siren:null, sirenOn:false, countdown:POLL_MS/1000, polling:false, sources:DEFAULT_SOURCES, tips:[], cat:'All'};

/* ---- IndexedDB key/value with localStorage fallback ---- */
const DB = {
  open(){ return new Promise((res,rej)=>{ const r = indexedDB.open('sentinel',1); r.onupgradeneeded=()=>r.result.createObjectStore('kv'); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); },
  async get(k){ try{ const db = await this.open(); return await new Promise((res,rej)=>{ const q=db.transaction('kv').objectStore('kv').get(k); q.onsuccess=()=>res(q.result); q.onerror=()=>rej(q.error); }); }catch(e){ try{return JSON.parse(localStorage.getItem('s_'+k));}catch(_){return null;} } },
  async set(k,v){ try{ const db = await this.open(); await new Promise((res,rej)=>{ const t=db.transaction('kv','readwrite'); t.objectStore('kv').put(v,k); t.oncomplete=res; t.onerror=()=>rej(t.error); }); }catch(e){ try{localStorage.setItem('s_'+k,JSON.stringify(v));}catch(_){} } }
};

/* ---- network helpers ---- */
async function http(url, kind){
  const c = new AbortController(); const t = setTimeout(()=>c.abort(), 12000);
  try { const r = await fetch(url,{signal:c.signal,cache:'no-store'}); if(!r.ok) throw new Error('HTTP '+r.status); return kind==='json'? await r.json() : await r.text(); }
  finally { clearTimeout(t); }
}
async function fetchRSS(url){
  try {
    const j = await http('https://api.rss2json.com/v1/api.json?rss_url='+encodeURIComponent(url),'json');
    if (j.status === 'ok' && j.items) return j.items.map(i=>({title:strip(i.title),summary:strip(i.description||i.content),link:i.link,ts:parseDate(i.pubDate)}));
  } catch(e){}
  const x = await http('https://api.allorigins.win/raw?url='+encodeURIComponent(url),'text');
  const d = new DOMParser().parseFromString(x,'text/xml');
  const g = (n,t)=>{const e=n.getElementsByTagName(t)[0]; return e?e.textContent:'';};
  const out = [...d.getElementsByTagName('item')].map(n=>({title:strip(g(n,'title')),summary:strip(g(n,'description')),link:g(n,'link'),ts:parseDate(g(n,'pubDate'))}));
  if(!out.length) throw new Error('empty feed'); return out;
}
async function fetchUSGS(url){
  const j = await http(url,'json');
  return (j.features||[]).filter(f=>/emirates|uae|oman|iran|persian|gulf|qatar|saudi/i.test(f.properties.place||'')).map(f=>{
    const p=f.properties, big=p.mag>=4.5;
    return {title:'M'+p.mag+' earthquake: '+p.place, summary:'USGS seismic event near the Gulf region', link:p.url, ts:p.time, forceKeep:true, forceSev: big?'elevated':'info'};
  });
}
async function fetchSource(s){ return s.type==='usgs' ? fetchUSGS(s.url) : fetchRSS(s.url); }

/* ---- connection UI ---- */
function setConn(state, text){ $('conn').className='conn '+state; $('connText').textContent=text; }
function refreshConn(){ if(!navigator.onLine) setConn('offline','Offline (cached)'); else if(S.polling) setConn('polling','Polling'); else setConn('online','Online'); }

/* ---- polling ---- */
async function poll(manual){
  if (S.polling) return; S.polling = true; refreshConn();
  const results = await Promise.allSettled(S.sources.map(fetchSource));
  let ok = 0;
  results.forEach((r,i)=>{ if(r.status==='fulfilled'){ ok++; S.cache[S.sources[i].id]={t:Date.now(),items:r.value}; } });
  S.polling = false;
  if (ok) { await DB.set('cache',S.cache); setConn('online','Online'); $('feedMeta').textContent = 'Updated '+new Date().toLocaleTimeString()+' ('+ok+'/'+S.sources.length+' sources)'; }
  else { setConn('offline','Offline (cached)'); $('feedMeta').textContent = 'Network unavailable. Showing last cached data.'; }
  rebuild(true); S.countdown = POLL_MS/1000;
}
function rebuild(notify){
  const seen = new Set(), all = [];
  Object.values(S.cache).forEach(c=>c.items.forEach(raw=>{
    const it = classify(raw); if(!it.match) return;
    const k = norm(it.title).slice(0,80); if(seen.has(k)) return; seen.add(k); it.id = k; all.push(it);
  }));
  const rank={critical:0,elevated:1,info:2};
  all.sort((a,b)=>rank[a.sev]-rank[b.sev] || (b.ts||0)-(a.ts||0));
  S.items = all.slice(0,60);
  const fresh = S.items.filter(i=>i.sev==='critical' && !S.seen.has(i.id));
  fresh.forEach(i=>S.seen.add(i.id)); DB.set('seen',[...S.seen]);
  renderBanner(); renderFeed();
  if (notify && fresh.length) alertUser(fresh[0]);
}

/* ---- rendering ---- */
function renderBanner(){
  const st = computeStatus(S.items), b = $('banner');
  const map = {normal:['NORMAL','No high-severity local alerts detected in the last 24h.'],heightened:['HEIGHTENED VIGILANCE','Elevated reports found. Stay alert and review safety tips.'],critical:['CRITICAL / IMMEDIATE ACTION','High-severity local report detected. Follow official instructions now. Call 999 / 997 / 998 if in danger.']};
  b.className='banner '+st; $('bTitle').textContent = map[st][0]; $('bSub').textContent = map[st][1];
  document.title = (st==='critical'?'\u26A0 ':'')+'Sentinel Alert Dubai';
}
function renderFeed(){
  const f = $('sevFilter').value, ul = $('feed'); ul.textContent='';
  const list = S.items.filter(i=> f==='all' || (f==='critical'&&i.sev==='critical') || (f==='elevated'&&i.sev!=='info'));
  if(!list.length){ const li=document.createElement('li'); li.className='empty'; li.textContent='No matching items yet.'; ul.appendChild(li); return; }
  list.forEach(i=>{
    const li=document.createElement('li'); li.className=i.sev;
    const tag=document.createElement('span'); tag.className='tag '+i.sev; tag.textContent=i.sev.toUpperCase();
    const a=document.createElement('a'); a.textContent=i.title; if(/^https?:/.test(i.link||'')){a.href=i.link;a.target='_blank';a.rel='noopener noreferrer';}
    const m=document.createElement('div'); m.className='m'; m.textContent=ago(i.ts)+(i.kw.length?' \u00B7 '+i.kw.join(', '):'');
    li.append(tag,a,m); ul.appendChild(li);
  });
}

/* ---- alerts: audio, vibration, notification ---- */
let ac=null, osc=null, lfo=null;
function startSiren(){
  stopSiren(); S.sirenOn=true; $('sirenBtn').classList.add('on'); $('sirenState').textContent='Tap to stop';
  const a = $('alarm'); a.loop = true;
  a.play().catch(()=>webSiren());
}
function webSiren(){
  try{
    ac = ac || new (window.AudioContext||window.webkitAudioContext)();
    osc = ac.createOscillator(); lfo = ac.createOscillator(); const g=ac.createGain();
    osc.type='sawtooth'; osc.frequency.value=900; lfo.frequency.value=0.7; g.gain.value=300;
    lfo.connect(g); g.connect(osc.frequency); osc.connect(ac.destination); osc.start(); lfo.start();
  }catch(e){}
}
function stopSiren(){
  S.sirenOn=false; $('sirenBtn').classList.remove('on'); $('sirenState').textContent='Tap to sound';
  const a=$('alarm'); a.pause(); a.currentTime=0;
  try{ osc&&osc.stop(); lfo&&lfo.stop(); }catch(e){} osc=lfo=null;
}
function alertUser(item){
  if (navigator.vibrate) navigator.vibrate([500,200,500,200,800]);
  if (S.armed) { startSiren(); setTimeout(()=>{ if(S.sirenOn) stopSiren(); }, 15000); }
  if (window.Notification && Notification.permission==='granted') { try{ new Notification('CRITICAL: Sentinel Dubai',{body:item.title,icon:'icon-192.png',tag:'sentinel'}); }catch(e){} }
}

/* ---- check-in ---- */
async function loadCheckins(){
  const list = (await DB.get('checkins')) || []; const ul=$('checkinLog'); ul.textContent='';
  list.slice(0,5).forEach(c=>{ const li=document.createElement('li'); li.textContent=new Date(c).toLocaleString(); ul.appendChild(li); });
  $('checkinLast').textContent = list.length ? 'Last check-in: '+new Date(list[0]).toLocaleString() : 'No check-in yet.';
  $('smsLink').href = 'sms:?&body='+encodeURIComponent('I am safe. Check-in '+(list[0]?new Date(list[0]).toLocaleString():'')+' (Discovery Gardens / Jebel Ali, Dubai).');
}
async function checkin(){ const list=(await DB.get('checkins'))||[]; list.unshift(Date.now()); await DB.set('checkins',list.slice(0,50)); $('checkinCard').hidden=false; loadCheckins(); }

/* ---- tips ---- */
function renderTips(){
  const q = norm($('tipSearch').value), ol=$('tips'); ol.textContent='';
  const cats = ['All'].concat([...new Set(S.tips.map(t=>t.cat))]);
  const chips=$('chips'); chips.textContent='';
  cats.forEach(c=>{ const b=document.createElement('button'); b.className='chip'+(c===S.cat?' on':''); b.textContent=c; b.onclick=()=>{S.cat=c;renderTips();}; chips.appendChild(b); });
  const list=S.tips.filter(t=>(S.cat==='All'||t.cat===S.cat)&&(!q||norm(t.text+' '+t.cat).includes(q)));
  $('tipCount').textContent=list.length+' / '+S.tips.length;
  list.forEach(t=>{ const li=document.createElement('li'); const c=document.createElement('span'); c.className='c'; c.textContent=t.cat; li.append(c,document.createTextNode(t.text)); ol.appendChild(li); });
  if(!list.length){ const li=document.createElement('li'); li.className='empty'; li.textContent='No tips match.'; ol.appendChild(li); }
}

/* ---- init ---- */
async function init(){
  try{ const c = await http('config/sources.json','json'); if(c.sources&&c.sources.length) S.sources=c.sources; }catch(e){}
  try{ S.tips = await http('database/offline-tips.json','json'); }catch(e){ S.tips=[]; }
  renderTips();
  S.cache = (await DB.get('cache')) || {}; S.seen = new Set((await DB.get('seen'))||[]);
  const a=document.createElement('audio'); a.id='alarm'; a.src='assets/alarm.mp3'; a.preload='auto'; document.body.appendChild(a);
  rebuild(false); loadCheckins();
  $('refreshBtn').onclick=()=>poll(true);
  $('armBtn').onclick=async()=>{ S.armed=true; $('armBtn').textContent='\u2705 Alerts Armed'; if(window.Notification&&Notification.permission==='default'){ try{await Notification.requestPermission();}catch(e){} } if(navigator.vibrate) navigator.vibrate(100); const x=$('alarm'); x.muted=true; x.play().then(()=>{x.pause();x.muted=false;x.currentTime=0;}).catch(()=>{x.muted=false;}); };
  $('sirenBtn').onclick=()=> S.sirenOn ? stopSiren() : startSiren();
  $('checkinBtn').onclick=checkin;
  $('sevFilter').onchange=renderFeed; $('tipSearch').oninput=renderTips;
  window.addEventListener('online',()=>{refreshConn();poll();}); window.addEventListener('offline',refreshConn);
  refreshConn(); poll();
  setInterval(()=>{ S.countdown=Math.max(0,S.countdown-1); $('meta').textContent='Next poll in '+S.countdown+'s'; if(S.countdown<=0&&!S.polling) poll(); },1000);
  if('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js').catch(()=>{});
}
init();
})();
