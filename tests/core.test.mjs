import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
globalThis.qrcode = require('../lib/qrcode.js');
require('../lib/qrcode_UTF8.js');
const SQR = require('../lib/core.js');

function makeQr(text) {
  const qr = qrcode(0, SQR.EC_LEVEL);
  qr.addData(text);
  qr.make();
  return qr;
}

test('classifyUrl: 通常のhttps URLはok', () => {
  const v = SQR.classifyUrl('https://example.com/page?a=1');
  assert.equal(v.kind, 'ok');
  assert.equal(v.scheme, 'https:');
});

test('classifyUrl: 空・undefined・空白はempty', () => {
  for (const bad of ['', '   ', undefined, null, 42]) {
    assert.equal(SQR.classifyUrl(bad).kind, 'empty', `入力: ${String(bad)}`);
  }
});

test('classifyUrl: Chromeの内部ページ・file:はlocal-only', () => {
  const cases = [
    'chrome://newtab', 'chrome://settings/', 'chrome-extension://abc/popup.html',
    'about:blank', 'devtools://devtools/bundled/x.html', 'view-source:https://example.com',
    'file:///tmp/example.html', 'edge://settings'
  ];
  for (const u of cases) {
    assert.equal(SQR.classifyUrl(u).kind, 'local-only', `入力: ${u}`);
  }
});

test('classifyUrl: 上限超過はtoo-long（QRを作ろうとせずに弾く）', () => {
  const long = 'https://example.com/' + 'a'.repeat(SQR.MAX_BYTES);
  const v = SQR.classifyUrl(long);
  assert.equal(v.kind, 'too-long');
  assert.equal(v.limit, SQR.MAX_BYTES);
  assert.ok(v.bytes > SQR.MAX_BYTES);
});

test('classifyUrl: 判定はバイト数で行う（文字数ではない）', () => {
  // 日本語は1文字3バイト。文字数で判定していたらここが通ってしまう
  const url = 'https://example.com/' + 'あ'.repeat(1000); // 約3000バイト
  assert.ok(SQR.utf8ByteLength(url) > SQR.MAX_BYTES);
  assert.equal(SQR.classifyUrl(url).kind, 'too-long');
});

test('utf8ByteLength: マルチバイトを正しく数える', () => {
  assert.equal(SQR.utf8ByteLength('abc'), 3);
  assert.equal(SQR.utf8ByteLength('あいう'), 9);
  assert.equal(SQR.utf8ByteLength('🎉'), 4);
});

test('computeCellSize/outputPx: 出力は必ず整数倍（拡大時にじまない）', () => {
  const qr = makeQr('https://example.com/');
  const mc = qr.getModuleCount();
  for (const target of [512, 1024, 2048]) {
    const cell = SQR.computeCellSize(mc, target);
    assert.ok(Number.isInteger(cell) && cell >= 1);
    const px = SQR.outputPx(mc, cell);
    assert.equal(px % cell, 0, '出力ピクセルはセルサイズの整数倍');
    assert.ok(px <= target, `${px} は目標 ${target} を超えない`);
  }
});

test('computeCellSize: 極端に小さい目標でも1を下回らない', () => {
  assert.equal(SQR.computeCellSize(177, 1), 1);
});

test('プリセットは3つで、pxが昇順', () => {
  assert.equal(SQR.PRESETS.length, 3);
  const pxs = SQR.PRESETS.map(p => p.px);
  assert.deepEqual(pxs, [...pxs].sort((a, b) => a - b));
});

test('pxToMmAt300dpi: 300pxは25.4mm', () => {
  assert.equal(SQR.pxToMmAt300dpi(300), 25.4);
  assert.equal(SQR.pxToMmAt300dpi(1181), 100);
});

