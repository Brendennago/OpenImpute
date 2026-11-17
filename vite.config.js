import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// `base` must match the repo name so assets load from
// https://brendennago.github.io/OpenImpute/
export default defineConfig({
  plugins: [react()],
  base: '/OpenImpute/',
})
