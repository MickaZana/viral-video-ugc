import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Unmount any React tree between tests so assertions in one test never leak
// into the next. globals are off, so RTL's auto-cleanup won't fire on its own.
afterEach(() => {
  cleanup()
})
