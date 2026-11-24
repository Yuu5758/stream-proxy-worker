# Stream Proxy Worker

Cloudflare Worker berkinerja tinggi untuk mem-proxy streaming video/audio (MP4, HLS `.m3u8`, DASH `.mpd`) dengan verifikasi cookie/token wajib dari **nonton.blog**, auto-rewrite manifest, forwarding byte-range headers, dan perlindungan CORS.

---

## Fitur Utama

- 🔒 **Wajib Cookie / Token (Strict Auth)**: Setiap request stream wajib menyertakan cookie `nonton_jwt_token` atau header `Authorization: Bearer <token>`. Worker memverifikasi token secara real-time ke endpoint backend Rust `https://nonton.blog/api/auth/verify-cookie`.
- 📺 **Dukungan HLS Manifest (`.m3u8`)**: Otomatis me-rewrite URI chunk (`.ts`), key enkripsi (`#EXT-X-KEY`), `#EXT-X-MAP`, dan sub-playlist agar seluruh segmen tetap melewati proxy worker dengan membawa autentikasi dan referer.
- 📦 **Dukungan DASH Manifest (`.mpd`)**: Otomatis me-rewrite / menginjeksi `<BaseURL>` dan atribut `media` / `initialization` ke format route `/dash/:token/:referer/*`, sehingga seluruh segmen `.m4s` di-load via worker proxy tanpa kehilangan cookie session.
- ⏩ **HTTP Range Requests (Video Seeking)**: Meneruskan header `Range` dan `Content-Range` sehingga video MP4 dan segmen dapat di-seek lancar tanpa buffering penuh.
- 🌐 **CORS Preflight & Headers**: Mendukung streaming cross-origin dengan header `Access-Control-Allow-Origin: *`.

---

## Endpoint & Format Penggunaan

### 1. Format Query (Rekomendasi Player)
```
GET https://proxy.nonton.blog/?url=https://cdn.anime.net/stream.m3u8
```
- Parameter query:
  - `url` *(wajib)*: URL stream target (didukung format `?url=...` maupun toleran typo `url?=...`).
  - `referer` *(opsional)*: Default ke `https://nonton.blog/`.
  - `token` *(opsional)*: Token JWT jika tidak bisa mengirim cookie via header.

### 2. Format Path DASH Segment
```
GET https://proxy.nonton.blog/dash/:tokenB64/:refererB64/:encodedUrl
```
Dibuat otomatis oleh worker saat mem-proxy manifest DASH `.mpd`.

### 3. Format Legacy Base64 Stream Key
```
GET https://proxy.nonton.blog/stream/:stream_key
```
Di mana `:stream_key` adalah objek JSON yang di-base64url encode:
```json
{
  "directUrl": "https://cdn.anime.net/stream.m3u8",
  "referer": "https://nonton.blog/",
  "token": "eyJhbGciOi..."
}
```

---

## Autentikasi Cookies

Worker memeriksa autentikasi melalui urutan berikut:
1. Header `Authorization: Bearer <JWT>`
2. Header `Cookie: nonton_jwt_token=<JWT>`
3. Query string `?token=<JWT>` atau `?cookie=<JWT>`

Jika token hilang atau tidak valid saat divalidasi ke Rust backend (`/api/auth/verify-cookie`), Worker akan mengembalikan HTTP 401 Unauthorized:
```json
{
  "error": "Forbidden",
  "message": "Wajib cookies/token: Autentikasi session nonton.blog diperlukan."
}
```

---

## Deploy ke Cloudflare Workers

1. Install dependencies:
```bash
npm install
```

2. Jalankan lokal dev:
```bash
npm run dev
```

3. Deploy ke Cloudflare:
```bash
npm run deploy
```
