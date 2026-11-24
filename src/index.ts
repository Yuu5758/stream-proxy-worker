import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { Buffer } from 'node:buffer'

type Bindings = {
	DEFAULT_REFERER?: string
}

const app = new Hono<{ Bindings: Bindings }>()

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Range, Authorization, Cookie, Content-Type, X-Requested-With, Origin, Accept',
	'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
}

// Global Hono CORS Middleware
app.use(
	'*',
	cors({
		origin: (origin) => origin || '*',
		allowMethods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
		allowHeaders: ['Range', 'Authorization', 'Cookie', 'Content-Type', 'X-Requested-With', 'Origin', 'Accept'],
		exposeHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges', 'Content-Type'],
		maxAge: 86400,
	})
)

/**
 * Clean target URL and unwrap any recursive proxy layers, extracting leaked ref/origin.
 */
function cleanTargetUrlAndExtractParams(targetUrl: string): {
	cleanUrl: string
	ref?: string
	origin?: string
} {
	let current = targetUrl.trim()
	let extractedRef: string | undefined
	let extractedOrigin: string | undefined

	while (
		current.includes('proxy.nonton.blog') ||
		current.includes('/api/proxy')
	) {
		const mRef = current.match(/[?&](?:ref|referer)=([^&]+)/)
		if (mRef && mRef[1] && !extractedRef) {
			try {
				extractedRef = decodeURIComponent(mRef[1])
			} catch {
				extractedRef = mRef[1]
			}
		}
		const mOrig = current.match(/[?&]origin=([^&]+)/)
		if (mOrig && mOrig[1] && !extractedOrigin) {
			try {
				extractedOrigin = decodeURIComponent(mOrig[1])
			} catch {
				extractedOrigin = mOrig[1]
			}
		}
		const match = current.match(/[?&]url=([^&]+)/)
		if (match && match[1]) {
			try {
				current = decodeURIComponent(match[1])
			} catch {
				current = match[1]
			}
		} else {
			break
		}
	}

	if (!current.includes('?') && current.includes('&')) {
		current = current.replace('&', '?')
	}

	if (!current.startsWith('http://') && !current.startsWith('https://')) {
		current = 'https://' + current
	}

	try {
		const parsed = new URL(current)
		if (!extractedRef) {
			extractedRef = parsed.searchParams.get('ref') || parsed.searchParams.get('referer') || undefined
		}
		if (!extractedOrigin) {
			extractedOrigin = parsed.searchParams.get('origin') || undefined
		}

		parsed.searchParams.delete('ref')
		parsed.searchParams.delete('referer')
		parsed.searchParams.delete('token')
		parsed.searchParams.delete('origin')

		current = parsed.toString()
	} catch {}

	return {
		cleanUrl: current,
		ref: extractedRef,
		origin: extractedOrigin
	}
}

/**
 * Rewrite HLS (.m3u8) playlists so all segments and keys route through this proxy
 */
function rewriteHlsManifest(
	manifestText: string,
	manifestUrl: string,
	proxyOrigin: string,
	referer: string
): string {
	const lines = manifestText.split('\n')
	const rewrittenLines: string[] = []

	const buildProxyUrl = (targetUri: string) => {
		try {
			const resolved = new URL(targetUri, manifestUrl).toString()
			return `${proxyOrigin}/proxy?url=${encodeURIComponent(resolved)}&ref=${encodeURIComponent(referer)}`
		} catch {
			return targetUri
		}
	}

	for (let line of lines) {
		const trimmed = line.trim()
		if (!trimmed) {
			rewrittenLines.push(line)
			continue
		}

		if (trimmed.startsWith('#')) {
			// Rewrite URIs in tags like #EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA
			if (
				trimmed.startsWith('#EXT-X-KEY') ||
				trimmed.startsWith('#EXT-X-MAP') ||
				trimmed.startsWith('#EXT-X-MEDIA')
			) {
				const replaced = line.replace(/URI="([^"]+)"/g, (_, uri) => {
					return `URI="${buildProxyUrl(uri)}"`
				})
				rewrittenLines.push(replaced)
			} else {
				rewrittenLines.push(line)
			}
		} else {
			// Non-comment lines are segment URIs or sub-playlists
			rewrittenLines.push(buildProxyUrl(trimmed))
		}
	}

	return rewrittenLines.join('\n')
}

/**
 * Rewrite DASH (.mpd) manifests so media segments route through this proxy
 */
