import {lookup} from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'

import {HttpError, sha256} from './util.js'

export type SanitizedImage = {
	data: Buffer
	mime: 'image/png' | 'image/jpeg' | 'image/webp'
	extension: 'png' | 'jpg' | 'webp'
	width: number
	height: number
	sha256: string
}

const MAX_AVATAR_BYTES = 4 * 1024 * 1024
const MAX_DIMENSION = 2048
const MAX_PIXELS = 4_194_304
const FETCH_TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 3

/* -------------------------------------------------------------------------- */
/* CRC-32 (PNG)                                                               */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
	const table = new Uint32Array(256)
	for (let index = 0; index < 256; index++) {
		let value = index
		for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
		table[index] = value >>> 0
	}
	return table
})()

function crc32(buffer: Buffer): number {
	let crc = 0xffffffff
	for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
	return (crc ^ 0xffffffff) >>> 0
}

/* -------------------------------------------------------------------------- */
/* Image parsers                                                              */
/* -------------------------------------------------------------------------- */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'IDAT', 'IEND'])

function sanitizePng(input: Buffer): SanitizedImage {
	if (input.length < 33 || !input.subarray(0, 8).equals(PNG_SIGNATURE)) throw new HttpError(400, 'Not a PNG image')
	let offset = 8
	let width = 0
	let height = 0
	let sawIhdr = false
	let sawIdat = false
	let sawIend = false
	const chunks: Buffer[] = []

	while (offset + 12 <= input.length) {
		const length = input.readUInt32BE(offset)
		const type = input.toString('ascii', offset + 4, offset + 8)
		if (length > 16 * 1024 * 1024 || offset + 12 + length > input.length) throw new HttpError(400, 'Invalid PNG chunk')
		const data = input.subarray(offset + 8, offset + 8 + length)
		const expectedCrc = input.readUInt32BE(offset + 8 + length)
		if (crc32(input.subarray(offset + 4, offset + 8 + length)) !== expectedCrc) {
			throw new HttpError(400, 'PNG chunk checksum mismatch')
		}
		offset += 12 + length

		if (!sawIhdr && type !== 'IHDR') throw new HttpError(400, 'PNG must start with IHDR')
		if (type === 'IHDR') {
			if (sawIhdr || length !== 13) throw new HttpError(400, 'Invalid PNG header')
			sawIhdr = true
			width = data.readUInt32BE(0)
			height = data.readUInt32BE(4)
			const bitDepth = data[8]
			const colorType = data[9]
			if (![1, 2, 4, 8, 16].includes(bitDepth)) throw new HttpError(400, 'Unsupported PNG bit depth')
			if (![0, 2, 3, 4, 6].includes(colorType)) throw new HttpError(400, 'Unsupported PNG color type')
			if (data[10] !== 0 || data[11] !== 0 || data[12] > 1) throw new HttpError(400, 'Unsupported PNG encoding')
		}
		// Animated PNG is rejected: an avatar must be a still image, and APNG
		// frames are a decompression-bomb vector that dimensions alone miss.
		if (type === 'acTL') throw new HttpError(400, 'Animated PNG avatars are not supported')
		if (type === 'IDAT') sawIdat = true
		if (type === 'IEND') sawIend = true
		if (PNG_KEEP.has(type)) {
			const chunk = Buffer.alloc(12 + length)
			chunk.writeUInt32BE(length, 0)
			chunk.write(type, 4, 'ascii')
			data.copy(chunk, 8)
			chunk.writeUInt32BE(expectedCrc, 8 + length)
			chunks.push(chunk)
		}
	}

	if (!sawIhdr || !sawIdat || !sawIend) throw new HttpError(400, 'Incomplete PNG image')
	validateDimensions(width, height)
	return {
		data: Buffer.concat([PNG_SIGNATURE, ...chunks]),
		mime: 'image/png',
		extension: 'png',
		width,
		height,
		sha256: '',
	}
}

