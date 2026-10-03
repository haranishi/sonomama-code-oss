// そのままコード — ポップアップ。
// 設計上の要点: 状態は「生成済み」と「エラー」の2つだけ。
// QR生成は同期処理なのでローディング状態を作らない（存在しない状態を発明しない）。
'use strict';

const PREVIEW_TARGET_PX = 280;

let state = {
  url: '',
  qr: null,
  moduleCount: 0,
  presetId: 'print'
};

function $(id) { return document.getElementById(id); }

function showError(title, body) {
  $('err-title').textContent = title;
  $('err-body').textContent = body;
  $('view-error').hidden = false;
  $('view-ok').hidden = true;
}

// isDark を1枚のcanvasに描く。guide=true なら余白の境界に点線を引く（プレビュー専用）。
function drawTo(canvas, cellSize, guide) {
  const q = SQR.QUIET_ZONE_MODULES;
  const side = (state.moduleCount + q * 2) * cellSize;
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, side, side);

  ctx.fillStyle = '#000000';
  for (let r = 0; r < state.moduleCount; r++) {
    for (let c = 0; c < state.moduleCount; c++) {
      if (state.qr.isDark(r, c)) {
        ctx.fillRect((c + q) * cellSize, (r + q) * cellSize, cellSize, cellSize);
      }
    }
  }

  if (guide) {
    // 余白（クワイエットゾーン）がどこまでかを見せる。
    // スキャン失敗の最大原因は余白の切り落としなので、ここを可視化する。
    const style = getComputedStyle(document.body);
    ctx.strokeStyle = style.getPropertyValue('--guide').trim() || '#b9c6bd';
    ctx.setLineDash([cellSize, cellSize]);
    ctx.lineWidth = Math.max(1, Math.floor(cellSize / 4));
    const off = q * cellSize;
    ctx.strokeRect(off, off, state.moduleCount * cellSize, state.moduleCount * cellSize);
  }
  return side;
}

function renderPreview() {
  const canvas = $('qr-canvas');
  const cell = SQR.computeCellSize(state.moduleCount, PREVIEW_TARGET_PX);
  const side = drawTo(canvas, cell, true);
  canvas.style.width = side + 'px';
  canvas.style.height = side + 'px';
  $('quiet-note').textContent =
    '点線の外側の白い余白（' + SQR.QUIET_ZONE_MODULES + 'モジュール）まで含めて印刷してください';
}

function selectedPreset() {
  return SQR.PRESETS.find(p => p.id === state.presetId) || SQR.PRESETS[1];
}

function renderMeta() {
  const p = selectedPreset();
  const cell = SQR.computeCellSize(state.moduleCount, p.px);
  const px = SQR.outputPx(state.moduleCount, cell);
  $('meta').textContent =
    'PNGの実際の出力: ' + px + '×' + px + 'px（約' + SQR.pxToMmAt300dpi(px) + 'mm＠300dpi）' +
    ' / SVGは解像度に依存しません\n' +
    '誤り訂正レベル ' + SQR.EC_LEVEL + '（15%）・' + state.moduleCount + '×' + state.moduleCount +
    'モジュール・URL ' + SQR.utf8ByteLength(state.url) + 'バイト';
}

function renderPresets() {
  const wrap = $('presets');
  wrap.textContent = '';
  SQR.PRESETS.forEach(p => {
    const b = document.createElement('button');
    b.className = 'preset';
    b.type = 'button';
    b.setAttribute('aria-pressed', String(p.id === state.presetId));
    const strong = document.createElement('span');
    strong.textContent = p.label;
    const note = document.createElement('span');
    note.className = 'p-note';
    note.textContent = p.note;
    b.append(strong, note);
    b.addEventListener('click', () => {
      state.presetId = p.id;
      renderPresets();
      renderMeta();
    });
    wrap.appendChild(b);
  });
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 即座に解放するとダウンロードが始まらない環境があるので少し待つ
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function savePng() {
  const p = selectedPreset();
  const cell = SQR.computeCellSize(state.moduleCount, p.px);
  const off = document.createElement('canvas');
  drawTo(off, cell, false); // 書き出しにガイドは入れない
  off.toBlob(blob => {
    if (blob) download(blob, SQR.fileNameFor(state.url, 'png'));
  }, 'image/png');
}

function saveSvg() {
  const svg = SQR.buildSvg(state.moduleCount, (r, c) => state.qr.isDark(r, c));
  download(new Blob([svg], { type: 'image/svg+xml' }), SQR.fileNameFor(state.url, 'svg'));
}

async function copyUrl() {
  const btn = $('copy-url');
  const original = 'URLをコピー';
  try {
    await navigator.clipboard.writeText(state.url);
    btn.textContent = 'コピーしました';
  } catch (e) {
    btn.textContent = 'コピーできませんでした';
  }
  setTimeout(() => { btn.textContent = original; }, 1600);
}

function wireFooter() {
  const link = $('license-link');
  if (link) link.href = chrome.runtime.getURL('LICENSES.txt');
}

async function init() {
  wireFooter();
  let tab;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs && tabs[0];
  } catch (e) {
    showError('ページを取得できませんでした', 'タブの情報が読み取れませんでした。ページを再読み込みしてからもう一度お試しください。');
    return;
  }

  const url = (tab && tab.url) || '';
  const verdict = SQR.classifyUrl(url);

  if (verdict.kind === 'empty') {
    // chrome://newtab などChromeの内部ページでは activeTab が付与されず tab.url が undefined になる。
    // ここをガードしないとポップアップが真っ白になる（審査で落ちる典型パターン）。
    showError('このページのURLは共有できません',
      'Chromeの内部ページ（新しいタブ・設定・拡張機能の管理画面など）では、URLを読み取れません。Webページを開いた状態でお試しください。');
    return;
  }
  if (verdict.kind === 'too-long') {
    showError('URLが長すぎます',
      'このURLは ' + verdict.bytes + ' バイトあり、QRコードの上限（' + verdict.limit +
      ' バイト）を超えています。QRコードにはできません。短縮URLを使う方法もありますが、このアプリは中身を書き換えない方針のため行いません。');
    return;
  }

  state.url = url;
  state.qr = qrcode(0, SQR.EC_LEVEL);
  state.qr.addData(url);
  try {
    state.qr.make();
  } catch (e) {
    showError('QRコードを作れませんでした', 'このURLはQRコードの容量に収まりませんでした。');
    return;
  }
  state.moduleCount = state.qr.getModuleCount();

  $('payload').textContent = url;

  if (verdict.kind === 'local-only') {
    const w = $('local-warn');
    w.hidden = false;
    w.textContent = 'このURLは「' + verdict.scheme + '」で始まるため、読み取った端末では開けません。QRコード自体は正しく作られています。';
  }

  $('view-ok').hidden = false;
  renderPreview();
  renderPresets();
  renderMeta();

  $('save-png').addEventListener('click', savePng);
  $('save-svg').addEventListener('click', saveSvg);
  $('copy-url').addEventListener('click', copyUrl);
}

document.addEventListener('DOMContentLoaded', init);
