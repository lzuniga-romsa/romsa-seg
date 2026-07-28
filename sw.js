// ROMSA Service Worker v1
const CACHE = 'romsa-v1';
const ASSETS = [
  '/',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'
];

// Instalar — cachear assets clave
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => {
      return cache.addAll(ASSETS).catch(() => {});
    })
  );
  self.skipWaiting();
});

// Activar — limpiar caches viejos
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — network first, cache fallback
self.addEventListener('fetch', e => {
  // Solo cachear GET
  if(e.request.method !== 'GET') return;
  // No interceptar Firebase/Firestore (necesitan red)
  const url = e.request.url;
  if(url.includes('firestore.googleapis.com') ||
     url.includes('firebase') ||
     url.includes('googleapis.com/identitytoolkit')) return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Guardar copia en cache
        if(res.ok){
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(e.request).then(cached => {
          if(cached) return cached;
          // Sin red y sin caché para esta petición: regresar una Response
          // real en vez de undefined (evita "Failed to convert value to 'Response'")
          return new Response(
            'Sin conexión y sin copia guardada para este recurso.',
            {status: 503, statusText: 'Service Unavailable', headers: {'Content-Type': 'text/plain; charset=utf-8'}}
          );
        })
      )
  );
});
