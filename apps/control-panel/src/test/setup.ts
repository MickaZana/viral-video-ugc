import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Unmount any React tree between tests so assertions in one test never leak
// into the next. globals are off, so RTL's auto-cleanup won't fire on its own.
afterEach(() => {
  cleanup()
  // App writes the selected theme to the document root synchronously. Reset
  // that global DOM state as well as storage so a following test starts from
  // the same browser state whether this file ran alone or in a larger suite.
  delete document.documentElement.dataset.theme
  document.documentElement.classList.remove('theme-transition')
  localStorage.clear()
  sessionStorage.clear()
})
