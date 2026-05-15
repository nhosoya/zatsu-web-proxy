import { load } from 'cheerio'

export const config = { runtime: 'edge' }

const PROXY_PATH = '/api/proxy'
const FETCH_TIMEOUT_MS = 8_000

// Edge-only cache (no max-age) so browsers always revalidate but Vercel's
// CDN holds the response for `s-maxage` seconds and serves stale within
// `stale-while-revalidate` while it refreshes in the background.
const HTML_CACHE = 'public, s-maxage=300, stale-while-revalidate=86400'
const ASSET_CACHE = 'public, s-maxage=86400, stale-while-revalidate=604800'

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

function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 0) return true
  if (a === 10) return true
  if (a === 127) return true
  if (a === 169 && b === 254) return true // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  return false
}

function isPrivateIPv6(host: string): boolean {
  const lower = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (lower === '::1' || lower === '::') return true
  if (/^fc|^fd/.test(lower)) return true // unique local
  if (/^fe[89ab]/.test(lower)) return true // link-local
  if (lower.startsWith('::ffff:')) {
    // IPv4-mapped IPv6
    const v4 = lower.slice('::ffff:'.length)
    return isPrivateIPv4(v4)
  }
  return false
}

// Block obvious SSRF targets. Does not protect against DNS rebinding —
// a hostname could resolve to a private IP between this check and fetch.
// Mitigating that would require DoH resolution + fetch-by-IP, which is
// out of scope for the zatsu version.
function isBlockedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (lower === 'localhost') return true
  if (lower.endsWith('.localhost')) return true
  if (lower.endsWith('.local')) return true
  if (lower.endsWith('.internal')) return true
  if (lower.endsWith('.lan')) return true
  if (lower.includes(':')) return isPrivateIPv6(lower)
  return isPrivateIPv4(lower)
}

