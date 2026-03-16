/**
 * ui.js — UI ロジック
 * エリア検索・写真登録ダイアログ・旅管理パネル
 */

'use strict';

// =====================
//  状態
// =====================

let _selectedFile   = null; // File
let _processedPhoto = null; // { blob, takenAt, previewURL }
let _selectedRegion = null; // { regionKey, regionName }
let _trips          = [];   // Trip[]

// =====================
//  UI 初期化
// =====================

function initUI() {
  setupZoomSlider();
  setupPhotoButton();
  setupDialog();
  setupNewTripDialog();
  setupTripsPanel();
}

// =====================
//  ズームスライダー
// =====================

function setupZoomSlider() {
  const slider   = document.getElementById('zoom-slider');
  const valLabel = document.getElementById('zoom-value');
  const MIN = 4, MAX = 16;

  function syncSlider(zoom) {
    const pct = ((zoom - MIN) / (MAX - MIN) * 100).toFixed(1);
    slider.value = zoom;
    slider.style.setProperty('--zoom-pct', pct + '%');
    valLabel.textContent = zoom.toFixed(1);
  }

  syncSlider(map.getZoom());

  slider.addEventListener('input', e => {
    map.jumpTo({ zoom: parseFloat(e.target.value) });
  });

  map.on('zoom', () => syncSlider(map.getZoom()));
}

// =====================
//  写真追加ボタン
// =====================

function setupPhotoButton() {
  const btn   = document.getElementById('btn-add-photo');
  const input = document.getElementById('file-input');

  btn.addEventListener('click', () => input.click());

  input.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    input.value = '';

    openRegisterDialog(file);
  });
}

// =====================
//  写真登録ダイアログ
// =====================

function setupDialog() {
  document.getElementById('dialog-close').addEventListener('click', closeRegisterDialog);
  document.getElementById('dialog-register').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeRegisterDialog();
  });

  // エリア検索
  document.getElementById('search-muni').addEventListener('input', onSearchInput);

  // エリア変更
  document.getElementById('btn-change-polygon').addEventListener('click', () => {
    _selectedRegion = null;
    document.getElementById('selected-polygon-display').classList.add('hidden');
    document.getElementById('search-muni').value = '';
    document.getElementById('search-results').classList.add('hidden');
    updateRegisterBtn();
  });

  // 登録ボタン
  document.getElementById('btn-register').addEventListener('click', onRegister);

  // 旅の新規作成ボタン
  document.getElementById('btn-new-trip').addEventListener('click', () => {
    document.getElementById('dialog-new-trip').classList.remove('hidden');
  });
}

async function openRegisterDialog(file) {
  _selectedFile   = file;
  _processedPhoto = null;
  _selectedRegion = null;

  document.getElementById('dialog-register').classList.remove('hidden');
  document.getElementById('btn-register').disabled = true;

  const quickURL = URL.createObjectURL(file);
  document.getElementById('photo-preview').src = quickURL;

  // 検索・選択リセット
  document.getElementById('search-muni').value = '';
  document.getElementById('search-results').innerHTML = '';
  document.getElementById('search-results').classList.add('hidden');
  document.getElementById('selected-polygon-display').classList.add('hidden');

  // EXIF + 圧縮
  try {
    _processedPhoto = await processPhotoFile(file);
    document.getElementById('photo-preview').src = _processedPhoto.previewURL;
    URL.revokeObjectURL(quickURL);
    document.getElementById('field-taken-at').value = tsToDatetimeLocal(_processedPhoto.takenAt);
  } catch (err) {
    console.error('写真処理エラー:', err);
    document.getElementById('field-taken-at').value = tsToDatetimeLocal(Date.now());
  }

  await loadTripsToSelect();
}

function closeRegisterDialog() {
  document.getElementById('dialog-register').classList.add('hidden');
  _selectedFile   = null;
  _processedPhoto = null;
  _selectedRegion = null;
}

// =====================
//  テキスト検索（エリア名）
// =====================

function onSearchInput(e) {
  const q = e.target.value.trim();
  const resultsList = document.getElementById('search-results');

  if (q.length < 1) {
    resultsList.innerHTML = '';
    resultsList.classList.add('hidden');
    return;
  }

  // _regionMeta からエリア名・都道府県名で部分一致検索
  const matches = [];
  for (const [regionKey, meta] of _regionMeta) {
    if (meta.name.includes(q) || meta.prefName.includes(q)) {
      matches.push({ regionKey, ...meta });
    }
  }

  renderSearchResults(matches);
}

