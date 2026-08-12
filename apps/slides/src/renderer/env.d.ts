/// <reference types="vite/client" />
import type { SlidesApi } from '../shared/ipc'
import type { ProjectApi } from '@prismoffice/project-store'

declare global {
  interface Window {
    slidesApi: SlidesApi
    projectApi: ProjectApi
  }
}

export {}
