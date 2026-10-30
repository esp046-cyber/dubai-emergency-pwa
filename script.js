'use strict';
/* Sentinel Alert Dubai - Resilient Vanilla ES6, Zero Build */

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

const FALLBACK_TIPS = [
  {cat:'Industrial Hazard',text:'Stay indoors and seal windows, air conditioning inlets, and door gaps with damp cloths in the event of industrial chemical plumes near Jebel Ali.'},
  {cat:'Explosion Cover',text:'Drop to the floor immediately away from glass facades. Cover your head and neck beneath heavy furniture.'},
  {cat:'Evacuation',text:'Discovery Gardens: Never use building elevators during an active alarm. Use internal fire staircases only.'},
  {cat:'Rations',text:'Keep at least 3 days of potable water (4L per person per day) and non-perishable canned food at home.'},
  {cat:'Medical',text:'Keep your Emirates ID and essential prescription medications in an accessible grab-and-go waterproof pouch.'}
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

const strip = h => {
  try {
    return (new DOMParser().parseFromString(String(h||''),'text/html').body.textContent||'').trim();
  } catch(e){
    return String(h||'').replace(/<[^>]*>?/gm, '');
  }
};

if (typeof module !== 'undefined') {
  module.exports = {classify, computeStatus, parseDate, KEYWORDS, GEO, CRIT};
}

if (typeof document !== 'undefined') (function(){
  const $ = id => document.getElementById(id);
  const S = {
    cache: {},
    seen: new Set(),
    items: [],
    armed: false,
    siren: null,
    sirenOn: false,
    countdown: POLL_MS / 1000,
    polling: false,
    sources: DEFAULT_SOURCES,
    tips: [],
    cat: 'All'
  };

  /* ---- IndexedDB / LocalStorage Storage ---- */
  const DB = {
    open(){
      return new Promise((res, rej) => {
        try {
          const r = indexedDB.open('sentinel', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('kv');
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        } catch(e) { rej(e); }
      });
    },
    async get(k){
      try {
        const db = await this.open();
        return await new Promise((res, rej) => {
          const q = db.transaction('kv').objectStore('kv').get(k);
          q.onsuccess = () => res(q.result);
          q.onerror = () => rej(q.error);
        });
      } catch(e){
        try { return JSON.parse(localStorage.getItem('s_' + k)); } catch(_) { return null; }
      }
    },
    async set(k, v){
      try {
        const db = await this.open();
        await new Promise((res, rej) => {
          const t = db.transaction('kv', 'readwrite');
          t.objectStore('kv').put(v, k);
          t.oncomplete = res;
          t.onerror = () => rej(t.error);
        });
      } catch(e){
        try { localStorage.setItem('s_' + k, JSON.stringify(v)); } catch(_) {}
      }
    }
  };

  /* ---- Network Request Handlers ---- */
  async function http(url, kind){
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 10000);
    try {
      const r = await fetch(url, { signal: c.signal, cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return kind === 'json' ? await r.json() : await r.text();
    } finally {
      clearTimeout(t);
    }
  }

  async function fetchRSS(url){
    try {
      const j = await http('https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(url), 'json');
      if (j && j.status === 'ok' && Array.isArray(j.items)) {
        return j.items.map(i => ({
          title: strip(i.title),
          summary: strip(i.description || i.content),
          link: i.link,
          ts: parseDate(i.pubDate)
        }));
      }
    } catch(e){}

    const x = await http('https://api.allorigins.win/raw?url=' + encodeURIComponent(url), 'text');
    const d = new DOMParser().parseFromString(x, 'text/xml');
    const g = (n, t) => { const e = n.getElementsByTagName(t)[0]; return e ? e.textContent : ''; };
    const out = [...d.getElementsByTagName('item')].map(n => ({
      title: strip(g(n, 'title')),
      summary: strip(g(n, 'description')),
      link: g(n, 'link'),
      ts: parseDate(g(n, 'pubDate'))
    }));
    if (!out.length) throw new Error('Empty feed');
    return out;
  }

  async function fetchUSGS(url){
    const j = await http(url, 'json');
    return (j.features || []).filter(f => /emirates|uae|oman|iran|persian|gulf|qatar|saudi/i.test(f.properties?.place || '')).map(f => {
      const p = f.properties || {};
      const big = p.mag >= 4.5;
      return {
        title: 'M' + p.mag + ' earthquake: ' + p.place,
        summary: 'USGS seismic event in or near the Gulf region',
        link: p.url,
        ts: p.time,
        forceKeep: true,
        forceSev: big ? 'elevated' : 'info'
      };
    });
  }

  async function fetchSource(s){
    return s.type === 'usgs' ? fetchUSGS(s.url) : fetchRSS(s.url);
  }

  /* ---- Connection UI ---- */
  function setConn(state, text){
    const conn = $('conn');
    const connText = $('connText');
    if (conn) conn.className = 'conn ' + state;
    if (connText) connText.textContent = text;
  }

  function refreshConn(){
    if (!navigator.onLine) setConn('offline', 'Offline (cached)');
    else if (S.polling) setConn('polling', 'Polling');
    else setConn('online', 'Online');
  }

  /* ---- Polling & Data Cache ---- */
  async function poll(manual){
    if (S.polling) return;
    S.polling = true;
    refreshConn();

    const results = await Promise.allSettled(S.sources.map(fetchSource));
    let ok = 0;
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        ok++;
        S.cache[S.sources[i].id] = { t: Date.now(), items: r.value };
      }
    });

    S.polling = false;
    const feedMeta = $('feedMeta');
    if (ok) {
      await DB.set('cache', S.cache);
      setConn('online', 'Online');
      if (feedMeta) feedMeta.textContent = 'Updated ' + new Date().toLocaleTimeString() + ' (' + ok + '/' + S.sources.length + ' sources)';
    } else {
      setConn('offline', 'Offline (cached)');
      if (feedMeta) feedMeta.textContent = 'Network unavailable. Showing last cached data.';
    }

    rebuild(true);
    S.countdown = POLL_MS / 1000;
  }

  function rebuild(notify){
    const seen = new Set();
    const all = [];

    Object.values(S.cache).forEach(c => {
      if (!c || !Array.isArray(c.items)) return;
      c.items.forEach(raw => {
        const it = classify(raw);
        if (!it.match) return;
        const k = norm(it.title).slice(0, 80);
        if (seen.has(k)) return;
        seen.add(k);
        it.id = k;
        all.push(it);
      });
    });

    const rank = { critical: 0, elevated: 1, info: 2 };
    all.sort((a, b) => rank[a.sev] - rank[b.sev] || (b.ts || 0) - (a.ts || 0));
    S.items = all.slice(0, 60);

    const fresh = S.items.filter(i => i.sev === 'critical' && !S.seen.has(i.id));
    fresh.forEach(i => S.seen.add(i.id));
    DB.set('seen', [...S.seen]);

    renderBanner();
    renderFeed();

    if (notify && fresh.length) alertUser(fresh[0]);
  }

  /* ---- Rendering ---- */
  function renderBanner(){
    const b = $('banner');
    if (!b) return;
    const st = computeStatus(S.items);
    const map = {
      normal: ['NORMAL', 'No high-severity local alerts detected in the last 24h.'],
      heightened: ['HEIGHTENED VIGILANCE', 'Elevated reports found. Stay alert and review safety tips.'],
      critical: ['CRITICAL / IMMEDIATE ACTION', 'High-severity local report detected. Follow official instructions now. Call 999 / 997 / 998 if in danger.']
    };
    b.className = 'banner ' + st;
    const bTitle = $('bTitle');
    const bSub = $('bSub');
    if (bTitle) bTitle.textContent = map[st][0];
    if (bSub) bSub.textContent = map[st][1];
    document.title = (st === 'critical' ? '\u26A0 ' : '') + 'Sentinel Alert Dubai';
  }

  function renderFeed(){
    const ul = $('feed');
    if (!ul) return;
    const sevFilter = $('sevFilter');
    const f = sevFilter ? sevFilter.value : 'all';
    ul.textContent = '';

    const list = S.items.filter(i => f === 'all' || (f === 'critical' && i.sev === 'critical') || (f === 'elevated' && i.sev !== 'info'));

    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No matching alerts detected right now.';
      ul.appendChild(li);
      return;
    }

    list.forEach(i => {
      const li = document.createElement('li');
      li.className = i.sev;

      const tag = document.createElement('span');
      tag.className = 'tag ' + i.sev;
      tag.textContent = i.sev.toUpperCase();

      const a = document.createElement('a');
      a.textContent = i.title;
      if (/^https?:/.test(i.link || '')) {
        a.href = i.link;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }

      const m = document.createElement('div');
      m.className = 'm';
      m.textContent = ago(i.ts) + (i.kw.length ? ' \u00B7 ' + i.kw.join(', ') : '');

      li.append(tag, a, m);
      ul.appendChild(li);
    });
  }

  /* ---- Audio / Siren Fallback ---- */
  let ac = null, osc = null, lfo = null;
  function startSiren(){
    stopSiren();
    S.sirenOn = true;
    const btn = $('sirenBtn');
    const state = $('sirenState');
    if (btn) btn.classList.add('on');
    if (state) state.textContent = 'Tap to stop';

    const a = $('alarm');
    if (a) {
      a.loop = true;
      a.play().catch(() => webSiren());
    } else {
      webSiren();
    }
  }

  function webSiren(){
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      if (ac.state === 'suspended') ac.resume();
      osc = ac.createOscillator();
      lfo = ac.createOscillator();
      const g = ac.createGain();

      osc.type = 'sawtooth';
      osc.frequency.value = 900;
      lfo.frequency.value = 0.7;
      g.gain.value = 300;

      lfo.connect(g);
      g.connect(osc.frequency);
      osc.connect(ac.destination);

      osc.start();
      lfo.start();
    } catch(e){}
  }

  function stopSiren(){
    S.sirenOn = false;
    const btn = $('sirenBtn');
    const state = $('sirenState');
    if (btn) btn.classList.remove('on');
    if (state) state.textContent = 'Tap to sound';

    const a = $('alarm');
    if (a) { a.pause(); a.currentTime = 0; }
    try {
      if (osc) { osc.stop(); osc.disconnect(); }
      if (lfo) { lfo.stop(); lfo.disconnect(); }
    } catch(e){}
    osc = null; lfo = null;
  }

  function alertUser(item){
    if (navigator.vibrate) try { navigator.vibrate([500, 200, 500, 200, 800]); } catch(e){}
    if (S.armed) {
      startSiren();
      setTimeout(() => { if (S.sirenOn) stopSiren(); }, 15000);
    }
    if (window.Notification && Notification.permission === 'granted') {
      try { new Notification('CRITICAL: Sentinel Dubai', { body: item.title, icon: 'icon-192.png', tag: 'sentinel' }); } catch(e){}
    }
  }

  /* ---- Check-in Logic ---- */
  async function loadCheckins(){
    const list = (await DB.get('checkins')) || [];
    const ul = $('checkinLog');
    if (ul) {
      ul.textContent = '';
      list.slice(0, 5).forEach(c => {
        const li = document.createElement('li');
        li.textContent = new Date(c).toLocaleString();
        ul.appendChild(li);
      });
    }
    const last = $('checkinLast');
    if (last) {
      last.textContent = list.length ? 'Last check-in: ' + new Date(list[0]).toLocaleString() : 'No check-in recorded.';
    }
    const sms = $('smsLink');
    if (sms) {
      sms.href = 'sms:?&body=' + encodeURIComponent('I am safe. Discovery Gardens / Jebel Ali, Dubai. Check-in: ' + (list[0] ? new Date(list[0]).toLocaleString() : new Date().toLocaleString()));
    }
  }

  async function checkin(){
    const list = (await DB.get('checkins')) || [];
    list.unshift(Date.now());
    await DB.set('checkins', list.slice(0, 50));
    const card = $('checkinCard');
    if (card) card.hidden = false;
    loadCheckins();
  }

  /* ---- Tips Display ---- */
  function renderTips(){
    const search = $('tipSearch');
    const q = norm(search ? search.value : '');
    const ol = $('tips');
    if (!ol) return;
    ol.textContent = '';

    const tips = (S.tips && S.tips.length) ? S.tips : FALLBACK_TIPS;
    const cats = ['All'].concat([...new Set(tips.map(t => t.cat))]);

    const chips = $('chips');
    if (chips) {
      chips.textContent = '';
      cats.forEach(c => {
        const b = document.createElement('button');
        b.className = 'chip' + (c === S.cat ? ' on' : '');
        b.textContent = c;
        b.onclick = () => { S.cat = c; renderTips(); };
        chips.appendChild(b);
      });
    }

    const list = tips.filter(t => (S.cat === 'All' || t.cat === S.cat) && (!q || norm(t.text + ' ' + t.cat).includes(q)));
    const count = $('tipCount');
    if (count) count.textContent = list.length + ' / ' + tips.length;

    list.forEach(t => {
      const li = document.createElement('li');
      const c = document.createElement('span');
      c.className = 'c';
      c.textContent = t.cat;
      li.append(c, document.createTextNode(t.text));
      ol.appendChild(li);
    });

    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No matching tips found.';
      ol.appendChild(li);
    }
  }

  /* ---- App Initialization ---- */
  async function init(){
    try {
      const c = await http('config/sources.json', 'json');
      if (c && Array.isArray(c.sources) && c.sources.length) S.sources = c.sources;
    } catch(e){}

    try {
      const loadedTips = await http('database/offline-tips.json', 'json');
      if (Array.isArray(loadedTips) && loadedTips.length) S.tips = loadedTips;
      else S.tips = FALLBACK_TIPS;
    } catch(e){
      S.tips = FALLBACK_TIPS;
    }

    renderTips();

    S.cache = (await DB.get('cache')) || {};
    S.seen = new Set((await DB.get('seen')) || []);

    const a = document.createElement('audio');
    a.id = 'alarm';
    a.src = 'assets/alarm.mp3';
    a.preload = 'auto';
    document.body.appendChild(a);

    rebuild(false);
    loadCheckins();

    const refreshBtn = $('refreshBtn');
    if (refreshBtn) refreshBtn.onclick = () => poll(true);

    const armBtn = $('armBtn');
    if (armBtn) {
      armBtn.onclick = async () => {
        S.armed = true;
        armBtn.textContent = '\u2705 Alerts Armed';
        if (window.Notification && Notification.permission === 'default') {
          try { await Notification.requestPermission(); } catch(e){}
        }
        if (navigator.vibrate) try { navigator.vibrate(100); } catch(e){}
        const x = $('alarm');
        if (x) {
          x.muted = true;
          x.play().then(() => { x.pause(); x.muted = false; x.currentTime = 0; }).catch(() => { x.muted = false; });
        }
      };
    }

    const sirenBtn = $('sirenBtn');
    if (sirenBtn) sirenBtn.onclick = () => S.sirenOn ? stopSiren() : startSiren();

    const checkinBtn = $('checkinBtn');
    if (checkinBtn) checkinBtn.onclick = checkin;

    const sevFilter = $('sevFilter');
    if (sevFilter) sevFilter.onchange = renderFeed;

    const tipSearch = $('tipSearch');
    if (tipSearch) tipSearch.oninput = renderTips;

    window.addEventListener('online', () => { refreshConn(); poll(); });
    window.addEventListener('offline', refreshConn);

    refreshConn();
    poll();

    setInterval(() => {
      S.countdown = Math.max(0, S.countdown - 1);
      const meta = $('meta');
      if (meta) meta.textContent = 'Next poll in ' + S.countdown + 's';
      if (S.countdown <= 0 && !S.polling) poll();
    }, 1000);

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('service-worker.js').catch(() => {});
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();