function renderSearchResults(matches) {
  const resultsList = document.getElementById('search-results');
  resultsList.innerHTML = '';

  if (matches.length === 0) {
    resultsList.classList.add('hidden');
    return;
  }

  for (const match of matches) {
    const li = document.createElement('li');
    li.textContent = `${match.prefName} ${match.name}`;

    li.addEventListener('click', () => {
      resultsList.classList.add('hidden');
      document.getElementById('search-muni').value = `${match.prefName} ${match.name}`;
      selectRegion(match.regionKey, match.name);
    });

    resultsList.appendChild(li);
  }

  resultsList.classList.remove('hidden');
}

// =====================
//  エリア確定
// =====================

function selectRegion(regionKey, regionName) {
  _selectedRegion = { regionKey, regionName };

  const display = document.getElementById('selected-polygon-display');
  const label   = document.getElementById('selected-polygon-label');

  label.textContent = regionName;
  display.classList.remove('hidden');

  updateRegisterBtn();
}

function updateRegisterBtn() {
  const canRegister = _selectedRegion !== null && _processedPhoto !== null;
  document.getElementById('btn-register').disabled = !canRegister;
}

// =====================
//  写真登録
// =====================

async function onRegister() {
  if (!_selectedRegion || !_processedPhoto) return;

  const btn = document.getElementById('btn-register');
  btn.disabled = true;
  btn.textContent = '登録中…';

  try {
    const takenAtVal = document.getElementById('field-taken-at').value;
    const takenAt    = takenAtVal ? datetimeLocalToTs(takenAtVal) : _processedPhoto.takenAt;
    const caption    = document.getElementById('field-caption').value.trim();
    const tripIdStr  = document.getElementById('field-trip').value;
    const tripId     = tripIdStr ? Number(tripIdStr) : null;

    const { regionKey, regionName } = _selectedRegion;
    const prefCode = regionKey.substring(0, 2);

    // photos に保存
    const photoId = await addPhoto({
      regionKey,
      regionName,
      tripId,
      blob    : _processedPhoto.blob,
      caption,
      takenAt,
    });

    // visited に upsert
    await upsertVisited({
      regionKey,
      regionName,
      prefCode,
      tripId,
      coverPhotoId : photoId,
    });

    // photoCache 更新
    await addToPhotoCache(regionKey, _processedPhoto.blob);

    // 地図再描画
    drawMap();

    // カウンター更新
    await updateCounter();

    closeRegisterDialog();
  } catch (err) {
    console.error('登録エラー:', err);
    btn.textContent = 'エラー。再試行してください';
    btn.disabled = false;
    setTimeout(() => {
      btn.textContent = '登録';
      updateRegisterBtn();
    }, 2000);
  }
}

// =====================
//  旅 select ロード
// =====================

async function loadTripsToSelect() {
  _trips = await getAllTrips();
  const sel = document.getElementById('field-trip');
  sel.innerHTML = '<option value="">旅を選択（任意）</option>';

  for (const trip of _trips) {
    const opt = document.createElement('option');
    opt.value       = trip.id;
    opt.textContent = trip.title || `旅 ${tsToDateStr(trip.createdAt)}`;
    sel.appendChild(opt);
  }
}

// =====================
//  新旅ダイアログ
// =====================

function setupNewTripDialog() {
  document.getElementById('new-trip-close').addEventListener('click', () => {
    document.getElementById('dialog-new-trip').classList.add('hidden');
  });

  document.getElementById('dialog-new-trip').addEventListener('click', e => {
    if (e.target === e.currentTarget) {
      document.getElementById('dialog-new-trip').classList.add('hidden');
    }
  });

  document.getElementById('btn-save-trip').addEventListener('click', async () => {
    const title    = document.getElementById('trip-title').value.trim();
    const dateFrom = document.getElementById('trip-date-from').value;
    const dateTo   = document.getElementById('trip-date-to').value;
    const memo     = document.getElementById('trip-memo').value.trim();

    if (!title) {
      document.getElementById('trip-title').focus();
      return;
    }

    await addTrip({ title, dateFrom, dateTo, memo });

    document.getElementById('dialog-new-trip').classList.add('hidden');

    document.getElementById('trip-title').value     = '';
    document.getElementById('trip-date-from').value = '';
    document.getElementById('trip-date-to').value   = '';
    document.getElementById('trip-memo').value      = '';

    await loadTripsToSelect();

    const sel = document.getElementById('field-trip');
    if (sel.options.length > 1) {
      sel.selectedIndex = 1;
    }
  });
}

