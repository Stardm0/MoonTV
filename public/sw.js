if (!self.define) {
  let e,
    s = {};
  const n = (n, a) => (
    (n = new URL(n + '.js', a).href),
    s[n] ||
      new Promise((s) => {
        if ('document' in self) {
          const e = document.createElement('script');
          (e.src = n), (e.onload = s), document.head.appendChild(e);
        } else (e = n), importScripts(n), s();
      }).then(() => {
        let e = s[n];
        if (!e) throw new Error(`Module ${n} didn’t register its module`);
        return e;
      })
  );
  self.define = (a, c) => {
    const i =
      e ||
      ('document' in self ? document.currentScript.src : '') ||
      location.href;
    if (s[i]) return;
    let t = {};
    const r = (e) => n(e, i),
      o = { module: { uri: i }, exports: t, require: r };
    s[i] = Promise.all(a.map((e) => o[e] || r(e))).then((e) => (c(...e), t));
  };
}
define(['./workbox-e9849328'], function (e) {
  'use strict';
  importScripts(),
    self.skipWaiting(),
    e.clientsClaim(),
    e.precacheAndRoute(
      [
        {
          url: '/_next/app-build-manifest.json',
          revision: '26f69dea9f192b7cbe6023f5c91e287b',
        },
        {
          url: '/_next/static/aHFAeBUsJCLjuzxC8nc35/_buildManifest.js',
          revision: '9f48adae326082aba11300d1880837af',
        },
        {
          url: '/_next/static/aHFAeBUsJCLjuzxC8nc35/_ssgManifest.js',
          revision: 'b6652df95db52feb4daf4eca35380933',
        },
        {
          url: '/_next/static/chunks/145-f2ebf4bde633ee64.js',
          revision: 'aHFAeBUsJCLjuzxC8nc35',
        },
        {
          url: '/_next/static/chunks/300-f1456f7894c849c7.js',
          revision: 'aHFAeBUsJCLjuzxC8nc35',
        },
        {
          url: '/_next/static/chunks/346-f4b95ee29833280a.js',
          revision: 'aHFAeBUsJCLjuzxC8nc35',
        },
        {
          url: '/_next/static/chunks/381-04184e70f9480819.js',
          revision: 'aHFAeBUsJCLjuzxC8nc35',
        },
        {
          url: '/_next/static/chunks/443.976d141cb8252b14.js',
          revision: '976d141cb8252b14',
        },
        {
          url: '/_next/static/chunks/527-65bce8d60b6d9b55.js',
          revision: 'aHFAeBUsJCLjuzxC8nc35',
        },
        {
          url: '/_next/static/chunks/764-360503bcdce26f75.js',
          revision: 'aHFAeBUsJCLjuzxC8nc35',
        },
        {
          url: '/_next/static/chunks/7b40a773-f953dbd1e71a62b2.js',
          revision: 'aHFAeBUsJCLjuzxC8nc35',
        },
        {
          url: '/_next/static/chunks/861b9fbb-5d31b04561895b33.js',
          revision: 'aHFAeBUsJCLjuzxC8nc35',
        },
        {
          url: '/_next/static/chunks/887-9fc357eacc3a7474.js',
          revision: 'aHFAeBUsJCLjuzxC8nc35',
        },
        {
          url: '/_next/static/chunks/app/_not-found/page-81d025ddfaaa0156.js',
          revision: 'aHFAeBUsJCLjuzxC8nc35',
        },
        {
          url: '/_next/static/chunks/app/admin/page-a652392a4967ed63.js',
          revision: 'aHFAeBUsJCLjuzxC8nc35',
        },
        {
          url: '/_next/static/chunks/app/douban/page-51fec903aa4b494e.js',
          revision: 'aHFAeBUsJCLjuzxC8nc35',
        },
        {
          url: '/_next/static/chunks/app/layout-001d50ab9e0c06e6.js',
          revision: 'aHFAeBUsJCLjuzxC8nc35',
        },
        {
          url: '/_next/static/chunks/app/login/page-0504795d48e68605.js',
          revision: 'aHFAeBUsJCLjuzxC8nc35',
        },
        {
          url: '/_next/static/chunks/app/not-found-97008220a27453c4.js',
          revision: 'aHFAeBUsJCLjuzxC8nc35',
        },
        {
          url: '/_next/static/chunks/app/page-a8ba292f1d0095af.js',
          revision: 'aHFAeBUsJCLjuzxC8nc35',
        },
        {
          url: '/_next/static/chunks/app/play/page-1ac4a276ce332c48.js',
          revision: 'aHFAeBUsJCLjuzxC8nc35',
        },
        {
          url: '/_next/static/chunks/app/search/page-ac0631b7750a50bd.js',
          revision: 'aHFAeBUsJCLjuzxC8nc35',
        },
        {
          url: '/_next/static/chunks/app/warning/page-5315f49addf33932.js',
          revision: 'aHFAeBUsJCLjuzxC8nc35',
        },
        {
          url: '/_next/static/chunks/c5525c1e-774f4ca1650e1b6f.js',
          revision: 'aHFAeBUsJCLjuzxC8nc35',
        },
        {
          url: '/_next/static/chunks/framework-6e06c675866dc992.js',
          revision: 'aHFAeBUsJCLjuzxC8nc35',
        },
        {
          url: '/_next/static/chunks/main-832003337714062b.js',
          revision: 'aHFAeBUsJCLjuzxC8nc35',
        },
        {
          url: '/_next/static/chunks/main-app-e8c77f2f925e8c55.js',
          revision: 'aHFAeBUsJCLjuzxC8nc35',
        },
        {
          url: '/_next/static/chunks/pages/_app-eefee121b3a45bb4.js',
          revision: 'aHFAeBUsJCLjuzxC8nc35',
        },
        {
          url: '/_next/static/chunks/pages/_error-f479c2a1061f2c96.js',
          revision: 'aHFAeBUsJCLjuzxC8nc35',
        },
        {
          url: '/_next/static/chunks/polyfills-42372ed130431b0a.js',
          revision: '846118c33b2c0e922d7b3a7676f81f6f',
        },
        {
          url: '/_next/static/chunks/webpack-7f9d8ef6fe170b25.js',
          revision: 'aHFAeBUsJCLjuzxC8nc35',
        },
        {
          url: '/_next/static/css/7cca8e2c5137bd71.css',
          revision: '7cca8e2c5137bd71',
        },
        {
          url: '/_next/static/css/85eefe843af5ed6b.css',
          revision: '85eefe843af5ed6b',
        },
        {
          url: '/_next/static/css/bf805ca69a59069e.css',
          revision: 'bf805ca69a59069e',
        },
        {
          url: '/_next/static/media/19cfc7226ec3afaa-s.woff2',
          revision: '9dda5cfc9a46f256d0e131bb535e46f8',
        },
        {
          url: '/_next/static/media/21350d82a1f187e9-s.woff2',
          revision: '4e2553027f1d60eff32898367dd4d541',
        },
        {
          url: '/_next/static/media/8e9860b6e62d6359-s.woff2',
          revision: '01ba6c2a184b8cba08b0d57167664d75',
        },
        {
          url: '/_next/static/media/ba9851c3c22cd980-s.woff2',
          revision: '9e494903d6b0ffec1a1e14d34427d44d',
        },
        {
          url: '/_next/static/media/c5fe6dc8356a8c31-s.woff2',
          revision: '027a89e9ab733a145db70f09b8a18b42',
        },
        {
          url: '/_next/static/media/df0a9ae256c0569c-s.woff2',
          revision: 'd54db44de5ccb18886ece2fda72bdfe0',
        },
        {
          url: '/_next/static/media/e4af272ccee01ff0-s.p.woff2',
          revision: '65850a373e258f1c897a2b3d75eb74de',
        },
        { url: '/favicon.ico', revision: '2a440afb7f13a0c990049fc7c383bdd4' },
        {
          url: '/icons/icon-192x192.png',
          revision: 'e214d3db80d2eb6ef7a911b3f9433b81',
        },
        {
          url: '/icons/icon-256x256.png',
          revision: 'a5cd7490191373b684033f1b33c9d9da',
        },
        {
          url: '/icons/icon-384x384.png',
          revision: '8540e29a41812989d2d5bf8f61e1e755',
        },
        {
          url: '/icons/icon-512x512.png',
          revision: '3e5597604f2c5d99d7ab62b02f6863d3',
        },
        { url: '/logo.png', revision: '5c1047adbe59b9a91cc7f8d3d2f95ef4' },
        { url: '/manifest.json', revision: 'f8a4f2b082d6396d3b1a84ce0e267dfe' },
        { url: '/robots.txt', revision: 'e2b2cd8514443456bc6fb9d77b3b1f3e' },
        {
          url: '/screenshot1.png',
          revision: '605c1f6cb3344919735c48fd4c105407',
        },
      ],
      { ignoreURLParametersMatching: [] }
    ),
    e.cleanupOutdatedCaches(),
    e.registerRoute(
      '/',
      new e.NetworkFirst({
        cacheName: 'start-url',
        plugins: [
          {
            cacheWillUpdate: async ({
              request: e,
              response: s,
              event: n,
              state: a,
            }) =>
              s && 'opaqueredirect' === s.type
                ? new Response(s.body, {
                    status: 200,
                    statusText: 'OK',
                    headers: s.headers,
                  })
                : s,
          },
        ],
      }),
      'GET'
    ),
    e.registerRoute(
      /^https:\/\/fonts\.(?:gstatic)\.com\/.*/i,
      new e.CacheFirst({
        cacheName: 'google-fonts-webfonts',
        plugins: [
          new e.ExpirationPlugin({ maxEntries: 4, maxAgeSeconds: 31536e3 }),
        ],
      }),
      'GET'
    ),
    e.registerRoute(
      /^https:\/\/fonts\.(?:googleapis)\.com\/.*/i,
      new e.StaleWhileRevalidate({
        cacheName: 'google-fonts-stylesheets',
        plugins: [
          new e.ExpirationPlugin({ maxEntries: 4, maxAgeSeconds: 604800 }),
        ],
      }),
      'GET'
    ),
    e.registerRoute(
      /\.(?:eot|otf|ttc|ttf|woff|woff2|font.css)$/i,
      new e.StaleWhileRevalidate({
        cacheName: 'static-font-assets',
        plugins: [
          new e.ExpirationPlugin({ maxEntries: 4, maxAgeSeconds: 604800 }),
        ],
      }),
      'GET'
    ),
    e.registerRoute(
      /\.(?:jpg|jpeg|gif|png|svg|ico|webp)$/i,
      new e.StaleWhileRevalidate({
        cacheName: 'static-image-assets',
        plugins: [
          new e.ExpirationPlugin({ maxEntries: 64, maxAgeSeconds: 86400 }),
        ],
      }),
      'GET'
    ),
    e.registerRoute(
      /\/_next\/image\?url=.+$/i,
      new e.StaleWhileRevalidate({
        cacheName: 'next-image',
        plugins: [
          new e.ExpirationPlugin({ maxEntries: 64, maxAgeSeconds: 86400 }),
        ],
      }),
      'GET'
    ),
    e.registerRoute(
      /\.(?:mp3|wav|ogg)$/i,
      new e.CacheFirst({
        cacheName: 'static-audio-assets',
        plugins: [
          new e.RangeRequestsPlugin(),
          new e.ExpirationPlugin({ maxEntries: 32, maxAgeSeconds: 86400 }),
        ],
      }),
      'GET'
    ),
    e.registerRoute(
      /\.(?:mp4)$/i,
      new e.CacheFirst({
        cacheName: 'static-video-assets',
        plugins: [
          new e.RangeRequestsPlugin(),
          new e.ExpirationPlugin({ maxEntries: 32, maxAgeSeconds: 86400 }),
        ],
      }),
      'GET'
    ),
    e.registerRoute(
      /\.(?:js)$/i,
      new e.StaleWhileRevalidate({
        cacheName: 'static-js-assets',
        plugins: [
          new e.ExpirationPlugin({ maxEntries: 32, maxAgeSeconds: 86400 }),
        ],
      }),
      'GET'
    ),
    e.registerRoute(
      /\.(?:css|less)$/i,
      new e.StaleWhileRevalidate({
        cacheName: 'static-style-assets',
        plugins: [
          new e.ExpirationPlugin({ maxEntries: 32, maxAgeSeconds: 86400 }),
        ],
      }),
      'GET'
    ),
    e.registerRoute(
      /\/_next\/data\/.+\/.+\.json$/i,
      new e.StaleWhileRevalidate({
        cacheName: 'next-data',
        plugins: [
          new e.ExpirationPlugin({ maxEntries: 32, maxAgeSeconds: 86400 }),
        ],
      }),
      'GET'
    ),
    e.registerRoute(
      /\.(?:json|xml|csv)$/i,
      new e.NetworkFirst({
        cacheName: 'static-data-assets',
        plugins: [
          new e.ExpirationPlugin({ maxEntries: 32, maxAgeSeconds: 86400 }),
        ],
      }),
      'GET'
    ),
    e.registerRoute(
      ({ url: e }) => {
        if (!(self.origin === e.origin)) return !1;
        const s = e.pathname;
        return !s.startsWith('/api/auth/') && !!s.startsWith('/api/');
      },
      new e.NetworkFirst({
        cacheName: 'apis',
        networkTimeoutSeconds: 10,
        plugins: [
          new e.ExpirationPlugin({ maxEntries: 16, maxAgeSeconds: 86400 }),
        ],
      }),
      'GET'
    ),
    e.registerRoute(
      ({ url: e }) => {
        if (!(self.origin === e.origin)) return !1;
        return !e.pathname.startsWith('/api/');
      },
      new e.NetworkFirst({
        cacheName: 'others',
        networkTimeoutSeconds: 10,
        plugins: [
          new e.ExpirationPlugin({ maxEntries: 32, maxAgeSeconds: 86400 }),
        ],
      }),
      'GET'
    ),
    e.registerRoute(
      ({ url: e }) => !(self.origin === e.origin),
      new e.NetworkFirst({
        cacheName: 'cross-origin',
        networkTimeoutSeconds: 10,
        plugins: [
          new e.ExpirationPlugin({ maxEntries: 32, maxAgeSeconds: 3600 }),
        ],
      }),
      'GET'
    );
});