function rewriteDashManifest(
	mpdXml: string,
	mpdUrl: string,
	proxyOrigin: string,
	referer: string
): string {
	const refB64 = Buffer.from(referer).toString('base64url')
	const dashPrefix = `${proxyOrigin}/dash/${refB64}/`

	// Find the MPD base directory
	const mpdBase = mpdUrl.substring(0, mpdUrl.lastIndexOf('/') + 1)

	let modified = mpdXml

	// 1. Rewrite existing <BaseURL> tags
	if (/<BaseURL>/i.test(modified)) {
		modified = modified.replace(/<BaseURL>([^<]+)<\/BaseURL>/gi, (_, baseVal) => {
			try {
				const resolved = new URL(baseVal.trim(), mpdUrl).toString()
				return `<BaseURL>${dashPrefix}${encodeURIComponent(resolved)}/</BaseURL>`
			} catch {
				return `<BaseURL>${dashPrefix}${encodeURIComponent(baseVal.trim())}/</BaseURL>`
			}
		})
	} else {
		// 2. Insert <BaseURL> tag right after <MPD ...>
		const mpdTagMatch = modified.match(/<MPD[^>]*>/i)
		if (mpdTagMatch) {
			const mpdTag = mpdTagMatch[0]
			const insertion = `\n  <BaseURL>${dashPrefix}${encodeURIComponent(mpdBase)}</BaseURL>`
			modified = modified.replace(mpdTag, mpdTag + insertion)
		}
	}

	// 3. Rewrite absolute URLs in media="..." or initialization="..." attributes
	modified = modified.replace(/(media|initialization)="(https?:\/\/[^"]+)"/gi, (_, attr, absUrl) => {
		const proxied = `${dashPrefix}${encodeURIComponent(absUrl)}`
		return `${attr}="${proxied}"`
	})

	return modified
}

/**
 * Core Proxy Handler (No cookies required)
 */
async function handleStreamProxy(
	c: any,
	targetUrl: string,
	referer: string
) {
	let originHeader = ''
	try {
		originHeader = new URL(referer).origin
	} catch {
		originHeader = 'https://nonton.blog'
	}

	// Setup headers to fetch target CDN
	const fetchHeaders: Record<string, string> = {
		'Referer': referer,
		'Origin': originHeader,
		'User-Agent': c.req.header('User-Agent') || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
	}

	// Forward video seeking Range header
	const rangeHeader = c.req.header('range') || c.req.header('Range')
	if (rangeHeader) {
		fetchHeaders['Range'] = rangeHeader
	}

	// Forward client Cookie if any
	const clientCookie = c.req.header('Cookie') || c.req.header('cookie')
	if (clientCookie) {
		fetchHeaders['Cookie'] = clientCookie
	}

	try {
		const response = await fetch(targetUrl, {
			method: c.req.method,
			headers: fetchHeaders,
			redirect: 'follow'
		})

		const contentType = (response.headers.get('content-type') || '').toLowerCase()
		const urlLower = targetUrl.toLowerCase()
		const isHls = contentType.includes('mpegurl') || contentType.includes('application/x-mpegurl') || urlLower.includes('.m3u8')
		const isDash = contentType.includes('dash+xml') || urlLower.includes('.mpd')

		const proxyOrigin = new URL(c.req.url).origin

		// Rewrite HLS manifest
		if (isHls && response.ok) {
			const text = await response.text()
			const rewritten = rewriteHlsManifest(text, targetUrl, proxyOrigin, referer)
			return new Response(rewritten, {
				status: response.status,
				headers: {
					...CORS_HEADERS,
					'Content-Type': 'application/vnd.apple.mpegurl',
					'Cache-Control': 'no-cache, no-store, must-revalidate',
				}
			})
		}

		// Rewrite DASH manifest
		if (isDash && response.ok) {
			const text = await response.text()
			const rewritten = rewriteDashManifest(text, targetUrl, proxyOrigin, referer)
			return new Response(rewritten, {
				status: response.status,
				headers: {
					...CORS_HEADERS,
					'Content-Type': 'application/dash+xml',
					'Cache-Control': 'no-cache, no-store, must-revalidate',
				}
			})
		}

		// Passthrough standard media chunks / MP4 streaming
		const headers = new Headers()
		const passThrough = [
			'content-type',
			'content-length',
			'content-range',
			'accept-ranges',
			'cache-control',
			'last-modified',
			'etag',
			'content-disposition'
		]

		passThrough.forEach(header => {
			const value = response.headers.get(header)
			if (value) headers.set(header, value)
		})

		for (const [key, value] of Object.entries(CORS_HEADERS)) {
			headers.set(key, value)
		}

		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers
		})
	} catch (error: any) {
		return c.json({
			error: 'Stream fetch failed',
			message: error instanceof Error ? error.message : 'Unknown upstream error'
		}, 502, CORS_HEADERS)
	}
}