function sanitizeJpeg(input: Buffer): SanitizedImage {
	if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) throw new HttpError(400, 'Not a JPEG image')
	let offset = 2
	let width = 0
	let height = 0
	const segments: Buffer[] = [Buffer.from([0xff, 0xd8])]
	let sawSof = false

	while (offset + 4 <= input.length) {
		if (input[offset] !== 0xff) throw new HttpError(400, 'Invalid JPEG marker')
		let marker = input[offset + 1]
		while (marker === 0xff && offset + 2 < input.length) {
			offset++
			marker = input[offset + 1]
		}
		offset += 2
		if (marker === 0xd9) break
		if (marker === 0xda) {
			// Everything from the first scan to the first EOI after it is
			// entropy-coded data and later scan headers. Copy it verbatim: it
			// holds no metadata, and parsing progressive scans would risk
			// corrupting the image.
			const eoi = input.indexOf(Buffer.from([0xff, 0xd9]), offset)
			if (eoi <= offset) throw new HttpError(400, 'Incomplete JPEG image')
			segments.push(input.subarray(offset - 2, eoi + 2))
			if (!sawSof) throw new HttpError(400, 'JPEG is missing its frame header')
			validateDimensions(width, height)
			return {
				data: Buffer.concat(segments),
				mime: 'image/jpeg',
				extension: 'jpg',
				width,
				height,
				sha256: '',
			}
		}
		if (marker >= 0xd0 && marker <= 0xd7) continue
		if (offset + 2 > input.length) throw new HttpError(400, 'Incomplete JPEG segment')
		const length = input.readUInt16BE(offset)
		if (length < 2 || offset + length > input.length) throw new HttpError(400, 'Invalid JPEG segment')
		const payload = input.subarray(offset + 2, offset + length)

		if ([0xc0, 0xc1, 0xc2].includes(marker)) {
			if (payload.length < 6) throw new HttpError(400, 'Invalid JPEG frame header')
			sawSof = true
			height = payload.readUInt16BE(1)
			width = payload.readUInt16BE(3)
			segments.push(input.subarray(offset - 2, offset + length))
		} else if ([0xe0, 0xee, 0xdb, 0xc4, 0xdd].includes(marker)) {
			// JFIF/Adobe application markers carry no EXIF or XMP; DQT/DHT/DRI
			// are required for decoding.
			if (marker === 0xe0 && !payload.subarray(0, 5).equals(Buffer.from('JFIF\0'))) {
				// A non-JFIF APP0 is metadata.
			} else {
				segments.push(input.subarray(offset - 2, offset + length))
			}
		} else if ([0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
			throw new HttpError(400, 'Unsupported JPEG encoding')
		}
		// APP1 (EXIF/XMP), APP2 (ICC), APP13 (IPTC), COM and everything else are
		// deliberately dropped.
		offset += length
	}

	throw new HttpError(400, 'JPEG has no image data')
}

function sanitizeWebp(input: Buffer): SanitizedImage {
	if (input.length < 30 || input.toString('ascii', 0, 4) !== 'RIFF' || input.toString('ascii', 8, 12) !== 'WEBP') {
		throw new HttpError(400, 'Not a WebP image')
	}
	const declaredSize = input.readUInt32LE(4)
	if (declaredSize + 8 > input.length) throw new HttpError(400, 'Truncated WebP image')
	if (declaredSize + 8 < input.length) throw new HttpError(400, 'Trailing data in WebP image')

	let offset = 12
	let width = 0
	let height = 0
	let animated = false
	const kept: Buffer[] = []

	while (offset + 8 <= input.length) {
		const fourcc = input.toString('ascii', offset, offset + 4)
		const size = input.readUInt32LE(offset + 4)
		if (offset + 8 + size > input.length) throw new HttpError(400, 'Invalid WebP chunk')
		const payload = input.subarray(offset + 8, offset + 8 + size)

		if (fourcc === 'VP8X') {
			if (size < 10) throw new HttpError(400, 'Invalid WebP header')
			animated = Boolean(payload[0] & 0x02)
			width = 1 + payload.readUIntLE(4, 3)
			height = 1 + payload.readUIntLE(7, 3)
			kept.push(webpChunk(fourcc, payload))
		} else if (fourcc === 'VP8 ') {
			if (size < 10) throw new HttpError(400, 'Invalid WebP frame')
			width = payload.readUInt16LE(6) & 0x3fff
			height = payload.readUInt16LE(8) & 0x3fff
			kept.push(webpChunk(fourcc, payload))
		} else if (fourcc === 'VP8L') {
			if (size < 5 || payload[0] !== 0x2f) throw new HttpError(400, 'Invalid WebP lossless frame')
			const bits = payload.readUInt32LE(1)
			width = (bits & 0x3fff) + 1
			height = ((bits >>> 14) & 0x3fff) + 1
			kept.push(webpChunk(fourcc, payload))
		} else if (fourcc === 'ALPH') {
			kept.push(webpChunk(fourcc, payload))
		} else if (fourcc === 'ICCP' || fourcc === 'EXIF' || fourcc === 'XMP ') {
			// Metadata (and a profile that can carry arbitrary data): dropped.
		} else if (fourcc === 'ANIM' || fourcc === 'ANMF') {
			// Animated WebP is rejected below.
		}
		// Unknown chunks are dropped rather than round-tripped.

		offset += 8 + size + (size % 2)
	}

	if (animated) throw new HttpError(400, 'Animated WebP avatars are not supported')
	if (!kept.length || !width || !height) throw new HttpError(400, 'WebP has no still image frame')
	validateDimensions(width, height)
	const payload = Buffer.concat(kept)
	const header = Buffer.alloc(12)
	header.write('RIFF', 0, 'ascii')
	header.writeUInt32LE(payload.length + 4, 4)
	header.write('WEBP', 8, 'ascii')
	return {
		data: Buffer.concat([header, payload]),
		mime: 'image/webp',
		extension: 'webp',
		width,
		height,
		sha256: '',
	}
}

