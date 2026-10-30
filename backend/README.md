# Optional backend

The app is fully static and needs **no backend**. If the public proxies (rss2json / allorigins) are rate-limited, deploy a tiny Cloudflare Worker that fetches an RSS URL and returns it with `Access-Control-Allow-Origin: *`, then replace the proxy templates in `script.js` (`fetchRSS`) and `api/alerts-proxy.json`.
