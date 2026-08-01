/* Service Worker ของ PAI.DUY.NA
   หลักการแคช แยกตามชนิดคำขอ เพื่อให้ได้ทั้งความสด ความเร็ว และใช้งานออฟไลน์ได้
   - หน้าเว็บ (navigate)        : Network first แล้ว fallback แคช  ผู้ใช้ได้เวอร์ชันใหม่ทันทีที่ Deploy
   - ไฟล์ข้อมูล data/*.json     : Network first แล้ว fallback แคช  ข้อมูลสถานะต้องสดที่สุด
   - ไฟล์แอปอื่นในโดเมนเดียวกัน : Stale while revalidate            เปิดไว และไม่ค้างของเก่าถาวร
   - ฟอนต์ Google              : Cache first แล้วอัปเดตเบื้องหลัง   ออฟไลน์ยังได้ฟอนต์เดิม
   - /api/ และ /admin/         : Network only                      ห้ามแคชข้อมูลสดและหน้าผู้ดูแล
*/
const VERSION = "2026-08-02-v52";
const SHELL_CACHE = "paiduyna-shell-" + VERSION;
const RUNTIME_CACHE = "paiduyna-runtime-" + VERSION;
const FONT_CACHE = "paiduyna-fonts-" + VERSION;
const KEEP = [SHELL_CACHE, RUNTIME_CACHE, FONT_CACHE];

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
  "./brand-logo-v4.svg",
  "./strava-logo.png",
  "./data/status.json",
  "./data/parking.json",
  "./data/network.json",
  "./data/stations-geo.json"
];

const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // ใส่ทีละไฟล์ เพราะ addAll จะล้มทั้งชุดหากมีไฟล์ใดหายไป ทำให้ติดตั้ง SW ไม่สำเร็จเลย
    await Promise.all(APP_SHELL.map(url =>
      cache.add(new Request(url, {cache: "reload"})).catch(() => {})
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => !KEEP.includes(key)).map(key => caches.delete(key)));
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.enable().catch(() => {});
    }
    await self.clients.claim();
  })());
});

const isCacheable = response =>
  response && response.status === 200 && response.type !== "opaqueredirect";

async function networkFirst(request, cacheName, preloadPromise) {
  const cache = await caches.open(cacheName);
  try {
    const preloaded = preloadPromise ? await preloadPromise : null;
    const response = preloaded || await fetch(request);
    if (isCacheable(response)) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request, {ignoreSearch: true});
    if (cached) return cached;
    throw error;
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, {ignoreSearch: true});
  const network = fetch(request)
    .then(response => {
      if (isCacheable(response)) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  return cached || (await network) || Response.error();
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const acceptable = response => response && (response.status === 200 || response.type === "opaque");
  if (cached) {
    // อัปเดตเบื้องหลัง ไม่หน่วงการแสดงผล
    fetch(request).then(response => {
      if (acceptable(response)) cache.put(request, response.clone());
    }).catch(() => {});
    return cached;
  }
  const response = await fetch(request);
  if (acceptable(response)) cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try { url = new URL(request.url); } catch (e) { return; }

  const sameOrigin = url.origin === self.location.origin;

  // หน้าผู้ดูแลและ API ต้องอ่านสดเสมอ ห้ามค้างในแคช
  if (sameOrigin && (url.pathname.includes("/admin/") || url.pathname.includes("/api/"))) {
    event.respondWith(fetch(request, {cache: "no-store"}));
    return;
  }

  // การเปิดหน้าเว็บ ใช้ของใหม่ก่อนเสมอ ถ้าออฟไลน์จึงย้อนไปใช้แคช
  if (request.mode === "navigate") {
    event.respondWith(
      networkFirst(request, SHELL_CACHE, event.preloadResponse)
        .catch(async () => (await caches.match("./index.html", {ignoreSearch: true}))
          || new Response("ออฟไลน์อยู่ และยังไม่มีสำเนาหน้าเว็บในเครื่อง", {
            status: 503,
            headers: {"Content-Type": "text/plain; charset=utf-8"}
          }))
    );
    return;
  }

  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(request, FONT_CACHE).catch(() => Response.error()));
    return;
  }

  if (sameOrigin && url.pathname.includes("/data/") && url.pathname.endsWith(".json")) {
    event.respondWith(networkFirst(request, RUNTIME_CACHE).catch(() => Response.error()));
    return;
  }

  if (sameOrigin) {
    event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE));
  }
});

// ให้หน้าเว็บสั่งข้ามคิวรออัปเดตได้ เผื่อเพิ่มปุ่มโหลดเวอร์ชันใหม่ในอนาคต
self.addEventListener("message", event => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "./";
  event.waitUntil((async () => {
    const list = await clients.matchAll({type: "window", includeUncontrolled: true});
    for (const client of list) {
      if ("focus" in client) {
        if ("navigate" in client && target !== "./") {
          try { await client.navigate(target); } catch (e) {}
        }
        return client.focus();
      }
    }
    return clients.openWindow(target);
  })());
});

// รับ Push จาก Server (ระบบแจ้งเตือนขบวนล่วงหน้าที่ทำงานได้แม้ปิดแอป)
self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  const title = data.title || "รถไฟใกล้ออกแล้ว";
  const options = {
    body: data.body || "",
    icon: "icon-192.png",
    badge: "icon-192.png",
    tag: data.tag || "train-push",
    renotify: true,
    data: {url: data.url || "./"}
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
