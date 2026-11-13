import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// The NEAR wallet libraries expect Node's Buffer/process/global, which browsers lack.
export default defineConfig({
  server: { port: 6002 },
  plugins: [react(), nodePolyfills({ globals: { Buffer: true, global: true, process: true } })]
})