test('fileNameFor: ホスト名を使い、危険な文字を落とす', () => {
  assert.equal(SQR.fileNameFor('https://example.com/a/b', 'png'), 'qr_example.com.png');
  // パス区切りや空白がファイル名に漏れないこと
  const name = SQR.fileNameFor('https://ex am/../ple.com/x', 'svg');
  assert.ok(!name.includes('/'), '/ が残っていない');
  assert.ok(!name.includes(' '), '空白が残っていない');
  assert.ok(name.endsWith('.svg'));
  // URLとして解釈できない入力でも落ちない
  assert.equal(SQR.fileNameFor('not a url', 'png'), 'qr_qr.png');
});

test('buildSvg: 整形式で、暗モジュール数がisDarkと一致する', () => {
  const url = 'https://example.com/日本語?x=1';
  const qr = makeQr(url);
  const mc = qr.getModuleCount();
  const svg = SQR.buildSvg(mc, (r, c) => qr.isDark(r, c));

  const q = SQR.QUIET_ZONE_MODULES;
  const side = mc + q * 2;
  assert.ok(svg.startsWith('<?xml'), 'XML宣言がある');
  assert.ok(svg.includes(`viewBox="0 0 ${side} ${side}"`), 'viewBoxに余白が含まれる');
  assert.ok(!/https?:\/\//.test(svg.replace('http://www.w3.org/2000/svg', '')),
    'SVG名前空間以外の外部参照を含まない');

  let expected = 0;
  for (let r = 0; r < mc; r++) for (let c = 0; c < mc; c++) if (qr.isDark(r, c)) expected++;
  const drawn = (svg.match(/M\d+ \d+h1v1h-1z/g) || []).length;
  assert.equal(drawn, expected, '描画したモジュール数が一致');
});

// ファインダパターン（位置検出パターン）の7x7署名を判定する。
// 外周リング=暗、その内側リング=明、中央3x3=暗。
function isFinderAt(qr, r0, c0) {
  for (let dr = 0; dr < 7; dr++) {
    for (let dc = 0; dc < 7; dc++) {
      const ring = Math.max(Math.abs(dr - 3), Math.abs(dc - 3)); // 0=中心 .. 3=外周
      const shouldBeDark = ring !== 2; // ring2 のみ明、他は暗
      if (qr.isDark(r0 + dr, c0 + dc) !== shouldBeDark) return false;
    }
  }
  return true;
}

test('QRの構造: ファインダパターンは左上・右上・左下の3つだけ', () => {
  const qr = makeQr('https://example.com/');
  const mc = qr.getModuleCount();
  assert.ok(isFinderAt(qr, 0, 0), '左上にある');
  assert.ok(isFinderAt(qr, 0, mc - 7), '右上にある');
  assert.ok(isFinderAt(qr, mc - 7, 0), '左下にある');
  assert.ok(!isFinderAt(qr, mc - 7, mc - 7), '右下には無い（QRの向きが決まる根拠）');
});

test('QRの構造: タイミングパターン（6行目・6列目）が交互に並ぶ', () => {
  const qr = makeQr('https://example.com/');
  const mc = qr.getModuleCount();
  // ファインダパターンの内側（8 .. mc-9）が交互になる
  for (let c = 8; c <= mc - 9; c++) {
    assert.equal(qr.isDark(6, c), c % 2 === 0, `行6の列${c}`);
  }
  for (let r = 8; r <= mc - 9; r++) {
    assert.equal(qr.isDark(r, 6), r % 2 === 0, `列6の行${r}`);
  }
});

test('QRのモジュール数は 21 + 4*(version-1) の形をとる', () => {
  for (const url of ['https://a.co', 'https://example.com/' + 'x'.repeat(200)]) {
    const mc = makeQr(url).getModuleCount();
    assert.equal((mc - 21) % 4, 0, `moduleCount=${mc}`);
    assert.ok(mc >= 21 && mc <= 177);
  }
});

test('長いURLでもmakeが通り、モジュール数が増える', () => {
  const short = makeQr('https://a.co').getModuleCount();
  const long = makeQr('https://example.com/' + 'x'.repeat(400)).getModuleCount();
  assert.ok(long > short);
});
