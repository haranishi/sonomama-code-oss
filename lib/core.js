// そのままコード — 純粋ロジック（ブラウザとNodeの両方で読める）
// UIもchrome APIも触らない。ここをテストで固める。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SQR = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // QR規格の上限。バージョン40・誤り訂正レベルL・8bitバイトモードで2,953バイト。
  // 本アプリは誤り訂正Mを使うので実効上限はこれより小さいが、
  // 「明らかに入らない」を早期に弾くための上限として使う。
  var MAX_BYTES = 2953;

  // 誤り訂正レベル。URLは印刷して汚れ・かすれに晒されるのでM(15%)を既定にする。
  var EC_LEVEL = 'M';

  // クワイエットゾーン（余白）。QR規格は4モジュール以上を要求する。
  var QUIET_ZONE_MODULES = 4;

  // 保存プリセット。ユーザーの語彙は「形式」ではなく「用途」なのでこの並びにする。
  // mmは300dpi換算（1inch=25.4mm, 300px/inch => 11.811px/mm）。
  var PRESETS = [
    { id: 'screen', label: '画面用', px: 512, note: '約43mm' },
    { id: 'print', label: '印刷用', px: 1024, note: '約87mm' },
    { id: 'large', label: '大判', px: 2048, note: '約173mm' }
  ];

  // 他の端末（スマホ）で開いても意味がないスキーム。
  // QRは作れるが、読み取った先で開けないので警告する。黙って作らない・黙って拒否もしない。
  var LOCAL_ONLY_SCHEMES = [
    'chrome:', 'chrome-extension:', 'chrome-search:', 'chrome-untrusted:',
    'about:', 'edge:', 'brave:', 'opera:', 'vivaldi:',
    'devtools:', 'view-source:', 'file:', 'data:', 'blob:', 'filesystem:'
  ];

  function utf8ByteLength(str) {
    if (typeof str !== 'string') return 0;
    // TextEncoderはブラウザにもNode 11+にもある
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str).length;
    return Buffer.byteLength(str, 'utf8');
  }

  function schemeOf(url) {
    var m = /^([a-zA-Z][a-zA-Z0-9+.-]*:)/.exec(url || '');
    return m ? m[1].toLowerCase() : '';
  }

  // URLを分類する。UIの状態はこの戻り値だけで決まる。
  // kind: 'ok' | 'empty' | 'too-long' | 'local-only'
  function classifyUrl(url) {
    if (typeof url !== 'string' || url.trim() === '') {
      return { kind: 'empty', bytes: 0, scheme: '' };
    }
    var bytes = utf8ByteLength(url);
    var scheme = schemeOf(url);
    if (bytes > MAX_BYTES) {
      return { kind: 'too-long', bytes: bytes, scheme: scheme, limit: MAX_BYTES };
    }
    if (LOCAL_ONLY_SCHEMES.indexOf(scheme) !== -1) {
      return { kind: 'local-only', bytes: bytes, scheme: scheme };
    }
    return { kind: 'ok', bytes: bytes, scheme: scheme };
  }

  // 目標ピクセル数から1モジュールあたりのピクセル数を出す。
  // 端数は切り捨てる＝出力は必ず整数倍になり、拡大時のにじみが出ない。
  function computeCellSize(moduleCount, targetPx, quietZoneModules) {
    var q = quietZoneModules == null ? QUIET_ZONE_MODULES : quietZoneModules;
    var total = moduleCount + q * 2;
    return Math.max(1, Math.floor(targetPx / total));
  }

  // 実際に出力されるピクセル数。プリセットの数字とは一致しないので、
  // 画面には「実際の値」を出す（盛らない）。
  function outputPx(moduleCount, cellSize, quietZoneModules) {
    var q = quietZoneModules == null ? QUIET_ZONE_MODULES : quietZoneModules;
    return (moduleCount + q * 2) * cellSize;
  }

  // 300dpi換算のmm。印刷で使えるかの判断材料として画面に出す。
  function pxToMmAt300dpi(px) {
    return Math.round((px / 300) * 25.4 * 10) / 10;
  }

  // isDark(row, col) を渡すとSVG文字列を返す。
  // 1つのpathに畳んでファイルサイズを抑える。外部参照なし・単体で開ける。
  function buildSvg(moduleCount, isDark, opts) {
    var o = opts || {};
    var q = o.quietZoneModules == null ? QUIET_ZONE_MODULES : o.quietZoneModules;
    var dark = o.dark || '#000000';
    var light = o.light || '#ffffff';
    var side = moduleCount + q * 2;
    var d = '';
    for (var r = 0; r < moduleCount; r++) {
      for (var c = 0; c < moduleCount; c++) {
        if (isDark(r, c)) d += 'M' + (c + q) + ' ' + (r + q) + 'h1v1h-1z';
      }
    }
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + side + ' ' + side + '" ' +
      'width="' + side + '" height="' + side + '" shape-rendering="crispEdges">' +
      '<rect width="' + side + '" height="' + side + '" fill="' + light + '"/>' +
      '<path fill="' + dark + '" d="' + d + '"/>' +
      '</svg>\n';
  }

  // ダウンロードのファイル名。ホスト名を入れて後から探せるようにする。
  function fileNameFor(url, ext) {
    var host = '';
    try { host = new URL(url).hostname || ''; } catch (e) { host = ''; }
    host = host.replace(/[^a-zA-Z0-9.-]/g, '') || 'qr';
    return 'qr_' + host + '.' + ext;
  }

  return {
    MAX_BYTES: MAX_BYTES,
    EC_LEVEL: EC_LEVEL,
    QUIET_ZONE_MODULES: QUIET_ZONE_MODULES,
    PRESETS: PRESETS,
    LOCAL_ONLY_SCHEMES: LOCAL_ONLY_SCHEMES,
    utf8ByteLength: utf8ByteLength,
    schemeOf: schemeOf,
    classifyUrl: classifyUrl,
    computeCellSize: computeCellSize,
    outputPx: outputPx,
    pxToMmAt300dpi: pxToMmAt300dpi,
    buildSvg: buildSvg,
    fileNameFor: fileNameFor
  };
});
