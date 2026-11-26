import assert from 'node:assert/strict'
import {describe, it} from 'node:test'
import {deflateSync} from 'node:zlib'

import {sanitizeImage} from '../image.ts'

const crcTable = (() => {
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
	for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
	return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
	const chunk = Buffer.alloc(12 + data.length)
	chunk.writeUInt32BE(data.length, 0)
	chunk.write(type, 4, 'ascii')
	data.copy(chunk, 8)
	chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length)
	return chunk
}

function makePng(extra: Buffer[] = []): Buffer {
	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
	const ihdr = Buffer.alloc(13)
	ihdr.writeUInt32BE(1, 0)
	ihdr.writeUInt32BE(1, 4)
	ihdr[8] = 8 // bit depth
	ihdr[9] = 2 // RGB
	const idat = deflateSync(Buffer.from([0, 255, 0, 0]))
	return Buffer.concat([
		signature,
		pngChunk('IHDR', ihdr),
		...extra,
		pngChunk('IDAT', idat),
		pngChunk('IEND', Buffer.alloc(0)),
	])
}

function jpegMarker(marker: number, payload: Buffer): Buffer {
	const header = Buffer.from([0xff, marker, 0, 0])
	header.writeUInt16BE(payload.length + 2, 2)
	return Buffer.concat([header, payload])
}

function makeJpegWithExif(): Buffer {
	const exif = Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from('secret-gps-data')])
	const sof = Buffer.from([8, 0, 1, 0, 1, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0])
	const dqt = Buffer.alloc(65, 1)
	const sos = Buffer.from([1, 1, 0, 0, 0x3f, 0])
	return Buffer.concat([
		Buffer.from([0xff, 0xd8]),
		jpegMarker(0xe1, exif),
		jpegMarker(0xdb, dqt),
		jpegMarker(0xc0, sof),
		jpegMarker(0xda, sos),
		Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56]),
		Buffer.from([0xff, 0xd9]),
	])
}

function riffChunk(fourcc: string, payload: Buffer): Buffer {
	const header = Buffer.alloc(8)
	header.write(fourcc, 0, 'ascii')
	header.writeUInt32LE(payload.length, 4)
	return Buffer.concat([header, payload, payload.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)])
}

function makeWebpWithExif(): Buffer {
	const vp8x = Buffer.alloc(10)
	vp8x[0] = 0
	vp8x.writeUIntLE(0, 4, 3)
	vp8x.writeUIntLE(0, 7, 3)
	const vp8l = Buffer.from([0x2f, 0, 0, 0, 0])
	const exif = Buffer.from('secret-exif')
	const chunks = Buffer.concat([riffChunk('VP8X', vp8x), riffChunk('EXIF', exif), riffChunk('VP8L', vp8l)])
	const header = Buffer.alloc(12)
	header.write('RIFF', 0, 'ascii')
	header.writeUInt32LE(chunks.length + 4, 4)
	header.write('WEBP', 8, 'ascii')
	return Buffer.concat([header, chunks])
}

describe('avatar image sanitization', () => {
	it('keeps a valid PNG and strips textual metadata', () => {
		const text = pngChunk('tEXt', Buffer.from('Comment\0secret'))
		const result = sanitizeImage(makePng([text]))
		assert.equal(result.mime, 'image/png')
		assert.equal(result.width, 1)
		assert.equal(result.height, 1)
		assert.doesNotMatch(result.data.toString('latin1'), /secret/)
		assert.match(result.sha256, /^[0-9a-f]{64}$/)
	})

	it('rejects animated PNGs', () => {
		const animation = pngChunk('acTL', Buffer.alloc(8))
		assert.throws(() => sanitizeImage(makePng([animation])), /Animated PNG/)
	})

	it('strips EXIF from JPEG while keeping the frame', () => {
		const result = sanitizeImage(makeJpegWithExif())
		assert.equal(result.mime, 'image/jpeg')
		assert.equal(result.width, 1)
		assert.equal(result.height, 1)
		assert.doesNotMatch(result.data.toString('latin1'), /secret-gps-data/)
		assert.equal(result.data[0], 0xff)
		assert.equal(result.data[1], 0xd8)
		assert.deepEqual([...result.data.subarray(-2)], [0xff, 0xd9])
	})

	it('strips EXIF from WebP and rebuilds the RIFF size', () => {
		const result = sanitizeImage(makeWebpWithExif())
		assert.equal(result.mime, 'image/webp')
		assert.doesNotMatch(result.data.toString('latin1'), /secret-exif/)
		assert.equal(result.data.readUInt32LE(4), result.data.length - 8)
	})

	it('rejects SVG, oversized dimensions, and corrupt data', () => {
		assert.throws(() => sanitizeImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), /PNG, JPEG, or WebP/)
		const big = makePng()
		big.writeUInt32BE(100_000, 16) // width inside IHDR
		// Recompute the IHDR CRC so the failure is the dimension check, not the checksum.
		const ihdrCrc = crc32(big.subarray(12, 29))
		big.writeUInt32BE(ihdrCrc, 29)
		assert.throws(() => sanitizeImage(big), /exceeds|dimensions/)
		const corrupt = makePng()
		corrupt[corrupt.length - 1] ^= 0xff
		assert.throws(() => sanitizeImage(corrupt), /checksum|Incomplete/i)
	})
})
