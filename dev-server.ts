import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import handler from './api/proxy.ts'

const PORT = Number(process.env.PORT ?? 3000)
const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'public')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

    if (url.pathname === '/api/proxy') {
      const request = new Request(url.toString(), {
        method: req.method,
        headers: req.headers as Record<string, string>,
      })
      const response = await handler(request)
      res.statusCode = response.status
      response.headers.forEach((value, key) => res.setHeader(key, value))
      if (response.body) {
        Readable.fromWeb(response.body as any).pipe(res)
      } else {
        res.end()
      }
      return
    }

    const filePath = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '')
    const resolved = join(PUBLIC_DIR, filePath)
    if (!resolved.startsWith(PUBLIC_DIR)) {
      res.statusCode = 403
      res.end('Forbidden')
      return
    }
    const body = await readFile(resolved)
    res.setHeader('Content-Type', MIME[extname(resolved)] ?? 'application/octet-stream')
    res.end(body)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error'
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      res.statusCode = 404
      res.end('Not Found')
      return
    }
    res.statusCode = 500
    res.end(message)
  }
})

server.listen(PORT, () => {
  console.log(`Web proxy dev server: http://localhost:${PORT}`)
})
