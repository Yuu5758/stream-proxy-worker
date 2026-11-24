import { Hono } from 'hono'
import { Buffer } from 'node:buffer'

type Bindings = {
	BACKEND_VERIFY_URL?: string
	DEFAULT_REFERER?: string
}

const app = new Hono<{ Bindings: Bindings }>()

// In-memory cache for token validation (reduces latency on frequent segment requests)
interface TokenCacheItem {
	valid: boolean
	expiresAt: number
	user?: any
}
const tokenCache = new Map<string, TokenCacheItem>()

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
	'Access-Control-Allow-Headers': 'Range, Authorization, Cookie, Content-Type, X-Requested-With',
	'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
}

/**
 * Extract auth token/cookie from headers or query params
 */
function extractAuthToken(c: any): string | null {
	// 1. Check Authorization Bearer header
	const authHeader = c.req.header('Authorization') || c.req.header('authorization')
	if (authHeader) {
		const match = authHeader.match(/^Bearer\s+(.+)$/i)
		if (match && match[1]?.trim()) {
			return match[1].trim()
		}
	}

	// 2. Check Cookie header (nonton_jwt_token)
	const cookieHeader = c.req.header('Cookie') || c.req.header('cookie')
	if (cookieHeader) {
		const cookies = cookieHeader.split(';')
		for (const cookie of cookies) {
			const [name, ...val] = cookie.trim().split('=')
			if (name?.trim() === 'nonton_jwt_token') {
				const tokenVal = val.join('=').trim()
				if (tokenVal) return tokenVal
			}
		}
		// If only a raw token was passed in cookie
		if (cookieHeader.trim().split('.').length === 3) {
			return cookieHeader.trim()
		}
	}

	// 3. Check query parameters (?token=... or ?cookie=...)
	const qToken = c.req.query('token') || c.req.query('cookie')
	if (qToken?.trim()) {
		return qToken.trim()
	}

	return null
}

/**
 * Verify token with the Rust backend
 */
async function verifyTokenWithBackend(
	token: string,
	verifyUrl: string
): Promise<{ valid: boolean; error?: string; user?: any }> {
	const now = Date.now()
	const cached = tokenCache.get(token)
	if (cached && cached.expiresAt > now) {
		return { valid: cached.valid, user: cached.user }
	}

	try {
		const response = await fetch(verifyUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'User-Agent': 'stream-proxy-worker/1.0',
				'Cookie': `nonton_jwt_token=${token}`,
				'Authorization': `Bearer ${token}`
			},
			body: JSON.stringify({ token }),
		})

		const data = (await response.json()) as any

		if (response.ok && data?.valid === true) {
			// Cache valid token for 60 seconds (or up to token exp)
			const ttlMs = data.exp ? Math.min((data.exp * 1000) - now, 60000) : 60000
			tokenCache.set(token, {
				valid: true,
				expiresAt: now + Math.max(ttlMs, 10000),
				user: data
			})
			return { valid: true, user: data }
		}

		// Cache invalid token for 5 seconds to throttle hammering
		tokenCache.set(token, {
			valid: false,
			expiresAt: now + 5000
		})
		return { valid: false, error: data?.error || 'Invalid session or token' }
	} catch (err: any) {
		console.error('Backend verification error:', err)
		return { valid: false, error: `Verification service unavailable: ${err?.message || err}` }
	}
}

/**
 * Rewrite HLS (.m3u8) playlists so all segments and keys route through this proxy
 */