function webpChunk(fourcc: string, payload: Buffer): Buffer {
	const header = Buffer.alloc(8)
	header.write(fourcc, 0, 'ascii')
	header.writeUInt32LE(payload.length, 4)
	return Buffer.concat([header, payload, payload.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)])
}

function validateDimensions(width: number, height: number) {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
		throw new HttpError(400, 'Invalid image dimensions')
	}
	if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
		throw new HttpError(400, `Image exceeds ${MAX_DIMENSION}px or ${MAX_PIXELS} pixels`)
	}
}

export function sanitizeImage(input: Buffer): SanitizedImage {
	let image: SanitizedImage
	if (input.subarray(0, 8).equals(PNG_SIGNATURE)) image = sanitizePng(input)
	else if (input[0] === 0xff && input[1] === 0xd8) image = sanitizeJpeg(input)
	else if (input.toString('ascii', 0, 4) === 'RIFF' && input.toString('ascii', 8, 12) === 'WEBP') {
		image = sanitizeWebp(input)
	} else throw new HttpError(415, 'Avatar must be a PNG, JPEG, or WebP image')
	image.sha256 = sha256(image.data)
	return image
}

/* -------------------------------------------------------------------------- */
/* SSRF-safe fetch                                                            */
/* -------------------------------------------------------------------------- */

function isPrivateIpv4(address: string): boolean {
	const octets = address.split('.').map(Number)
	if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true
	const [a, b] = octets
	if (a === 0 || a === 10 || a === 127) return true
	if (a === 169 && b === 254) return true
	if (a === 172 && b >= 16 && b <= 31) return true
	if (a === 192 && b === 168) return true
	if (a === 100 && b >= 64 && b <= 127) return true
	if (a === 192 && b === 0) return true
	if (a === 198 && (b === 18 || b === 19)) return true
	if (a === 198 && b === 51) return true
	if (a === 203 && b === 0) return true
	if (a >= 224) return true
	return false
}

function isPrivateAddress(address: string): boolean {
	if (net.isIPv4(address)) return isPrivateIpv4(address)
	if (!net.isIPv6(address)) return true
	const normalized = address.toLowerCase()
	if (normalized === '::' || normalized === '::1') return true
	if (normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true
	if (normalized.startsWith('ff')) return true
	if (normalized.startsWith('2001:db8:')) return true
	const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
	if (mapped) return isPrivateIpv4(mapped[1])
	return false
}

const BLOCKED_HOSTNAMES = new Set([
	'localhost',
	'metadata.google.internal',
	'metadata.goog',
	'instance-data',
	'kubernetes.default.svc',
])

async function resolvePublicAddress(hostname: string): Promise<{address: string; family: number}> {
	if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase()) || hostname.toLowerCase().endsWith('.local')) {
		throw new HttpError(400, 'Avatar URL points to a private host')
	}
	if (net.isIP(hostname)) {
		if (isPrivateAddress(hostname)) throw new HttpError(400, 'Avatar URL points to a private address')
		return {address: hostname, family: net.isIPv6(hostname) ? 6 : 4}
	}
	let addresses: {address: string; family: number}[]
	try {
		addresses = await lookup(hostname, {all: true, verbatim: true})
	} catch {
		throw new HttpError(400, 'Avatar host could not be resolved')
	}
	if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
		throw new HttpError(400, 'Avatar host resolves to a private address')
	}
	return addresses[0]
}

