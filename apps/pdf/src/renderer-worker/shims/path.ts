export function join(...parts: string[]): string {
  return parts.join('/').replace(/\/+/g, '/')
}
export function dirname(p: string): string {
  return p.split('/').slice(0, -1).join('/') || '.'
}
export function basename(p: string): string {
  return p.split('/').pop() ?? p
}
export function extname(p: string): string {
  const b = basename(p)
  const i = b.lastIndexOf('.')
  return i < 0 ? '' : b.slice(i)
}
