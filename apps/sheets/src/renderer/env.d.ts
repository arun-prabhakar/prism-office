declare module '*.md?raw' {
  const content: string
  export default content
}

import type { DesktopApi } from '../shared/desktop-api'
import type { ProjectApi } from '@prismoffice/project-store'

declare global {
  interface Window {
    readonly desktopApi: DesktopApi
    readonly projectApi: ProjectApi
    /** Set by the web entry (main-web.tsx) before the renderer boots; the
     *  desktop build leaves it undefined. Gates web-only/hidden chrome. */
    __prismofficeWeb?: boolean
  }
}

export {}
