import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Split rarely-changing vendor code into its own chunk so app edits
        // don't invalidate it in the browser cache. hls.js is deliberately not
        // matched here: it is dynamically imported and should stay its own lazy
        // chunk. Note "node_modules/react" does not match "lucide-react".
        manualChunks(id) {
          if (
            id.includes('node_modules/react') ||
            id.includes('node_modules/scheduler')
          ) {
            return 'react-vendor';
          }
          return undefined;
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:5000',
      '/uploads': 'http://localhost:5000',
      '/streams': 'http://localhost:5000',
    },
  },
})
