const CACHE = "paiduyna-full-2026-07-31-v44-hobby-cron-fix";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg",
  "./brand-logo-v4.svg",
  "./strava-logo.png",
  "./data/status.json",
  "./data/parking.json",
  "./data/network.json"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if(event.request.method !== "GET") return;
  const url = new URL(event.request.url);

  if(url.origin === self.location.origin && url.pathname.includes("/admin/")) {
    event.respondWith(fetch(event.request, {cache:"no-store"}));
    return;
  }

  // API ต้องอ่านข้อมูลสดและห้ามถูกเก็บใน App Shell โดยเฉพาะข้อมูลล่าสุดจาก Strava
  if(url.origin === self.location.origin && url.pathname.includes("/api/")) {
    event.respondWith(fetch(event.request, {cache:"no-store"}));
    return;
  }

  if(url.pathname.endsWith("/data/status.json") || url.pathname.endsWith("/data/parking.json") || url.pathname.endsWith("/data/network.json")) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request, {ignoreSearch:true}))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request, {ignoreSearch:true}).then(cached => {
      if(cached) return cached;
      return fetch(event.request).then(response => {
        if(url.origin === self.location.origin) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, copy));
        }
        return response;
      });
    })
  );
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(clients.matchAll({type:"window", includeUncontrolled:true}).then(list => {
    if(list.length) return list[0].focus();
    return clients.openWindow("./");
  }));
});

// รับ Push จาก Server (ระบบแจ้งเตือนขบวนล่วงหน้าที่ทำงานได้แม้ปิดแอป)
self.addEventListener("push", event => {
  let data = {};
  try{ data = event.data ? event.data.json() : {}; }catch(e){ data = {}; }
  const title = data.title || "รถไฟใกล้ออกแล้ว";
  const options = {
    body: data.body || "",
    icon: "icon.svg",
    badge: "icon.svg",
    tag: data.tag || "train-push",
    renotify: true
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