type FetchResult = {status: number; headers: http.IncomingHttpHeaders; body: Buffer}

function requestOnce(url: URL, address: {address: string; family: number}): Promise<FetchResult> {
	return new Promise((resolve, reject) => {
		let settled = false
		const finish = (error: unknown, result?: FetchResult) => {
			if (settled) return
			settled = true
			if (error) reject(error)
			else resolve(result!)
		}
		const transport = url.protocol === 'https:' ? https : http
		const request = transport.request(
			{
				protocol: url.protocol,
				hostname: url.hostname,
				port: url.port || (url.protocol === 'https:' ? 443 : 80),
				path: `${url.pathname}${url.search}`,
				method: 'GET',
				headers: {
					'user-agent': 'umbrelOS-Umbra-Avatar/1.0',
					accept: 'image/png,image/jpeg,image/webp;q=0.9',
					'accept-encoding': 'identity',
				},
				// Pin the address we validated. A DNS answer that changes between
				// validation and connection cannot redirect the request inwards.
				lookup: (_hostname, _options, callback) => {
					callback(null, address.address, address.family)
				},
				servername: net.isIP(url.hostname) ? undefined : url.hostname,
				timeout: FETCH_TIMEOUT_MS,
				rejectUnauthorized: true,
			},
			(response) => {
				const status = response.statusCode ?? 0
				if ([301, 302, 303, 307, 308].includes(status)) {
					response.resume()
					finish(null, {status, headers: response.headers, body: Buffer.alloc(0)})
					return
				}
				if (status !== 200) {
					response.resume()
					finish(new HttpError(400, `Avatar server returned HTTP ${status}`))
					return
				}
				const declared = Number(response.headers['content-length'] ?? 0)
				if (declared > MAX_AVATAR_BYTES) {
					response.resume()
					finish(new HttpError(413, 'Avatar image is too large'))
					return
				}
				const chunks: Buffer[] = []
				let total = 0
				response.on('data', (chunk: Buffer) => {
					total += chunk.length
					if (total > MAX_AVATAR_BYTES) {
						request.destroy()
						finish(new HttpError(413, 'Avatar image is too large'))
						return
					}
					chunks.push(chunk)
				})
				response.on('end', () => finish(null, {status, headers: response.headers, body: Buffer.concat(chunks)}))
				response.on('error', (error) => finish(error))
			},
		)
		request.on('timeout', () => request.destroy(new HttpError(408, 'Avatar fetch timed out')))
		request.on('error', (error) => finish(error))
		request.end()
	})
}

async function validateAndFetch(url: URL, redirectsLeft: number): Promise<FetchResult> {
	if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HttpError(400, 'Avatar URL must be HTTP(S)')
	if (url.username || url.password) throw new HttpError(400, 'Avatar URL must not contain credentials')
	if (url.protocol === 'http:' && process.env.UMBRA_ALLOW_HTTP_AVATARS !== '1') {
		throw new HttpError(400, 'Avatar URL must use HTTPS')
	}
	const address = await resolvePublicAddress(url.hostname)
	const result = await requestOnce(url, address)
	const location = result.headers.location
	if ([301, 302, 303, 307, 308].includes(result.status) && location) {
		if (redirectsLeft <= 0) throw new HttpError(400, 'Too many avatar redirects')
		let next: URL
		try {
			next = new URL(location, url)
		} catch {
			throw new HttpError(400, 'Invalid avatar redirect')
		}
		return validateAndFetch(next, redirectsLeft - 1)
	}
	return result
}

/**
 * Fetch a remote avatar and return a metadata-stripped, validated still image.
 * Enforces HTTPS, public addresses only, bounded redirects/size/time, and
 * re-writes container-level metadata so EXIF/XMP/ICC payloads never reach disk.
 */
export async function fetchAndSanitizeAvatar(rawUrl: string): Promise<SanitizedImage> {
	let url: URL
	try {
		url = new URL(rawUrl)
	} catch {
		throw new HttpError(400, 'Invalid avatar URL')
	}
	const response = await validateAndFetch(url, MAX_REDIRECTS)
	if (!response.body.length) throw new HttpError(400, 'Avatar image is empty')
	const contentType = String(response.headers['content-type'] ?? '')
		.split(';')[0]
		.trim()
		.toLowerCase()
	if (
		contentType &&
		!['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'application/octet-stream'].includes(contentType)
	) {
		throw new HttpError(415, 'Avatar URL did not return an image')
	}
	return sanitizeImage(response.body)
}