function rewriteHlsManifest(
	manifestText: string,
	manifestUrl: string,
	proxyOrigin: string,
	token: string,
	referer: string
): string {
	const lines = manifestText.split('\n')
	const rewrittenLines: string[] = []

	const buildProxyUrl = (targetUri: string) => {
		try {
			const resolved = new URL(targetUri, manifestUrl).toString()
			return `${proxyOrigin}/proxy?url=${encodeURIComponent(resolved)}&token=${encodeURIComponent(token)}&referer=${encodeURIComponent(referer)}`
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
	token: string,
	referer: string
): string {
	const tokB64 = Buffer.from(token).toString('base64url')
	const refB64 = Buffer.from(referer).toString('base64url')
	const dashPrefix = `${proxyOrigin}/dash/${tokB64}/${refB64}/`

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
 * Core Proxy Handler
 */
async function handleStreamProxy(
	c: any,
	targetUrl: string,
	referer: string,
	token: string
) {
	// STRICT COOKIE CHECK: Token is mandatory
	if (!token) {
		return c.json({
			error: 'Forbidden',
			message: 'Wajib cookies/token: Autentikasi session nonton.blog diperlukan.'
		}, 401, CORS_HEADERS)
	}

	// Verify token with Rust backend
	const verifyUrl = c.env?.BACKEND_VERIFY_URL || 'https://nonton.blog/api/auth/verify-cookie'
	const verifyResult = await verifyTokenWithBackend(token, verifyUrl)
	if (!verifyResult.valid) {
		return c.json({
			error: 'Unauthorized',
			message: `Verifikasi cookies gagal: ${verifyResult.error || 'Token tidak valid atau kedaluwarsa'}`
		}, 401, CORS_HEADERS)
	}

	// Setup headers to fetch target CDN
	const fetchHeaders: Record<string, string> = {
		'Referer': referer,
		'Origin': new URL(referer).origin,
		'User-Agent': c.req.header('User-Agent') || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
	}

	// Forward video seeking Range header
	const rangeHeader = c.req.header('range') || c.req.header('Range')
	if (rangeHeader) {
		fetchHeaders['Range'] = rangeHeader
	}

	// Forward Cookies to upstream CDN if client provided them
	fetchHeaders['Cookie'] = `nonton_jwt_token=${token}`

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
			const rewritten = rewriteHlsManifest(text, targetUrl, proxyOrigin, token, referer)
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
			const rewritten = rewriteDashManifest(text, targetUrl, proxyOrigin, token, referer)
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
 * - Path format: /proxy?url=...
 * - Handles typo: ?url?=...
 */
app.get('/', async (c) => {
	let targetUrl = c.req.query('url')
	if (!targetUrl) {
		// Handle typo like ?url?=https://...
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

	if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
		targetUrl = 'https://' + targetUrl
	}

	const referer = c.req.query('referer') || c.env?.DEFAULT_REFERER || 'https://nonton.blog/'
	const token = extractAuthToken(c)

	return handleStreamProxy(c, targetUrl, referer, token || '')
})

app.get('/proxy', async (c) => {
	let targetUrl = c.req.query('url')
	if (!targetUrl) {
		return c.json({
			error: 'Bad Request',
			message: 'Parameter "url" wajib diisi.'
		}, 400, CORS_HEADERS)
	}

	if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
		targetUrl = 'https://' + targetUrl
	}

	const referer = c.req.query('referer') || c.env?.DEFAULT_REFERER || 'https://nonton.blog/'
	const token = extractAuthToken(c)

	return handleStreamProxy(c, targetUrl, referer, token || '')
})

/**
 * DASH segment route: /dash/:tokB64/:refB64/*
 * Preserves token and referer safely in the URL path for XML segment resolution
 */
app.get('/dash/:tokB64/:refB64/*', async (c) => {
	const tokB64 = c.req.param('tokB64')
	const refB64 = c.req.param('refB64')

	let token = ''
	let referer = 'https://nonton.blog/'

	try {
		token = Buffer.from(tokB64, 'base64url').toString('utf8')
		referer = Buffer.from(refB64, 'base64url').toString('utf8')
	} catch {
		return c.json({ error: 'Invalid dash proxy parameters' }, 400, CORS_HEADERS)
	}

	const path = new URL(c.req.url).pathname
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

	return handleStreamProxy(c, targetUrl, referer, token)
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
		) as { directUrl: string; referer: string; token?: string }

		const { directUrl, referer } = streamKeyObj
		const token = streamKeyObj.token || extractAuthToken(c) || ''

		return handleStreamProxy(c, directUrl, referer || 'https://nonton.blog/', token)
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
