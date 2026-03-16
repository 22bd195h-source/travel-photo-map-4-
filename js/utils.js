/**
 * utils.js — ユーティリティ関数
 * BBox計算・面積計算・日付フォーマット・リージョングループ化
 */

'use strict';

/**
 * GeoJSON Feature を polygonUnit の配列に展開する
 * @param {GeoJSON.Feature} feature
 * @returns {PolygonUnit[]}
 */
function expandToUnits(feature) {
  const p    = feature.properties || {};
  const code = String(p.code || p.N03_007 || '');

  let name = p.name;
  if (!name) {
    const city = p.N03_003 || '';
    const ward = p.N03_004 || '';
    name = ward ? (city ? city + ward : ward) : (city || p.N03_001 || '不明');
  }
  const geo  = feature.geometry;
  const units = [];

  if (!geo) return units;

  if (geo.type === 'Polygon') {
    units.push({
      polygonKey       : `${code}_0`,
      municipalityCode : code,
      municipalityName : name,
      polygonIndex     : 0,
      rings            : geo.coordinates,
    });
  } else if (geo.type === 'MultiPolygon') {
    geo.coordinates.forEach((rings, i) => {
      units.push({
        polygonKey       : `${code}_${i}`,
        municipalityCode : code,
        municipalityName : name,
        polygonIndex     : i,
        rings            : rings,
      });
    });
  }

  return units;
}

/**
 * regions.json + TopoJSON units → regionKey ごとにグループ化
 * @param {PolygonUnit[]} allMuniUnits - expandToUnits() で展開済みの全ユニット
 * @param {Object} regionsData - regions.json のパース結果
 * @returns {{ regionGroups: Map, allRegionUnits: PolygonUnit[], regionMeta: Map }}
 */
function buildRegionUnits(allMuniUnits, regionsData) {
  // municipalityCode → regionKey ルックアップ
  const muniToRegion = new Map();
  const regionMeta   = new Map();

  for (const [prefCode, prefData] of Object.entries(regionsData.prefectures)) {
    for (const region of prefData.regions) {
      regionMeta.set(region.key, {
        name     : region.name,
        prefCode,
        prefName : prefData.name,
      });
      for (const muniCode of region.municipalities) {
        muniToRegion.set(muniCode, {
          regionKey  : region.key,
          regionName : region.name,
        });
      }
    }
  }

  // allMuniUnits を regionKey でグループ化
  const regionGroups = new Map();

  for (const unit of allMuniUnits) {
    const mapping = muniToRegion.get(unit.municipalityCode);
    if (!mapping) {
      console.warn(`Municipality ${unit.municipalityCode} (${unit.municipalityName}) not in any region`);
      continue;
    }
    unit.regionKey  = mapping.regionKey;
    unit.regionName = mapping.regionName;

    if (!regionGroups.has(mapping.regionKey)) {
      regionGroups.set(mapping.regionKey, []);
    }
    regionGroups.get(mapping.regionKey).push(unit);
  }

  return { regionGroups, allRegionUnits: allMuniUnits, regionMeta };
}

// =====================
//  日付ユーティリティ
// =====================

function tsToDateStr(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function tsToJaDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function datetimeLocalToTs(str) {
  return new Date(str).getTime();
}

function tsToDatetimeLocal(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// =====================
//  フォーマット
// =====================

function fmtNum(n) {
  return n.toLocaleString('ja-JP');
}

function fmtPct(count, total) {
  if (total === 0) return '0.0%';
  return (count / total * 100).toFixed(1) + '%';
}