// Rewrite all `url(...)` references in a CSS source string so they flow
// through the proxy. Reuses rewriteUrl() so `data:`, `#fragment`, and
// other non-network schemes are left alone — important for SVG fragment
// refs like `url(#gradient)` and inline data URLs.
function rewriteCssUrls(css: string, baseUrl: string): string {
  return css.replace(
    /url\(\s*(['"]?)([^'")]+?)\1\s*\)/g,
    (_match, quote: string, url: string) => {
      const rewritten = rewriteUrl(url, baseUrl) ?? url
      return `url(${quote}${rewritten}${quote})`
    },
  )
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

function buildFallbackRedirect(
  fallbackPath: string,
  params: URLSearchParams,
  referer: string | null,
): string | null {
  if (!referer) return null
  let refUrl: URL
  try {
    refUrl = new URL(referer)
  } catch {
    return null
  }
  const refTarget = refUrl.searchParams.get('url')
  if (!refTarget) return null
  let upstreamPage: URL
  try {
    upstreamPage = new URL(refTarget)
  } catch {
    return null
  }
  let target: URL
  try {
    target = new URL('/' + fallbackPath, upstreamPage)
  } catch {
    return null
  }
  // Forward any extra query params on the un-rewritten URL (e.g. ?q=foo
  // for a /search?q=foo click) so they reach the upstream.
  for (const [k, v] of params) {
    if (k !== 'fallback_path' && k !== 'url') {
      target.searchParams.append(k, v)
    }
  }
  return new URL(
    `/api/proxy?url=${encodeURIComponent(target.toString())}`,
    refUrl.origin,
  ).toString()
}

// Accept "example.com", "example.com/path", "//example.com", or a full URL
// and produce a URL. Scheme-less input is upgraded to https — http stays
// http here and gets rejected one level up.
function normalizeTargetUrl(input: string): URL | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  let candidate = trimmed
  if (candidate.startsWith('//')) {
    candidate = 'https:' + candidate
  } else if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    candidate = 'https://' + candidate
  }
  try {
    return new URL(candidate)
  } catch {
    return null
  }
}

export default async function handler(request: Request): Promise<Response> {
  const queryString = request.url.split('?')[1] ?? ''
  const params = new URLSearchParams(queryString)
  const target = params.get('url')

  if (!target) {
    // When the proxied page contains links that escaped the HTML rewriter
    // (Mustache-style templates, JS-rendered DOM, etc.), the browser ends
    // up requesting paths like /articles/foo directly on this domain.
    // vercel.json rewrites those to /api/proxy?fallback_path=articles/foo;
    // here we use the Referer's ?url= to reconstruct the upstream origin
    // and redirect to the canonical proxy URL so the rest of the flow
    // (rewriting, caching, the address bar) works normally.
    const fallbackPath = params.get('fallback_path')
    if (fallbackPath !== null) {
      const redirect = buildFallbackRedirect(
        fallbackPath,
        params,
        request.headers.get('referer'),
      )
      if (redirect) return Response.redirect(redirect, 302)
    }
    return new Response('Missing url query parameter', { status: 400 })
  }

  const targetUrl = normalizeTargetUrl(target)
  if (!targetUrl) {
    return new Response('Invalid url', { status: 400 })
  }

  if (targetUrl.protocol !== 'https:') {
    return new Response('Only HTTPS URLs are supported', { status: 400 })
  }

  if (isBlockedHost(targetUrl.hostname)) {
    return new Response('Blocked: private or internal host', { status: 403 })
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

    // Rewrite url(...) inside inline <style> blocks.
    $('style').each((_, el) => {
      const $el = $(el)
      const css = $el.html()
      if (css) $el.html(rewriteCssUrls(css, finalUrl))
    })

    // Rewrite url(...) inside style="..." attributes.
    $('[style]').each((_, el) => {
      const $el = $(el)
      const value = $el.attr('style')
      if (value && value.includes('url(')) {
        $el.attr('style', rewriteCssUrls(value, finalUrl))
      }
    })

    // Subresource integrity hashes won't match after URL rewriting.
    $('[integrity]').removeAttr('integrity')
    $('[crossorigin]').removeAttr('crossorigin')
    // Origin CSP would block proxied subresources.
    $('meta[http-equiv="Content-Security-Policy"]').remove()
    // <base> would interfere with our absolute-URL rewrites.
    $('base').remove()

    // Inject a sticky address bar so the user can navigate to another URL
    // without going back to "/". Uses a high z-index and namespaced IDs to
    // minimize collisions with the underlying page. The bar can be hidden
    // via the × button; a small "zatsu" pin in the top-right corner brings
    // it back. Hidden state persists across pages via localStorage.
    $('head').append(
      '<style id="__zatsu_proxy_bar_style__">' +
        '#__zatsu_proxy_bar__{position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
        'background:#111;color:#fff;padding:8px 12px;box-sizing:border-box;' +
        'font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
        'box-shadow:0 2px 8px rgba(0,0,0,.3);display:flex;gap:8px;align-items:center}' +
        '#__zatsu_proxy_bar__ form{display:flex;gap:8px;flex:1;margin:0}' +
        '#__zatsu_proxy_bar__ input{flex:1;padding:6px 10px;border-radius:4px;' +
        'border:1px solid #444;background:#fff;color:#000;font:inherit;box-sizing:border-box}' +
        '#__zatsu_proxy_bar__ form button{padding:6px 14px;background:#0070f3;color:#fff;' +
        'border:0;border-radius:4px;font:inherit;cursor:pointer}' +
        '#__zatsu_proxy_close__{padding:0 6px;background:transparent;color:#888;' +
        'border:0;cursor:pointer;font:18px/1 -apple-system,sans-serif}' +
        '#__zatsu_proxy_close__:hover{color:#fff}' +
        // Autocomplete dropdown — dark theme to match the bar.
        '#__zatsu_proxy_bar__ .zatsu-ac-wrap{position:relative;flex:1;display:flex}' +
        '#__zatsu_proxy_bar__ .zatsu-ac-wrap input{flex:1}' +
        '#__zatsu_proxy_bar__ .zatsu-ac-dropdown{position:absolute;top:calc(100% + 4px);' +
        'left:0;right:0;list-style:none;margin:0;padding:4px 0;background:#1c1c1c;' +
        'border:1px solid #333;border-radius:6px;box-shadow:0 6px 24px rgba(0,0,0,.4);' +
        'max-height:280px;overflow-y:auto;z-index:2147483647}' +
        '#__zatsu_proxy_bar__ .zatsu-ac-item{padding:6px 10px;cursor:pointer;font-size:13px;' +
        'color:#ddd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        '#__zatsu_proxy_bar__ .zatsu-ac-item:hover,' +
        '#__zatsu_proxy_bar__ .zatsu-ac-item.active{background:#2a2a2a;color:#fff}' +
        'body{padding-top:48px !important}' +
        // Hidden state: collapse the bar, drop the body padding, and reveal
        // the corner pin. Using html.zatsu-bar-hidden gives enough
        // specificity to beat the default body padding-top rule above.
        '#__zatsu_proxy_open__{display:none;position:fixed;top:0;right:0;z-index:2147483647;' +
        'padding:4px 8px;background:#111;color:#ddd;border:0;' +
        'border-bottom-left-radius:6px;font:11px/1.2 -apple-system,sans-serif;' +
        'cursor:pointer;opacity:.45;transition:opacity .15s}' +
        '#__zatsu_proxy_open__:hover{opacity:1}' +
        'html.zatsu-bar-hidden #__zatsu_proxy_bar__{display:none !important}' +
        'html.zatsu-bar-hidden body{padding-top:0 !important}' +
        'html.zatsu-bar-hidden #__zatsu_proxy_open__{display:block}' +
        '</style>',
    )

    // Apply the hidden class synchronously before render so the bar does
    // not flash in for users who have it hidden.
    $('head').append(
      `<script id="__zatsu_proxy_init__">try{if(localStorage.getItem('zatsu-proxy-bar-hidden')==='1')document.documentElement.classList.add('zatsu-bar-hidden')}catch(e){}</script>`,
    )

    const bar = $(
      '<div id="__zatsu_proxy_bar__">' +
        '<form action="/api/proxy" method="get">' +
        '<input type="text" inputmode="url" autocomplete="off" spellcheck="false" name="url" required placeholder="example.com or https://..." data-zatsu-ac>' +
        '<button type="submit">Go</button>' +
        '</form>' +
        '<button type="button" id="__zatsu_proxy_close__" title="Hide proxy bar" aria-label="Hide proxy bar">×</button>' +
        '</div>',
    )
    bar
      .find('input')
      .attr('value', finalUrl)
      .attr('data-zatsu-current-url', finalUrl)
    $('body').prepend(bar)
    $('body').prepend(
      '<button type="button" id="__zatsu_proxy_open__" title="Show proxy bar" aria-label="Show proxy bar">zatsu</button>',
    )

    // Shared autocomplete + history logic lives in /proxy-bar.js so both
    // entry points (landing form and this injected bar) stay in sync.
    $('body').append('<script src="/proxy-bar.js" defer></script>')

    // Hide/show toggle. Kept inline because it is specific to the injected
    // bar; proxy-bar.js stays generic for any host that wants autocomplete.
    $('body').append(
      `<script id="__zatsu_proxy_toggle__">(function(){var K='zatsu-proxy-bar-hidden';function s(h){var c=document.documentElement.classList;if(h)c.add('zatsu-bar-hidden');else c.remove('zatsu-bar-hidden');try{localStorage.setItem(K,h?'1':'0')}catch(e){}}var c=document.getElementById('__zatsu_proxy_close__'),o=document.getElementById('__zatsu_proxy_open__');if(c)c.addEventListener('click',function(){s(true)});if(o)o.addEventListener('click',function(){s(false)})})();</script>`,
    )

    return new Response($.html(), {
      status: upstream.status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // Only cache successful responses; otherwise an upstream blip
        // would be served stale for the whole TTL window.
        'Cache-Control': upstream.ok ? HTML_CACHE : 'no-store',
      },
    })
  }

  if (contentType.toLowerCase().includes('text/css')) {
    const css = await upstream.text()
    return new Response(rewriteCssUrls(css, finalUrl), {
      status: upstream.status,
      headers: {
        'Content-Type': 'text/css; charset=utf-8',
        'Cache-Control': upstream.ok ? ASSET_CACHE : 'no-store',
      },
    })
  }

  const body = await upstream.arrayBuffer()
  return new Response(body, {
    status: upstream.status,
    headers: {
      'Content-Type': contentType || 'application/octet-stream',
      'Cache-Control': upstream.ok ? ASSET_CACHE : 'no-store',
    },
  })
}