// ---------------------------
// ROUTES
// ---------------------------

// CORS Preflight
app.options('*', (c) => {
	return new Response(null, {
		headers: CORS_HEADERS
	})
})

/**
 * Main proxy route:
 * - Query format: /?url=https://cdn.anime.net/video.mp4
 * - Handles typo: ?url?=...
 */
app.get('/', async (c) => {
	let targetUrl = c.req.query('url')
	if (!targetUrl) {
		const rawQuery = new URL(c.req.url).search
		const match = rawQuery.match(/[?&]url\??=([^&]+)/)
		if (match && match[1]) {
			targetUrl = decodeURIComponent(match[1])
		}
	}

	if (!targetUrl) {
		return c.json({
			error: 'Bad Request',
			message: 'Parameter "url" wajib diisi. Contoh: /?url=https://cdn.anime.net/stream.m3u8'
		}, 400, CORS_HEADERS)
	}

	const parsed = cleanTargetUrlAndExtractParams(targetUrl)
	const referer = c.req.query('referer') || c.req.query('ref') || parsed.ref || c.env?.DEFAULT_REFERER || 'https://nonton.blog/'

	return handleStreamProxy(c, parsed.cleanUrl, referer)
})

app.get('/proxy', async (c) => {
	let targetUrl = c.req.query('url')
	if (!targetUrl) {
		return c.json({
			error: 'Bad Request',
			message: 'Parameter "url" wajib diisi.'
		}, 400, CORS_HEADERS)
	}

	const parsed = cleanTargetUrlAndExtractParams(targetUrl)
	const referer = c.req.query('referer') || c.req.query('ref') || parsed.ref || c.env?.DEFAULT_REFERER || 'https://nonton.blog/'

	return handleStreamProxy(c, parsed.cleanUrl, referer)
})

/**
 * DASH segment route: /dash/:refB64/*
 */
app.get('/dash/:refB64/*', async (c) => {
	const refB64 = c.req.param('refB64')
	let referer = 'https://nonton.blog/'
	try {
		referer = Buffer.from(refB64, 'base64url').toString('utf8')
	} catch {}

	const path = new URL(c.req.url).pathname
	const prefix = `/dash/${refB64}/`
	let targetRaw = path.substring(path.indexOf(prefix) + prefix.length)
	if (!targetRaw) {
		return c.json({ error: 'Target URL missing' }, 400, CORS_HEADERS)
	}

	let targetUrl = targetRaw
	try {
		targetUrl = decodeURIComponent(targetRaw)
	} catch {}

	if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
		targetUrl = 'https://' + targetUrl
	}

	return handleStreamProxy(c, targetUrl, referer)
})

/**
 * Legacy DASH segment route with token parameter: /dash/:tokB64/:refB64/*
 */
app.get('/dash/:tokB64/:refB64/*', async (c) => {
	const refB64 = c.req.param('refB64')
	let referer = 'https://nonton.blog/'
	try {
		referer = Buffer.from(refB64, 'base64url').toString('utf8')
	} catch {}

	const path = new URL(c.req.url).pathname
	const tokB64 = c.req.param('tokB64')
	const prefix = `/dash/${tokB64}/${refB64}/`
	let targetRaw = path.substring(path.indexOf(prefix) + prefix.length)
	if (!targetRaw) {
		return c.json({ error: 'Target URL missing' }, 400, CORS_HEADERS)
	}

	let targetUrl = targetRaw
	try {
		targetUrl = decodeURIComponent(targetRaw)
	} catch {}

	if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
		targetUrl = 'https://' + targetUrl
	}

	return handleStreamProxy(c, targetUrl, referer)
})

/**
 * Legacy base64 stream key route: /stream/:stream_key
 */
app.get('/stream/:stream_key', async (c) => {
	const stream_key = c.req.param('stream_key')
	if (!stream_key) {
		return c.text('stream_key is required', 400, CORS_HEADERS)
	}

	try {
		const streamKeyObj = JSON.parse(
			Buffer.from(stream_key, 'base64url').toString('utf8')
		) as { directUrl: string; referer: string }

		const { directUrl, referer } = streamKeyObj
		return handleStreamProxy(c, directUrl, referer || 'https://nonton.blog/')
	} catch (error: any) {
		return c.json({
			error: 'Invalid stream_key',
			message: error instanceof Error ? error.message : 'Unknown decode error'
		}, 400, CORS_HEADERS)
	}
})

app.all('*', (c) => {
	return c.text('Not Found', 404, CORS_HEADERS)
})

export default app
