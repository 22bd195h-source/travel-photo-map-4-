/**
 * map.js — 地図初期化・drawMap()
 * MapLibre GL JS（タイルなし白地図）+ Canvas 2D フォトオーバーレイ
 *
 * 描画パス構成:
 *  Pass 0  シルエット      全 vpUnits を白塗り
 *  Pass 1  写真            訪問済みリージョンに写真テクスチャ（統合 BBox で連続描画）
 *  Pass 2  市区町村境界    detailUnits の境界線（ズーム小では非表示）
 *  Pass 2.5 エリア境界     リージョン境界線（中太線）
 *  Pass 3  都道府県境界    vpUnits をプレフィックスでグループ化→常に表示
 *
 * パフォーマンス設計:
 *  ・map.project() は一切使用しない
 *  ・ロード時に Web Mercator 座標を u._mRings に永続キャッシュ
 *  ・drawMap() では ctx.setTransform() でビューポート変換行列をキャンバスに渡す
 */

'use strict';

let map      = null;
let allUnits = [];

let _canvas       = null;
let _drawRafId    = null;
let _canvasPxW    = 0;
let _canvasPxH    = 0;

// リージョン関連グローバル
let _regionGroups  = null;  // Map: regionKey → unit[]
let _regionMeta    = null;  // Map: regionKey → { name, prefCode, prefName }
let _muniNameIndex = null;  // Map: municipalityCode → { muniName, regionKey, regionName, prefName }
let _totalRegions  = 0;

// =====================
//  MapLibre 初期化
// =====================

async function initMap() {
  _canvas = document.getElementById('photo-overlay');

  map = new maplibregl.Map({
    container : 'map',
    style: {
      version : 8,
      sources : {},
      layers  : [{ id: 'bg', type: 'background', paint: { 'background-color': '#dce9f5' } }],
    },
    bounds : [[122.5, 24.0], [145.8, 45.5]],
    fitBoundsOptions: {
      padding: { top: 70, bottom: 110, left: 20, right: 60 },
    },
    minZoom : 4,
    maxZoom : 16,
  });

  await loadGeoData();

  map.on('load', drawMap);
  map.on('move', scheduleDraw);

  document.getElementById('loading').classList.add('hidden');
}

// =====================
//  rAF スロットリング
// =====================

function scheduleDraw() {
  if (_drawRafId !== null) return;
  _drawRafId = requestAnimationFrame(() => {
    _drawRafId = null;
    drawMap();
  });
}

// =====================
//  Mercator 座標変換ヘルパー
// =====================

function lngToMercX(lng) {
  return (lng + 180) / 360;
}

function latToMercY(lat) {
  return (1 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / Math.PI) / 2;
}

// =====================
//  Mercator 空間ヘルパー
// =====================

function buildMercPath(ctx, mRings) {
  for (const ring of mRings) {
    ring.forEach((pt, i) => {
      i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y);
    });
    ctx.closePath();
  }
}

function mercBBox(mRings) {
  let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
  for (const ring of mRings) {
    for (const pt of ring) {
      if (pt.x < mnX) mnX = pt.x; if (pt.x > mxX) mxX = pt.x;
      if (pt.y < mnY) mnY = pt.y; if (pt.y > mxY) mxY = pt.y;
    }
  }
  return { x: mnX, y: mnY, w: mxX - mnX, h: mxY - mnY };
}

function mercArea(ring) {
  const n = ring.length;
  if (n < 3) return 0;
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += ring[j].x * ring[i].y - ring[i].x * ring[j].y;
  }
  return Math.abs(a) * 0.5;
}

// =====================
//  データ読み込み
// =====================

