import { load } from 'cheerio'

export const config = { runtime: 'edge' }

const PROXY_PATH = '/api/proxy'
const FETCH_TIMEOUT_MS = 8_000

function rewriteUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) return value
  const trimmed = value.trim()
  if (!trimmed) return value
  if (
    trimmed.startsWith('#') ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('javascript:') ||
    trimmed.startsWith('mailto:') ||
    trimmed.startsWith('tel:') ||
    trimmed.startsWith('about:') ||
    trimmed.startsWith('blob:')
  ) {
    return value
  }
  try {
    const absolute = new URL(trimmed, baseUrl).toString()
    return `${PROXY_PATH}?url=${encodeURIComponent(absolute)}`
  } catch {
    return value
  }
}

function rewriteSrcset(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) return value
  return value
    .split(',')
    .map(part => {
      const trimmed = part.trim()
      if (!trimmed) return trimmed
      const [url, ...descriptors] = trimmed.split(/\s+/)
      const rewritten = rewriteUrl(url, baseUrl) ?? url
      return [rewritten, ...descriptors].join(' ')
    })
    .join(', ')
}

export default async function handler(request: Request): Promise<Response> {
  const queryString = request.url.split('?')[1] ?? ''
  const target = new URLSearchParams(queryString).get('url')

  if (!target) {
    return new Response('Missing url query parameter', { status: 400 })
  }

  let targetUrl: URL
  try {
    targetUrl = new URL(target)
  } catch {
    return new Response('Invalid url', { status: 400 })
  }

  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    return new Response('Only http/https URLs are supported', { status: 400 })
  }

  let upstream: Response
  try {
    upstream = await fetch(targetUrl.toString(), {
      method: 'GET',
      headers: {
        'User-Agent':
          request.headers.get('user-agent') ??
          'Mozilla/5.0 (compatible; web-proxy/0.1)',
        Accept: request.headers.get('accept') ?? '*/*',
        'Accept-Language': request.headers.get('accept-language') ?? 'en',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error'
    return new Response(`Upstream fetch failed: ${message}`, { status: 502 })
  }

  const contentType = upstream.headers.get('content-type') ?? ''
  const finalUrl = upstream.url || targetUrl.toString()

  if (contentType.toLowerCase().includes('text/html')) {
    const html = await upstream.text()
    const $ = load(html)

    const rewriteAttr = (selector: string, attr: string) => {
      $(selector).each((_, el) => {
        const $el = $(el)
        const value = $el.attr(attr)
        const rewritten = rewriteUrl(value, finalUrl)
        if (rewritten !== undefined && rewritten !== value) {
          $el.attr(attr, rewritten)
        }
      })
    }

    rewriteAttr('a[href]', 'href')
    rewriteAttr('area[href]', 'href')
    rewriteAttr('link[href]', 'href')
    rewriteAttr('img[src]', 'src')
    rewriteAttr('script[src]', 'src')
    rewriteAttr('iframe[src]', 'src')
    rewriteAttr('source[src]', 'src')
    rewriteAttr('video[src]', 'src')
    rewriteAttr('audio[src]', 'src')
    rewriteAttr('embed[src]', 'src')
    rewriteAttr('form[action]', 'action')

    $('img[srcset], source[srcset]').each((_, el) => {
      const $el = $(el)
      const value = $el.attr('srcset')
      const rewritten = rewriteSrcset(value, finalUrl)
      if (rewritten !== undefined && rewritten !== value) {
        $el.attr('srcset', rewritten)
      }
    })

    // Subresource integrity hashes won't match after URL rewriting.
    $('[integrity]').removeAttr('integrity')
    $('[crossorigin]').removeAttr('crossorigin')
    // Origin CSP would block proxied subresources.
    $('meta[http-equiv="Content-Security-Policy"]').remove()
    // <base> would interfere with our absolute-URL rewrites.
    $('base').remove()

    return new Response($.html(), {
      status: upstream.status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
      },
    })
  }

  const body = await upstream.arrayBuffer()
  return new Response(body, {
    status: upstream.status,
    headers: {
      'Content-Type': contentType || 'application/octet-stream',
      'Cache-Control': upstream.headers.get('cache-control') ?? 'public, max-age=3600',
    },
  })
}
