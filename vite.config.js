import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base: './' => relative asset paths, so the built site works on GitHub Pages subpaths
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist' }
})