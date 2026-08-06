import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Test-only config. When a vitest.config.ts exists Vitest uses it in place of
// vite.config.ts, so this deliberately does NOT pull in the Tailwind plugin —
// the smoke tests render React components directly in jsdom and never import
// the app's CSS. The React plugin is still needed for the JSX transform.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true
  }
})