// =====================
//  旅一覧パネル
// =====================

function setupTripsPanel() {
  const btn   = document.getElementById('btn-trips');
  const panel = document.getElementById('panel-trips');
  const close = document.getElementById('trips-close');

  btn.addEventListener('click', async () => {
    panel.classList.remove('hidden');
    await renderTripsList();
  });

  close.addEventListener('click', () => panel.classList.add('hidden'));

  document.getElementById('btn-back-trips').addEventListener('click', () => {
    document.getElementById('panel-trip-detail').classList.add('hidden');
    panel.classList.remove('hidden');
  });

  document.getElementById('trip-detail-close').addEventListener('click', () => {
    document.getElementById('panel-trip-detail').classList.add('hidden');
  });
}

async function renderTripsList() {
  const trips = await getAllTrips();
  const list  = document.getElementById('trips-list');
  list.innerHTML = '';

  if (trips.length === 0) {
    list.innerHTML = '<p style="color:#999;padding:16px;font-size:13px;">まだ旅の記録がありません</p>';
    return;
  }

  for (const trip of trips) {
    const visited = await getVisitedByTrip(trip.id);
    const regionSet = new Set(visited.map(v => v.regionKey));

    const card = document.createElement('div');
    card.className = 'trip-card';

    card.innerHTML = `
      <div class="trip-card-title">${escHtml(trip.title || '無題の旅')}</div>
      <div class="trip-card-date">${formatDateRange(trip.dateFrom, trip.dateTo)}</div>
      <div class="trip-card-stats">${regionSet.size}エリア制覇</div>
    `;

    card.addEventListener('click', () => openTripDetail(trip));
    list.appendChild(card);
  }
}

async function openTripDetail(trip) {
  document.getElementById('panel-trips').classList.add('hidden');
  const detail = document.getElementById('panel-trip-detail');
  detail.classList.remove('hidden');

  const photos  = await getPhotosByTrip(trip.id);
  const visited = await getVisitedByTrip(trip.id);
  photos.sort((a, b) => a.takenAt - b.takenAt);

  const regionSet = new Set(visited.map(v => v.regionKey));

  const content = document.getElementById('trip-detail-content');
  content.innerHTML = `
    <div class="trip-detail-header">
      <div class="trip-detail-title">${escHtml(trip.title || '無題の旅')}</div>
      <div class="trip-detail-date">${formatDateRange(trip.dateFrom, trip.dateTo)}</div>
      ${trip.memo ? `<div class="trip-detail-memo">${escHtml(trip.memo)}</div>` : ''}
      <div class="trip-card-stats" style="margin-top:8px;">${regionSet.size}エリア制覇</div>
    </div>
  `;

  for (const photo of photos) {
    const visitedRec = visited.find(v => v.regionKey === photo.regionKey);
    const name = visitedRec ? visitedRec.regionName : photo.regionKey;

    const item = document.createElement('div');
    item.className = 'visit-item';

    const img = document.createElement('img');
    img.className = 'visit-thumb';
    img.alt = name;

    const url = URL.createObjectURL(photo.blob);
    img.src = url;

    const info = document.createElement('div');
    info.className = 'visit-info';
    info.innerHTML = `
      <div class="visit-name">${escHtml(name)}</div>
      ${photo.caption ? `<div class="visit-date">${escHtml(photo.caption)}</div>` : ''}
      <div class="visit-date">${tsToJaDate(photo.takenAt)}</div>
    `;

    item.appendChild(img);
    item.appendChild(info);
    content.appendChild(item);
  }
}

// =====================
//  ヘルパー
// =====================

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDateRange(from, to) {
  if (!from && !to) return '期間未設定';
  if (!to)   return from;
  if (!from) return to;
  return `${from} 〜 ${to}`;
}
