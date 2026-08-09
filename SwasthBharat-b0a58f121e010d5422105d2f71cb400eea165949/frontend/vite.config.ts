import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const resolvePath = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

/**
 * Injects the Firebase config into `public/firebase-messaging-sw.js`.
 *
 * That file has to be served from the site root as a standalone classic script, so Firebase
 * can register it at its own scope. Being outside the module graph, it cannot use `import`
 * and cannot read `import.meta.env` — so the config is substituted here, at build time, in
 * place of the `__FIREBASE_CONFIG__` placeholder.
 *
 * The template lives in `src/sw/` rather than `public/` on purpose. Files in `public/` are
 * copied straight to the output and never pass through Rollup, so `generateBundle` cannot
 * see them — the first version of this plugin put the file there and shipped an
 * unsubstituted `__FIREBASE_CONFIG__` literal. Emitting it explicitly makes the
 * substitution the only way the file can reach the output.
 *
 * When the feature is not configured the placeholder becomes `null` and the worker's own
 * guard means it initialises nothing. It is emitted regardless: a few kilobytes, never
 * registered unless notifications are switched on, and it is excluded from the offline
 * precache (see `workbox.globIgnores`).
 */
function firebaseMessagingSwPlugin(env: Record<string, string>) {
  const templatePath = resolvePath('./src/sw/firebase-messaging-sw.js');
  const configured = Boolean(env.VITE_FIREBASE_PROJECT_ID && env.VITE_FIREBASE_API_KEY);
  const payload = configured
    ? JSON.stringify({
        apiKey: env.VITE_FIREBASE_API_KEY,
        authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
        projectId: env.VITE_FIREBASE_PROJECT_ID,
        appId: env.VITE_FIREBASE_APP_ID,
        messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
      })
    : 'null';

  /**
   * `replaceAll`, not `replace`.
   *
   * `String.replace` with a string pattern substitutes only the FIRST match, and the
   * template names `__FIREBASE_CONFIG__` in a comment above the assignment that uses it —
   * so the comment was rewritten and the actual code was left holding an undefined
   * identifier. The emitted worker threw on load, silently, because nothing registers it
   * unless notifications are switched on.
   */
  const render = () => readFileSync(templatePath, 'utf8').replaceAll('__FIREBASE_CONFIG__', payload);

  return {
    name: 'swasthbharat:firebase-messaging-sw',

    /**
     * `order: 'pre'` so the asset exists before vite-plugin-pwa builds its precache
     * manifest. It is globIgnored, but a plugin that races the manifest generator is a bug
     * waiting to be triggered by an unrelated config change.
     */
    generateBundle: {
      order: 'pre' as const,
      handler(this: { emitFile: (file: { type: 'asset'; fileName: string; source: string }) => void }) {
        this.emitFile({ type: 'asset', fileName: 'firebase-messaging-sw.js', source: render() });
      },
    },

    /** The dev server has no bundle, so serve the substituted file from memory. */
    configureServer(server: {
      middlewares: {
        use: (
          path: string,
          handler: (
            req: unknown,
            res: { setHeader: (k: string, v: string) => void; end: (body: string) => void },
            next: () => void,
          ) => void,
        ) => void;
      };
    }) {
      server.middlewares.use('/firebase-messaging-sw.js', (_req, res, next) => {
        try {
          res.setHeader('content-type', 'application/javascript');
          // No-store: a cached service worker pins the site to old behaviour.
          res.setHeader('cache-control', 'no-store');
          res.end(render());
        } catch {
          next();
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Only VITE_-prefixed vars, which is what the service worker needs.
  const env = loadEnv(mode, process.cwd(), 'VITE_');

  return {
  plugins: [
    react(),
    firebaseMessagingSwPlugin(env),

    VitePWA({
      registerType: 'autoUpdate',

      /**
       * Service worker in dev — but read this before relying on it.
       *
       * IMPORTANT LIMITATION: in dev the service worker registers but precaches NOTHING.
       * Vite serves unbundled ES modules transformed on demand, so there are no static
       * files for `globPatterns` below to match, and the injected manifest comes out empty.
       *
       * Therefore:
       *   - Offline *screening* works on the dev server: scoring, IndexedDB writes, the
       *     pending queue and auto-sync all run from code already in memory.
       *   - Offline *page reload* does NOT work on the dev server. There is no cached app
       *     shell to serve, so the browser shows its own "no internet" page.
       *
       * The offline reload — and therefore the demo's closing moment — only works against
       * the production build:  `npm run build && npm run preview`
       *
       * DEMO FROM `npm run preview`, NOT `npm run dev`.
       */
      devOptions: {
        enabled: true,
        type: 'module',
      },

      includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png'],

      manifest: {
        name: 'SwasthBharat — Health Risk Screening',
        short_name: 'SwasthBharat',
        description:
          'Offline-first diabetes risk screening for ASHA workers, with explainable results in Bengali, Hindi and English.',
        theme_color: '#0f766e',
        background_color: '#f8fafc',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        lang: 'bn',
        categories: ['health', 'medical', 'productivity'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },

      workbox: {
        // Precache the whole app shell, including the bundled risk model and the neural
        // second opinion, so a first-run device that goes offline can still screen a
        // patient and explain the result.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],

        /**
         * Everything EXCEPT the Firebase SDK.
         *
         * `globPatterns` above matches every emitted `.js`, lazy chunks included. When
         * phone sign-in is enabled that pulled the Firebase Auth SDK into the precache and
         * took it from 16 entries / 574 KiB to 19 / 818 KiB — a 43% increase in what a
         * field device must download before it can work offline, for a feature that
         * *cannot* work offline: sending an SMS code requires the network by definition.
         *
         * So the SDK is left to be fetched on demand, the first time someone actually taps
         * "send me a code". They are online at that moment, necessarily.
         *
         * This relies on the deterministic chunk name from `manualChunks` below; without
         * it the SDK emits as content-hashed `index.esm-*.js` files, which cannot be
         * matched reliably. The two settings are a pair.
         */
        globIgnores: [
          '**/firebase-sdk-*.js',
          /**
           * The FCM service worker must never be served from a cache.
           *
           * It is a `.js` in the output root, so `globPatterns` matched it and Workbox
           * started precaching it. A stale cached service worker is a well-known way to
           * pin a site to old behaviour, and this one is only ever needed when a push
           * arrives — which requires the network anyway.
           */
          '**/firebase-messaging-sw.js',
        ],

        // SPA routes must resolve offline; without this, a reload on /assessment 404s.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],

        cleanupOutdatedCaches: true,

        runtimeCaching: [
          {
            /**
             * Read-only API responses: serve from network when possible, fall back to the
             * last successful response when not. Lets a doctor open the dashboard on a
             * dead connection and still see the last known queue, clearly stale rather
             * than blank.
             */
            urlPattern: ({ url, request }) =>
              request.method === 'GET' &&
              /\/api\/(model|dashboard|district|patients|assessments|chatbot\/suggestions)/.test(url.pathname),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-reads',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 120, maxAgeSeconds: 60 * 60 * 24 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],

  resolve: {
    alias: {
      '@': resolvePath('./src'),
      // The risk engine and chatbot rules live outside this package so the API can import
      // the exact same files. See shared/risk/README context in ml/README.md.
      '@shared': resolvePath('../shared'),
    },
  },

  server: {
    port: 5173,
    // Listen on the LAN too: the demo needs the doctor dashboard open on a second device.
    host: true,
    // Required because @shared resolves outside the Vite project root.
    fs: { allow: ['..'] },
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:4000', ws: true, changeOrigin: true },
    },
  },

  /**
   * `vite preview` does NOT inherit `server.proxy`, so without this block every API call
   * from the production build 404s against the preview server itself.
   *
   * This matters more than it looks: the production build is the ONLY way to test offline
   * reload and PWA install (see the devOptions note above), so it is also how the demo
   * should be run — and a demo where login silently 404s is worse than no demo.
   *
   * Proxying keeps the API same-origin here too, so no extra CORS entry is needed.
   */
  preview: {
    port: 4173,
    host: true,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:4000', ws: true, changeOrigin: true },
    },
  },

  build: {
    outDir: 'dist',
    sourcemap: true,
    // Field devices are low-end Androids on slow connections; keep an eye on bundle size.
    chunkSizeWarningLimit: 700,

    rollupOptions: {
      output: {
        /**
         * Force the Firebase SDK into one predictably-named chunk.
         *
         * Two reasons, and the first is the load-bearing one:
         *
         *   1. `workbox.globIgnores` above needs a stable name to exclude the SDK from the
         *      offline precache. Left to itself Rollup emits Firebase as several
         *      content-hashed `index.esm-*.js` files — a name that comes from Firebase's own
         *      internal file layout, is shared with other packages, and changes between
         *      versions. Matching that with a glob would be guesswork.
         *   2. One 250 KB chunk instead of three arbitrary ones is a single request on a
         *      slow connection, and it is obvious in the build output what it costs.
         *
         * Only applies when phone sign-in is enabled at build time; otherwise the whole
         * feature is tree-shaken out and this never matches anything.
         */
        manualChunks(id: string) {
          if (id.includes('node_modules/firebase/') || id.includes('node_modules/@firebase/')) {
            return 'firebase-sdk';
          }
          return undefined;
        },
      },
    },
  },
  };
});
