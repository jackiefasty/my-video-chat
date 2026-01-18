import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: [['babel-plugin-react-compiler']],
      },
    }),
  ],
  server: {
    // Allow binding to network interfaces so other devices/ngrok can reach the dev server
    host: true,
    port: 5174,
    // If you use a custom ngrok subdomain, add it here so Vite accepts requests proxied by ngrok.
    // Replace with your actual ngrok hostname if it changes.
    allowedHosts: ['kneelingly-unblazoned-holley.ngrok-free.dev', 'localhost', '192.168.1.214'],
    // When accessed through ngrok over HTTPS, set origin to the public URL to make HMR/asset URLs resolve correctly.
    // origin: 'https://kneelingly-unblazoned-holley.ngrok-free.dev',
  },
})
