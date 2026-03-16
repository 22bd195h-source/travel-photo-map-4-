/**
 * photo.js — 画像処理
 * - EXIF から撮影日時のみ取得（GPS 不要）
 * - 長辺800px・WebP quality:0.85 にリサイズ圧縮
 */

'use strict';

const LONG_SIDE  = 800;
const WEBP_QUAL  = 0.85;

/**
 * File から撮影日時を取得（EXIF DateTimeOriginal）
 * EXIF がなければ null を返す
 * @param {File} file
 * @returns {Promise<number|null>} timestamp or null
 */
async function getExifTakenAt(file) {
  try {
    const buf  = await file.slice(0, 128 * 1024).arrayBuffer(); // 最初の128KBのみ
    const view = new DataView(buf);

    // JPEG チェック
    if (view.getUint16(0) !== 0xFFD8) return null;

    let offset = 2;

    while (offset < view.byteLength - 4) {
      const marker = view.getUint16(offset);
      offset += 2;

      if (marker === 0xFFE1) {
        // APP1 (EXIF)
        const segLen  = view.getUint16(offset);
        const exifStr = String.fromCharCode(...new Uint8Array(buf, offset + 2, 6));

        if (exifStr.startsWith('Exif')) {
          const exifOffset = offset + 8; // "Exif\0\0" の後
          const ts = parseExifDateTimeOriginal(buf, exifOffset, view.getUint16(exifOffset) === 0x4949);
          if (ts) return ts;
        }

        offset += segLen;
      } else if ((marker & 0xFF00) === 0xFF00) {
        offset += view.getUint16(offset);
      } else {
        break;
      }
    }
  } catch (_) { /* EXIF 解析失敗 → null */ }

  return null;
}

/**
 * EXIF バイナリから DateTimeOriginal を探す
 * @param {ArrayBuffer} buf
 * @param {number} tiffStart  TIFF ヘッダの開始オフセット
 * @param {boolean} isLE      リトルエンディアン
 * @returns {number|null}
 */
function parseExifDateTimeOriginal(buf, tiffStart, isLE) {
  const view = new DataView(buf);
  const read16 = o => isLE ? view.getUint16(tiffStart + o, true) : view.getUint16(tiffStart + o);
  const read32 = o => isLE ? view.getUint32(tiffStart + o, true) : view.getUint32(tiffStart + o);

  try {
    const ifd0Offset = read32(4);
    const ifd0Count  = read16(ifd0Offset);

    // ExifIFD ポインタを探す
    let exifIFDOffset = null;
    for (let i = 0; i < ifd0Count; i++) {
      const entryOffset = ifd0Offset + 2 + i * 12;
      const tag = read16(entryOffset);
      if (tag === 0x8769) { // ExifIFD
        exifIFDOffset = read32(entryOffset + 8);
        break;
      }
    }

    // ExifIFD から DateTimeOriginal (0x9003) を探す
    const searchIFD = (ifdOffset) => {
      if (ifdOffset == null || ifdOffset + 2 > buf.byteLength) return null;
      const count = read16(ifdOffset);
      for (let i = 0; i < count; i++) {
        const eo = ifdOffset + 2 + i * 12;
        if (eo + 12 > buf.byteLength) break;
        const tag = read16(eo);
        if (tag === 0x9003 || tag === 0x0132) { // DateTimeOriginal or DateTime
          const valOffset = read32(eo + 8);
          const dtStr = readAscii(buf, tiffStart + valOffset, 19);
          return exifDateToTs(dtStr);
        }
      }
      return null;
    };

    return searchIFD(exifIFDOffset) || searchIFD(ifd0Offset);
  } catch (_) {
    return null;
  }
}

function readAscii(buf, offset, len) {
  const bytes = new Uint8Array(buf, offset, Math.min(len, buf.byteLength - offset));
  return String.fromCharCode(...bytes);
}

/** "2026:03:10 14:32:00" → timestamp */
function exifDateToTs(str) {
  // "YYYY:MM:DD HH:MM:SS"
  const m = str.match(/^(\d{4}):(\d{2}):(\d{2})\s(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const ts = new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
  return isNaN(ts) ? null : ts;
}

/**
 * File を長辺800px・WebP quality:0.85 に圧縮して Blob を返す
 * @param {File} file
 * @returns {Promise<Blob>}
 */
async function resizeToWebP(file) {
  const bitmap = await createImageBitmap(file);
  const { width: sw, height: sh } = bitmap;

  let dw = sw, dh = sh;
  if (sw > sh) {
    if (sw > LONG_SIDE) { dw = LONG_SIDE; dh = Math.round(sh * LONG_SIDE / sw); }
  } else {
    if (sh > LONG_SIDE) { dh = LONG_SIDE; dw = Math.round(sw * LONG_SIDE / sh); }
  }

  const canvas = new OffscreenCanvas(dw, dh);
  const ctx    = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, dw, dh);
  bitmap.close();

  return canvas.convertToBlob({ type: 'image/webp', quality: WEBP_QUAL });
}

/**
 * Blob → Object URL（img.src 用）
 * @param {Blob} blob
 * @returns {string}
 */
function blobToObjectURL(blob) {
  return URL.createObjectURL(blob);
}

/**
 * File → { blob: Blob, takenAt: number, previewURL: string }
 * UI の写真選択直後に呼ぶ
 * @param {File} file
 * @returns {Promise<{ blob: Blob, takenAt: number, previewURL: string }>}
 */
async function processPhotoFile(file) {
  const [blob, takenAt] = await Promise.all([
    resizeToWebP(file),
    getExifTakenAt(file),
  ]);

  const previewURL = blobToObjectURL(blob);

  return {
    blob,
    takenAt   : takenAt || Date.now(),
    previewURL,
  };
}