async function loadGeoData() {
  // TopoJSON + regions.json を並列 fetch
  const [topoRes, regionsRes] = await Promise.all([
    fetch('/data/japan.topojson'),
    fetch('/data/regions.json'),
  ]);
  const topoData    = await topoRes.json();
  const regionsData = await regionsRes.json();

  // TopoJSON → GeoJSON
  let geoJSON;
  if (topoData.type === 'Topology' && topoData.objects) {
    const key = Object.keys(topoData.objects)[0];
    geoJSON = topojson.feature(topoData, topoData.objects[key]);
  } else {
    geoJSON = topoData;
  }

  // municipality-level polygon units
  const muniUnits = geoJSON.features.flatMap(expandToUnits);

  // region グループ化
  const { regionGroups, allRegionUnits, regionMeta, muniNameIndex } = buildRegionUnits(muniUnits, regionsData);

  allUnits       = allRegionUnits;
  _regionGroups  = regionGroups;
  _regionMeta    = regionMeta;
  _muniNameIndex = muniNameIndex;
  _totalRegions  = regionsData.totalRegions || regionMeta.size;

  // Mercator 座標を永続キャッシュ
  for (const u of allUnits) {
    u.geoBBox  = geoBBox(u.rings);
    u.prefCode = u.regionKey.substring(0, 2);

    u._mRings = u.rings.map(ring =>
      ring.map(([lng, lat]) => ({ x: lngToMercX(lng), y: latToMercY(lat) }))
    );
    u._mArea = mercArea(u._mRings[0]);
  }

  // リージョン統合 BBox を Mercator 座標で事前計算（ズーム非依存）
  for (const [regionKey, units] of _regionGroups) {
    let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
    for (const u of units) {
      for (const ring of u._mRings) {
        for (const pt of ring) {
          if (pt.x < mnX) mnX = pt.x; if (pt.x > mxX) mxX = pt.x;
          if (pt.y < mnY) mnY = pt.y; if (pt.y > mxY) mxY = pt.y;
        }
      }
    }
    const regionBBox = { x: mnX, y: mnY, w: mxX - mnX, h: mxY - mnY };
    for (const u of units) u._regionMBBox = regionBBox;
  }
}

function geoBBox(rings) {
  let mnLng = Infinity, mnLat = Infinity, mxLng = -Infinity, mxLat = -Infinity;
  for (const ring of rings) for (const [lng, lat] of ring) {
    if (lng < mnLng) mnLng = lng; if (lng > mxLng) mxLng = lng;
    if (lat < mnLat) mnLat = lat; if (lat > mxLat) mxLat = lat;
  }
  return { mnLng, mnLat, mxLng, mxLat };
}

// =====================
//  ビューポートカリング
// =====================

function viewportUnits() {
  const b  = map.getBounds();
  const w  = b.getWest(), e = b.getEast(), s = b.getSouth(), n = b.getNorth();
  const mL = (e - w) * 0.04, mA = (n - s) * 0.04;
  return allUnits.filter(u => {
    const g = u.geoBBox;
    return g.mxLng >= w - mL && g.mnLng <= e + mL &&
           g.mxLat >= s - mA && g.mnLat <= n + mA;
  });
}

// =====================
//  面積閾値
// =====================

function areaThreshold(zoom) {
  if (zoom < 5.5) return 500;
  if (zoom < 6.5) return 250;
  if (zoom < 7.5) return 130;
  if (zoom < 8.5) return 90;
  return 60;
}

// =====================
//  Canvas セットアップ
// =====================

function setupCanvas() {
  const dpr  = window.devicePixelRatio || 1;
  const cssW = map.getCanvas().clientWidth;
  const cssH = map.getCanvas().clientHeight;
  const pxW  = Math.round(cssW * dpr);
  const pxH  = Math.round(cssH * dpr);

  if (pxW !== _canvasPxW || pxH !== _canvasPxH) {
    _canvas.width  = pxW;
    _canvas.height = pxH;
    _canvas.style.width  = cssW + 'px';
    _canvas.style.height = cssH + 'px';
    _canvasPxW = pxW;
    _canvasPxH = pxH;
  }

  const ctx = _canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return { ctx, cssW, cssH, dpr };
}

// =====================
//  drawMap
// =====================

