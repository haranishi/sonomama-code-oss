# 現行設計: URLを変えず端末内で二次元コードにする

2026-10-30時点のtrackedコードを根拠とする。[README](../README.md)と[プライバシーポリシー](PRIVACY.md)の機能を、処理とデータの境界に結び付けた記録。今回はコード/相対参照を確認しただけで、実タブ・Chrome profile・保存画像・クリップボードは操作していない。

## 要件

- ユーザーがpopupを開いたときのアクティブタブURLを、そのまま符号化し全文を表示する。短縮/中継/読み取り機能は持たない。
- 白地と黒モジュール、4モジュールの余白、誤り訂正Mを維持する。テーマでコードの色を反転せず、保存画像にプレビューの点線を混ぜない。
- 空URLや明らかな容量超過は停止し、取得/生成に失敗しても空のpopupにしない。

## 構成と処理の境界

| 部分 | 役割・根拠 |
| --- | --- |
| 起動/権限 | [manifest.json](../manifest.json): `activeTab`のみ、popupと`_execute_action`。background/content script/host権限はない。 |
| 純粋処理 | [core.js](../lib/core.js): URL分類、UTF-8長、整数セル幅、SVG、ファイル名。DOM/Chrome APIを使わない。 |
| 符号化 | 同梱の[qrcode.js](../lib/qrcode.js)と[UTF-8補助](../lib/qrcode_UTF8.js)。外部API/CDNを呼ばない。 |
| UI/保存 | [popup.js](../popup/popup.js): `chrome.tabs.query({active:true,currentWindow:true})`→分類→符号化→canvas/SVG表示。保存とURLコピーは明示操作。 |

拡張コンポーネント間の独自メッセージ通信はない。popup内の状態はURL・生成行列・モジュール数・選択プリセットで、再開用に永続化しない。同期生成なので、通常表示とエラー表示を切り替える。

## 入力と出力の条件

- `MAX_BYTES=2953`は早期拒否の上限で、誤り訂正Mでの収容を保証する値ではない。実際に収まらない場合は符号化時の例外を画面へ表示する。
- `LOCAL_ONLY_SCHEMES`は拒否ではなく警告の分類。URLが取得できた`file:`等も生成し、別端末では開けないと注意する。Chrome内部ページ等でURL自体が取れない場合は空入力として停止する。
- ペイロードは元URLのクエリ/fragmentも保つ。URLの安全性を判定したり、認証トークンを取り除いたりはしない。
- PNGの目標512/1024/2048pxに対し、セル幅を整数へ切り下げるため実サイズは異なり得る。画面は実pxと300dpi換算mmを表示する。
- SVGも余白を含む単体データ。保存名はサニタイズしたhostnameを使い、ホストが取れなければ`qr`。保存用Blob URLは10秒後に解放する。

## 保存・外部送信・ライセンス

外部通信、解析、独自サーバー、URLの永続ストレージは実装していない。CSPはselfのみ。生成画像の保存先と、明示コピーしたクリップボードにはURLが残るため、秘密付きURLの共有は秘密自体の共有になる。popupの終了は保存物の削除ではない。
同梱ライブラリの著作権/MIT条件は[LICENSES.txt](../LICENSES.txt)に残し、バンドラ導入や圧縮で消さない。

## 変更時の検証条件

- [core.test.mjs](../tests/core.test.mjs): URL/UTF-8長の分類、整数セル/余白、SVGとQR構造。
- [policy.test.mjs](../tests/policy.test.mjs): activeTab以外の権限、外部コード/通信、manifest参照、CSPとライセンスの混入/欠落を検出。
- [e2e-popup.mjs](../tests/e2e-popup.mjs): 合成`chrome.tabs`応答とローカルpopupで、全文表示・保存・エラー・外部リクエストを確認する条件。実タブの履歴は使わない。
- Nodeは`npm run test:unit`、ブラウザは`npm run test:e2e`。実行用Playwrightは[package.json](../package.json)の開発依存で、製品のランタイムには含めない。
- 今回は文書変更のみでNode/ブラウザテストを実行していない。過去のREADMEにある成功件数を再検証結果として扱わない。実機スキャンや配布審査も今回の確認範囲外。
