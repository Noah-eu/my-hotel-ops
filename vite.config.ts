import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
    server: { port: 5173 },
    plugins: [
        VitePWA({
            registerType: 'autoUpdate',
            includeAssets: [
                'icons/chill-ops-icon.svg',
                'icons/favicon.svg',
                'icons/favicon-32x32.png',
                'icons/apple-touch-icon.png'
            ],
            manifest: {
                name: 'Chill Apartments Ops',
                short_name: 'Chill Ops',
                description: 'Mobilni provozni aplikace pro denni operace apartmanu.',
                start_url: '/',
                scope: '/',
                display: 'standalone',
                theme_color: '#0b7db0',
                background_color: '#f8fafc',
                icons: [
                    {
                        src: '/icons/pwa-192x192.png',
                        sizes: '192x192',
                        type: 'image/png'
                    },
                    {
                        src: '/icons/pwa-512x512.png',
                        sizes: '512x512',
                        type: 'image/png'
                    },
                    {
                        src: '/icons/pwa-512x512-maskable.png',
                        sizes: '512x512',
                        type: 'image/png',
                        purpose: 'maskable'
                    }
                ]
            },
            workbox: {
                globPatterns: ['**/*.{js,css,html,png,svg,ico,woff2}'],
                cleanupOutdatedCaches: true,
                runtimeCaching: []
            }
        })
    ]
})