function drawMap() {
  const { ctx, cssW, cssH, dpr } = setupCanvas();
  ctx.clearRect(0, 0, cssW, cssH);

  const zoom      = map.getZoom();
  const center    = map.getCenter();
  const worldSize = 512 * Math.pow(2, zoom);

  const cx = lngToMercX(center.lng);
  const cy = latToMercY(center.lat);
  const tx = cssW / 2 - cx * worldSize;
  const ty = cssH / 2 - cy * worldSize;

  ctx.setTransform(worldSize * dpr, 0, 0, worldSize * dpr, tx * dpr, ty * dpr);

  const vpU    = viewportUnits();
  const thresh = areaThreshold(zoom) / (worldSize * worldSize);
  const detU   = vpU.filter(u => u._mArea > thresh);

  // ——— Pass 0: シルエット ———
  ctx.fillStyle   = 'rgba(255, 255, 255, 0.92)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.lineWidth   = 0.6 / worldSize;
  for (const u of vpU) {
    ctx.beginPath();
    buildMercPath(ctx, u._mRings);
    ctx.fill();
    ctx.stroke();
  }

  // ——— Pass 1: 写真テクスチャ（リージョン単位・統合 BBox） ———
  for (const u of vpU) {
    if (!photoCache.has(u.regionKey)) continue;
    const img  = photoCache.get(u.regionKey);
    const rc   = coverRect(img, u._regionMBBox);  // リージョン統合 BBox
    ctx.save();
    ctx.beginPath();
    buildMercPath(ctx, u._mRings);
    ctx.clip();
    ctx.drawImage(img, rc.dx, rc.dy, rc.dw, rc.dh);
    ctx.restore();
  }

  // ——— Pass 2: 市区町村境界線 ———
  if (detU.length > 0) {
    const alpha = zoom < 6 ? 0.30 : zoom < 8 ? 0.45 : 0.60;
    const lw    = zoom < 6 ? 0.35 : zoom < 8 ? 0.50 : 0.70;
    ctx.strokeStyle = `rgba(120, 120, 120, ${alpha})`;
    ctx.lineWidth   = lw / worldSize;
    ctx.lineJoin    = 'round';
    for (const u of detU) {
      ctx.beginPath();
      buildMercPath(ctx, u._mRings);
      ctx.stroke();
    }
  }

  // ——— Pass 2.5: エリア境界線 ———
  {
    const alpha = zoom < 6 ? 0.45 : zoom < 8 ? 0.40 : 0.35;
    const lw    = zoom < 6 ? 0.8  : zoom < 8 ? 0.7  : 0.9;
    ctx.strokeStyle = `rgba(80, 100, 70, ${alpha})`;
    ctx.lineWidth   = lw / worldSize;
    ctx.lineJoin    = 'round';

    const rg = new Map();
    for (const u of vpU) {
      if (!rg.has(u.regionKey)) rg.set(u.regionKey, []);
      rg.get(u.regionKey).push(u);
    }
    for (const [, units] of rg) {
      ctx.beginPath();
      for (const u of units) buildMercPath(ctx, u._mRings);
      ctx.stroke();
    }
  }

  // ——— Pass 3: 都道府県境界線 ———
  {
    const alpha = zoom < 5.5 ? 0.60 : zoom < 8 ? 0.48 : 0.38;
    const lw    = zoom < 5.5 ? 1.2  : zoom < 8 ? 1.0  : 1.5;
    ctx.strokeStyle = `rgba(60, 75, 95, ${alpha})`;
    ctx.lineWidth   = lw / worldSize;
    ctx.lineJoin    = 'round';

    const pg = new Map();
    for (const u of vpU) {
      if (!pg.has(u.prefCode)) pg.set(u.prefCode, []);
      pg.get(u.prefCode).push(u);
    }
    for (const [, units] of pg) {
      ctx.beginPath();
      for (const u of units) buildMercPath(ctx, u._mRings);
      ctx.stroke();
    }
  }
}

// =====================
//  Cover rect
// =====================

function coverRect(img, bbox) {
  const iAR = img.naturalWidth / img.naturalHeight;
  const bAR = bbox.w / bbox.h;
  let dw, dh, dx, dy;
  if (iAR > bAR) {
    dh = bbox.h; dw = dh * iAR;
    dx = bbox.x - (dw - bbox.w) / 2; dy = bbox.y;
  } else {
    dw = bbox.w; dh = dw / iAR;
    dx = bbox.x; dy = bbox.y - (dh - bbox.h) / 2;
  }
  return { dx, dy, dw, dh };
}

// =====================
//  カウンター更新
// =====================

async function updateCounter() {
  const visited     = await getAllVisited();
  const regionCount = visited.length;

  document.getElementById('counter-region').textContent     = `${fmtNum(regionCount)} / ${fmtNum(_totalRegions)}`;
  document.getElementById('counter-region-pct').textContent = fmtPct(regionCount, _totalRegions);
}

// =====================
//  起動
// =====================

window.addEventListener('DOMContentLoaded', async () => {
  try {
    await buildPhotoCache();
    await initMap();
    await updateCounter();
    initUI();
  } catch (err) {
    console.error('初期化エラー:', err);
    document.querySelector('#loading p').textContent = 'エラーが発生しました。再読み込みしてください。';
  }
});
