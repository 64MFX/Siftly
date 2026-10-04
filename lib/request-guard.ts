/**
 * Siftly has no accounts of its own, so routes that handle the X login refuse
 * requests another website makes from the user's browser (CSRF). Requests
 * from Siftly's own pages, curl and the CLI pass.
 */
export function isCrossSiteRequest(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site')
  // "same-site" includes other ports on localhost — still a different app
  if (site === 'cross-site' || site === 'same-site') return true
  const origin = request.headers.get('origin')
  if (!origin) return false
  if (origin === 'null') return true
  try {
    return new URL(origin).host !== request.headers.get('host')
  } catch {
    return true
  }
}

/** Whether the request came from the computer Siftly runs on */
export function isLocalRequest(request: Request): boolean {
  const host = request.headers.get('host')
  if (!host) return true
  try {
    const { hostname } = new URL(`http://${host}`)
    return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '[::1]'
  } catch {
    return false
  }
}
