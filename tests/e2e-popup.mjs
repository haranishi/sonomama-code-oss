// 実ブラウザ（Chromium）でポップアップを描画して検証する。
// このプロジェクトにインストールした Playwright を使用する。
// 実行: node tests/e2e-popup.mjs
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SHOT_DIR = join(ROOT, 'docs/screenshots');
mkdirSync(SHOT_DIR, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`);
}

function stub(url) {
  return `(() => {
    window.chrome = {
      tabs: { query: async () => [{ url: ${JSON.stringify(url)} }] },
      runtime: { getURL: (p) => '/' + p }
    };
  })()`;
}

const popupUrl = pathToFileURL(join(ROOT, 'popup/popup.html')).href;
const browser = await chromium.launch({ headless: true });

async function open(url, colorScheme = 'light') {
  const ctx = await browser.newContext({ colorScheme, viewport: { width: 420, height: 900 } });
  const external = [];
  const errors = [];
  ctx.on('request', r => { if (!r.url().startsWith('file://') && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) external.push(r.url()); });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(stub(url));
  await page.goto(popupUrl);
  return { ctx, page, external, errors };
}

// --- 1. 正常系 ---
{
  const target = 'https://example.com/very/long/path?utm_source=test&utm_campaign=qr';
  const { ctx, page, external, errors } = await open(target);
  await page.waitForSelector('#view-ok:not([hidden])', { timeout: 5000 });

  check('正常系: 生成済みビューが表示される', true);
  check('ペイロードにURL全文が入る', (await page.textContent('#payload')) === target);
  check('約束の文言が出ている', /短縮なし・リダイレクトなし・通信なし/.test(await page.textContent('#view-ok')));
  check('商標文が出ている', /デンソーウェーブの登録商標/.test(await page.textContent('.foot')));

  const canvasInfo = await page.evaluate(() => {
    const c = document.getElementById('qr-canvas');
    const ctx2 = c.getContext('2d');
    const d = ctx2.getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 128) dark++;
    return { w: c.width, h: c.height, darkPixels: dark };
  });
  check('QRがcanvasに実際に描画されている', canvasInfo.darkPixels > 1000,
    `${canvasInfo.w}x${canvasInfo.h}, 暗ピクセル${canvasInfo.darkPixels}`);

  const meta = await page.textContent('#meta');
  check('メタに実際の出力サイズが出る', /PNGの実際の出力: \d+×\d+px/.test(meta), meta.split('\n')[0]);

  // プリセット切り替えでメタが変わる
  const before = await page.textContent('#meta');
  await page.click('#presets .preset >> nth=2'); // 大判
  const after = await page.textContent('#meta');
  check('プリセット切替でメタが更新される', before !== after);
  check('大判のaria-pressedがtrueになる',
    (await page.getAttribute('#presets .preset >> nth=2', 'aria-pressed')) === 'true');

  // ダウンロードが実際に発火するか（PNG）
  await page.click('#presets .preset >> nth=1'); // 印刷用に戻す
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }).catch(() => null),
    page.click('#save-png')
  ]);
  check('PNG保存でダウンロードが発火する', !!dl, dl ? dl.suggestedFilename() : 'ダウンロードイベント無し');

  const [dl2] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }).catch(() => null),
    page.click('#save-svg')
  ]);
  check('SVG保存でダウンロードが発火する', !!dl2, dl2 ? dl2.suggestedFilename() : 'ダウンロードイベント無し');

  check('外部通信がゼロ', external.length === 0, external.join(', ') || 'リクエスト0件');
  check('JSエラーがゼロ', errors.length === 0, errors.join(' | ') || 'エラー0件');

  await page.screenshot({ path: join(SHOT_DIR, 'popup-light.png'), fullPage: true });
  await ctx.close();
}

// --- 2. ダークモード ---
{
  const { ctx, page } = await open('https://example.com/', 'dark');
  await page.waitForSelector('#view-ok:not([hidden])');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('ダークモードで背景が暗くなる', bg !== 'rgb(255, 255, 255)', bg);
  await page.screenshot({ path: join(SHOT_DIR, 'popup-dark.png'), fullPage: true });
  await ctx.close();
}

// --- 3. Chromeの内部ページ（tab.urlがundefinedのケース） ---
{
  const ctx = await browser.newContext({ viewport: { width: 420, height: 400 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript(`window.chrome={tabs:{query:async()=>[{}]},runtime:{getURL:p=>'/'+p}};`);
  await page.goto(popupUrl);
  await page.waitForSelector('#view-error:not([hidden])', { timeout: 5000 });
  const title = await page.textContent('#err-title');
  check('tab.urlがundefinedでも壊れずエラー表示になる', /共有できません/.test(title), title);
  check('内部ページでJSエラーが出ない', errors.length === 0, errors.join(' | ') || 'エラー0件');
  await page.screenshot({ path: join(SHOT_DIR, 'popup-internal-page.png'), fullPage: true });
  await ctx.close();
}

// --- 4. file:// のような読み取れても開けないURL（警告つきで生成される） ---
{
  const { ctx, page } = await open('file:///tmp/example.html');
  await page.waitForSelector('#view-ok:not([hidden])');
  const warnVisible = await page.isVisible('#local-warn');
  check('file:// はQRを作るが警告を出す', warnVisible, await page.textContent('#local-warn'));
  await ctx.close();
}

// --- 5. 長すぎるURL ---
{
  const { ctx, page } = await open('https://example.com/' + 'a'.repeat(3000));
  await page.waitForSelector('#view-error:not([hidden])');
  check('長すぎるURLはエラーになる', /長すぎます/.test(await page.textContent('#err-title')));
  await ctx.close();
}

await browser.close();

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} pass`);
if (failed.length) { console.error('失敗:', failed.map(f => f.name).join(', ')); process.exit(1); }
console.log('スクリーンショット:', SHOT_DIR);
