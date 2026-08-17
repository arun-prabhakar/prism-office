/// <reference types="vite/client" />

import type { DesktopApi } from '../shared/ipc'
import type { ProjectApi } from '@prismoffice/project-store'

declare global {
  interface Window {
    desktop: DesktopApi
    projectApi: ProjectApi
    /** Set by the web entry (main-web.tsx) before the renderer boots; the
     *  desktop build leaves it undefined. Gates web-only/hidden chrome. */
    __prismofficeWeb?: boolean
  }
}

export {}
