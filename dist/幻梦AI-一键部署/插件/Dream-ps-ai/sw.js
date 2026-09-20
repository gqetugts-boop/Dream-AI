const CACHE_NAME = 'huanmeng-ai-h5-3.1.1';
const CORE_ASSETS = [
  './', './index.html', './manifest.webmanifest',
  './src/theme.js', './src/app/index.js', './src/sw-register.js',
  './src/features/color-match/color-match.service.js',
  './src/features/glow/glow-engine.js',
  './src/features/space-fx/space-fx-engine.js',
  './src/features/gallery/gallery-store.js',
  './src/features/reference-ui/tile-hemisynth.prompts.js',
  './src/styles/reference-tile-camera.css',
  './src/styles/reference-tile-scope.css',
  './src/styles/reference-tile-adapter.css',
  './icons/pwa-192.png', './icons/pwa-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).then(response => {
    const copy = response.clone();
    caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request).then(hit => hit || caches.match('./index.html'))));
});
