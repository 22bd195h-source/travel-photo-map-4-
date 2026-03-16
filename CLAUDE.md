# 旅先エリアマップ — CLAUDE.md

## プロジェクト概要

旅した場所を写真で日本エリアマップが埋まっていく PWA。
47都道府県を2〜5の観光エリアに分割（計129エリア）。
写真を登録するとそのエリアの全ポリゴンに写真がクリップされて表示される。

元プロジェクト travel-photo-map（市区町村単位）のフォーク。

## 技術スタック

- **フロントエンド**: Vanilla JavaScript
- **地図エンジン**: MapLibre GL JS v4.x
- **写真テクスチャ**: Canvas 2D API（ctx.clip() + drawImage()）
- **地図データ**: niiyz/JapanCityGeoJson（TopoJSON形式）+ regions.json
- **永続化**: IndexedDB（TravelPhotoMapRegionDB）

## ファイル構成

```
/
├── index.html
├── styles.css
├── manifest.json
├── service-worker.js
├── CLAUDE.md
├── /js
│   ├── map.js      地図初期化・drawMap()・updateCounter()
│   ├── storage.js  IndexedDB 操作・photoCache 管理
│   ├── photo.js    画像リサイズ・EXIF 日時取得・WebP 変換
│   ├── ui.js       テキスト検索 UI・写真登録ダイアログ・旅パネル
│   └── utils.js    expandToUnits()・buildRegionUnits()・日付フォーマット
└── /data
    ├── japan.topojson  市区町村ポリゴンデータ
    └── regions.json    エリア定義（47都道府県 × 2〜5エリア）
```

## regions.json 構造

- key: `{prefCode}_{連番}` — 例: `"20_01"`, `"20_02"`
- name: 表示用エリア名
- municipalities: N03_007 コードの配列

## 禁止事項

- React / Vue / Svelte 等のフレームワーク導入禁止
- アニメーション追加禁止
- GPS・逆ジオコーディング API 使用禁止
- EXIF から GPS 座標取得禁止（撮影日時のみ）
- `map.on('render')` での毎フレーム描画禁止

## キー形式

```
regionKey = "{prefCode}_{連番}"
例: "20_01" = 松本・安曇野エリア、"01_05" = 道東・オホーツク・宗谷エリア
```

## 描画パイプライン

- Mercator 座標（0〜1）をロード時に事前計算（u._mRings）
- ctx.setTransform() でビューポート変換（map.project() は不使用）
- coverRect は Mercator 座標のリージョン統合 BBox で計算（ズーム非依存）
