import { readPngSize } from './png.js';

export type MediaMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'video/mp4' | 'video/webm';

/** Detects the media type from magic bytes. Declared MIME types are never trusted on their own. */
export function sniffMime(buf: Buffer): MediaMime | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x1a45dfa3) return 'video/webm';
  return null;
}

export const EXTENSION_BY_MIME: Record<MediaMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

export function kindOfMime(mime: MediaMime): 'image' | 'video' {
  return mime.startsWith('video/') ? 'video' : 'image';
}

/** Pixel dimensions where they can be read without a decoder (PNG). */
export function readDimensions(buf: Buffer, mime: MediaMime): { width: number; height: number } | null {
  return mime === 'image/png' ? readPngSize(buf) : null;
}
