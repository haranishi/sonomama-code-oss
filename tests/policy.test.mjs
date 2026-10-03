// Chrome Web Store のポリシー適合を「回帰テスト」として固定する。
// 権限が増える／外部参照が混入する／manifestの参照先が消える、を検出する。
// 根拠は Obsidian の [[2026-08-19_法務・規約調査]]。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'archive') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

test('Manifest V3である', () => {
  assert.equal(manifest.manifest_version, 3);
});

test('権限は activeTab のみ（tabs / host_permissions / scripting を足していない）', () => {
  assert.deepEqual(manifest.permissions, ['activeTab'],
    'activeTab以外を足すとインストール時警告が出て、単一目的違反リスクも上がる');
  assert.ok(!('host_permissions' in manifest), 'host_permissions は不要');
  assert.ok(!('optional_permissions' in manifest), 'optional_permissions も置いていない');
  for (const forbidden of ['tabs', 'scripting', 'downloads', 'storage', 'clipboardWrite', 'cookies']) {
    assert.ok(!manifest.permissions.includes(forbidden), `${forbidden} を宣言していない`);
  }
});

test('background / content_scripts を持たない（ポップアップのみの単一目的）', () => {
  assert.ok(!('background' in manifest));
  assert.ok(!('content_scripts' in manifest));
  assert.ok(!('web_accessible_resources' in manifest));
});

test('CSPは self のみ（remotely hosted code を許していない）', () => {
  const csp = manifest.content_security_policy?.extension_pages || '';
  assert.match(csp, /script-src 'self'/);
  assert.ok(!/https?:/.test(csp), 'CSPに外部ドメインを許可していない');
  assert.ok(!/unsafe-eval|unsafe-inline/.test(csp), 'unsafe-* を許可していない');
});

test('名称に「QRコード」「QR Code」を含まない（デンソーウェーブ公式FAQの要請）', () => {
  const name = manifest.name;
  assert.ok(!/QR\s*Code/i.test(name), `名称に QR Code を含めない: ${name}`);
  assert.ok(!/QRコード/.test(name), `名称に QRコード を含めない: ${name}`);
});

test('「QRコード」の語を使う画面には登録商標文がある', () => {
  const html = readFileSync(join(ROOT, 'popup/popup.html'), 'utf8');
  if (/QRコード/.test(html)) {
    assert.match(html, /QRコードは株式会社デンソーウェーブの登録商標です/,
      'QRコードの語を使う画面には登録商標文の掲載が必要');
  }
});

test('LICENSES.txt が同梱され、MITの著作権表示とライセンス全文を含む', () => {
  const p = join(ROOT, 'LICENSES.txt');
  assert.ok(existsSync(p), 'LICENSES.txt が存在する');
  const s = readFileSync(p, 'utf8');
  assert.match(s, /Copyright \(c\) 2009 Kazuhiko Arase/);
  assert.match(s, /Permission is hereby granted, free of charge/, 'MIT全文が入っている');
  assert.match(s, /THE SOFTWARE IS PROVIDED "AS IS"/);
});

test('同梱ライブラリの著作権ヘッダを削っていない', () => {
  for (const f of ['lib/qrcode.js', 'lib/qrcode_UTF8.js']) {
    const s = readFileSync(join(ROOT, f), 'utf8');
    assert.match(s, /Copyright \(c\) 20\d\d Kazuhiko Arase/, `${f} のヘッダが残っている`);
    assert.match(s, /MIT license/i, `${f} のライセンス表記が残っている`);
  }
});

test('どのファイルも外部ホストへ通信しない（fetch / XHR / WebSocket / 外部script）', () => {
  const files = walk(ROOT).filter(p => ['.js', '.mjs', '.html', '.css', '.json'].includes(extname(p)));
  for (const p of files) {
    if (p.includes('/tests/')) continue;          // テスト自身は対象外
    if (p.endsWith('lib/qrcode.js') || p.endsWith('lib/qrcode_UTF8.js')) continue; // 同梱原本（URLはコメント内のみ）
    const s = readFileSync(p, 'utf8');
    const rel = p.slice(ROOT.length + 1);
    assert.ok(!/\bfetch\s*\(/.test(s), `${rel}: fetch を使っていない`);
    assert.ok(!/XMLHttpRequest/.test(s), `${rel}: XHR を使っていない`);
    assert.ok(!/\bnew\s+WebSocket\b/.test(s), `${rel}: WebSocket を使っていない`);
    assert.ok(!/\beval\s*\(/.test(s), `${rel}: eval を使っていない`);
    assert.ok(!/src\s*=\s*["']https?:/i.test(s), `${rel}: 外部srcを参照していない`);
    assert.ok(!/@import\s+url\(\s*["']?https?:/i.test(s), `${rel}: 外部CSSを読み込んでいない`);
  }
});

test('manifestが参照する全ファイルが実在する（Yellow Magnesium対策）', () => {
  const refs = [
    manifest.action.default_popup,
    ...Object.values(manifest.action.default_icon),
    ...Object.values(manifest.icons)
  ];
  for (const r of new Set(refs)) {
    assert.ok(existsSync(join(ROOT, r)), `${r} が存在する`);
  }
});

test('popup.htmlが参照するローカルファイルが実在する', () => {
  const html = readFileSync(join(ROOT, 'popup/popup.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1])
    .filter(u => !u.startsWith('#') && !/^https?:/.test(u));
  assert.ok(refs.length > 0);
  for (const r of refs) {
    assert.ok(existsSync(join(ROOT, 'popup', r)), `popup/${r} が存在する`);
  }
});

test('インラインscript/onイベント属性を使っていない（MV3のCSPで動かない）', () => {
  const html = readFileSync(join(ROOT, 'popup/popup.html'), 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(html),
    'インラインscriptがない');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'onclick等の属性がない');
});

test('プライバシーポリシーの原稿が同梱されている', () => {
  assert.ok(existsSync(join(ROOT, 'docs/PRIVACY.md')), 'docs/PRIVACY.md が存在する');
});
