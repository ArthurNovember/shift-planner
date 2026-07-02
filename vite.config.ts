import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Vercel serves the app from the domain root; GitHub Pages serves it under /shift-planner/.
  // Vercel sets the VERCEL env var during its build, so this picks the right base for each.
  base: process.env.VERCEL ? '/' : '/shift-planner/',
  plugins: [react()],
})
