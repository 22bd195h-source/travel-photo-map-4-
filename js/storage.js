/**
 * storage.js — IndexedDB 操作
 * DB: TravelPhotoMapRegionDB v1
 * stores: trips / photos / visited
 *
 * 元プロジェクトとの違い:
 *   polygonKey → regionKey に全面置換
 *   municipalityCode → prefCode（インデックス）
 */

'use strict';

const DB_NAME    = 'TravelPhotoMapRegionDB';
const DB_VERSION = 1;

let _db = null;

/** DB を開く（初回のみ作成・以降はキャッシュ） */
function openDB() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = e => {
      const db = e.target.result;

      // trips
      if (!db.objectStoreNames.contains('trips')) {
        db.createObjectStore('trips', { keyPath: 'id', autoIncrement: true });
      }

      // photos — regionKey でインデックス
      if (!db.objectStoreNames.contains('photos')) {
        const photosStore = db.createObjectStore('photos', { keyPath: 'id', autoIncrement: true });
        photosStore.createIndex('regionKey', 'regionKey', { unique: false });
        photosStore.createIndex('tripId',    'tripId',    { unique: false });
      }

      // visited — regionKey が主キー
      if (!db.objectStoreNames.contains('visited')) {
        const visitedStore = db.createObjectStore('visited', { keyPath: 'regionKey' });
        visitedStore.createIndex('prefCode', 'prefCode', { unique: false });
      }
    };

    req.onsuccess = e => {
      _db = e.target.result;
      resolve(_db);
    };

    req.onerror = () => reject(req.error);
  });
}

/** 汎用トランザクション実行ヘルパー */
function tx(storeNames, mode, fn) {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeNames, mode);
      t.onerror = () => reject(t.error);
      resolve(fn(t));
    });
  });
}

/** IDBRequest → Promise */
function reqPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// =====================
//  trips
// =====================

async function addTrip({ title, dateFrom, dateTo, memo }) {
  return tx(['trips'], 'readwrite', t => {
    const store = t.objectStore('trips');
    return reqPromise(store.add({
      title,
      dateFrom,
      dateTo,
      memo        : memo || '',
      createdAt   : Date.now(),
    }));
  });
}

async function getAllTrips() {
  return tx(['trips'], 'readonly', t => {
    return reqPromise(t.objectStore('trips').getAll());
  }).then(trips => trips.sort((a, b) => b.createdAt - a.createdAt));
}

async function getTripById(id) {
  return tx(['trips'], 'readonly', t => {
    return reqPromise(t.objectStore('trips').get(id));
  });
}

// =====================
//  photos
// =====================

/**
 * 写真を追加
 * @param {{ regionKey, regionName, tripId, blob, caption, takenAt }} data
 * @returns {Promise<number>} 新レコードのID
 */
async function addPhoto({ regionKey, regionName, tripId, blob, caption, takenAt }) {
  return tx(['photos'], 'readwrite', t => {
    return reqPromise(t.objectStore('photos').add({
      regionKey,
      regionName,
      tripId       : tripId || null,
      blob,
      caption      : caption || '',
      takenAt      : takenAt || Date.now(),
      registeredAt : Date.now(),
    }));
  });
}

/** regionKey で写真一覧取得 */
async function getPhotosByRegion(regionKey) {
  return tx(['photos'], 'readonly', t => {
    const idx = t.objectStore('photos').index('regionKey');
    return reqPromise(idx.getAll(regionKey));
  });
}

/** tripId で写真一覧取得 */
async function getPhotosByTrip(tripId) {
  return tx(['photos'], 'readonly', t => {
    const idx = t.objectStore('photos').index('tripId');
    return reqPromise(idx.getAll(tripId));
  });
}

/** ID で写真を取得 */
async function getPhotoById(id) {
  return tx(['photos'], 'readonly', t => {
    return reqPromise(t.objectStore('photos').get(id));
  });
}

// =====================
//  visited
// =====================

/**
 * 訪問済みを登録または更新（coverPhotoId を更新）
 * @param {{ regionKey, regionName, prefCode, tripId, coverPhotoId }} data
 */
async function upsertVisited({ regionKey, regionName, prefCode, tripId, coverPhotoId }) {
  return tx(['visited'], 'readwrite', async t => {
    const store    = t.objectStore('visited');
    const existing = await reqPromise(store.get(regionKey));

    if (existing) {
      existing.coverPhotoId = coverPhotoId;
      return reqPromise(store.put(existing));
    } else {
      return reqPromise(store.add({
        regionKey,
        regionName,
        prefCode,
        tripId           : tripId || null,
        coverPhotoId,
        firstVisitedAt   : Date.now(),
      }));
    }
  });
}

/** 全訪問済みを取得 */
async function getAllVisited() {
  return tx(['visited'], 'readonly', t => {
    return reqPromise(t.objectStore('visited').getAll());
  });
}

/** regionKey で訪問済みを取得 */
async function getVisitedByKey(regionKey) {
  return tx(['visited'], 'readonly', t => {
    return reqPromise(t.objectStore('visited').get(regionKey));
  });
}

/** tripId に紐づく訪問済みを取得 */
async function getVisitedByTrip(tripId) {
  const all = await getAllVisited();
  return all.filter(v => v.tripId === tripId);
}

// =====================
//  photoCache（メモリ）
// =====================

/** regionKey → HTMLImageElement */
const photoCache = new Map();

/**
 * 全訪問済みの coverPhoto を photoCache に読み込む
 * 起動時に一度だけ呼ぶ
 */
async function buildPhotoCache() {
  const visited = await getAllVisited();

  await Promise.all(visited.map(async v => {
    if (!v.coverPhotoId) return;
    try {
      const photo = await getPhotoById(v.coverPhotoId);
      if (!photo || !photo.blob) return;

      const url = URL.createObjectURL(photo.blob);
      const img = new Image();
      img.src = url;
      await img.decode();
      photoCache.set(v.regionKey, img);
    } catch (err) {
      console.warn(`photoCache build failed: ${v.regionKey}`, err);
    }
  }));
}

/**
 * 1件の写真を photoCache に追加
 * @param {string} regionKey
 * @param {Blob} blob
 */
async function addToPhotoCache(regionKey, blob) {
  const old = photoCache.get(regionKey);
  if (old && old._objectURL) URL.revokeObjectURL(old._objectURL);

  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  img._objectURL = url;
  await img.decode();
  photoCache.set(regionKey, img);
}
