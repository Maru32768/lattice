# 実行結果と反例の再現

<!-- remediation -->
**修正後: 14項目・20テストの対応完了。[対応内容・現在のテスト位置・検証結果](remediation.md)。以下の件数・指摘本文は監査時点の記録。**

監査日: 2026-10-23（Asia/Tokyo）。[全件台帳](ledger.md) / [改善候補](findings.md) / [監査概要](README.md)

## 元のテスト群

以下は変更前の本番コード・既存テストでの成功結果。監査用mutationの3件はこの数に加えていない。

| コマンド | 結果 | 観測したrunner時間 |
| --- | --- | --- |
| `mise exec -- npm test` | 118成功、失敗0、skip0 | 約5.09秒 |
| `mise exec -- cargo test --workspace` | 214成功、失敗0、ignore1 | core 6.28秒、Tauri 0.20秒、CLI unit 0.18秒、CLI integration 1.37秒。ビルド等を含む総時間ではない |
| `mise exec -- npm run e2e -- --workers=4`（E2E_PORT=1443） | 130成功、失敗0。E2E用tscも成功 | 約2.1分 |

保持したログからの抜粋:

```text
Node:
  tests 118 / pass 118 / fail 0 / skipped 0

Rust:
  26 passed; 0 failed; 0 ignored    (Tauri)
   6 passed; 0 failed; 0 ignored    (CLI unit)
   7 passed; 0 failed; 0 ignored    (CLI integration)
 175 passed; 0 failed; 1 ignored    (core)
  doc-tests: 0 tests

Playwright:
  Running 130 tests using 4 workers
  130 passed (2.1m)
```

ignoreは[T035 / live_codex_exec](../../crates/lattice-core/src/codex.rs#L183)。有償の実Codex呼び出しで、通常workspace testでは実行されない。今回も`--ignored`を指定していない。

元ログはリポジトリのignore対象である`.local/test-audit-node.log`、`.local/test-audit-rust-full.log`、`.local/test-audit-e2e.log`に残した。共有用の本文には上記要約を記録し、[execution-results.json](execution-results.json)にはログhashと宣言別の突合結果を残す。[verify-results.mjs](../../scripts/test-audit-2026-10-23/verify-results.mjs)で、Nodeは名前、Rustはmodule付き名前、Playwrightはfile:lineを台帳と照合する。単に合計件数が同じかだけを比較していない。

## 実行環境上の回避策

初回cargo実行はsandbox内のネットワーク/Schannel資格情報エラーで依存解決できず、offlineでは`base64`のcache不足になった。通常sandboxを越えた同じ`cargo test --workspace`の実行が承認され、上記の成功結果を得た。最初の環境エラーをテスト失敗とは数えていない。

Playwrightの設定はwebServerコマンドに`npx vite -c e2e/vite.config.ts`を使う。この環境では`npx`がPATHから見つからなかったため、同じconfigのViteをNodeで先に立ち上げ、設定既定の`reuseExistingServer`で再利用した。アプリコード・テスト・Playwright configは編集していない。

PowerShellの別terminalで次を実行:

```powershell
$env:E2E_PORT = '1443'
mise exec -- node node_modules/vite/bin/vite.js -c e2e/vite.config.ts
```

テスト側terminal:

```powershell
$env:E2E_PORT = '1443'
mise exec -- npm run e2e -- --workers=4
```

通常`npx`が使える環境なら事前起動は不要。既存serverの再利用はこの作業用portで自分が起動したserverに限定した。外部サービスへのlive試験や、native Tauri起動を行ったという意味ではない。

## F01: 実フォントが未読込でも判定式がtrue

[probes.mjs](../../scripts/test-audit-2026-10-23/probes.mjs)は新しいChromium contextでfontファイルをabortし、実UIを開いてメニューを表示する。空のbutton集合による自明な成功ではないこともassertする。

実行結果:

```json
{
  "buttons": 6,
  "assertedFont": true,
  "actualFamily": "\"Noto Sans JP Variable\", \"Noto Sans JP\", \"Hiragino Sans\", \"Yu Gothic UI\", Meiryo, system-ui, sans-serif",
  "loadedNotoFaces": 0,
  "nonexistentFontCheck": true
}
```

`assertedFont`は元テストと同じ`IBM Plex Sans JP`の`document.fonts.check`式。必要なNoto faceのloaded数は0で、架空フォントでもtrueだった。従って「この式がtrueならNotoの文字が読み込み済み」という推論が成立しない。

このprobeは元harnessを使わない。フォントのabortはconsole errorを起こし得るため、**元テスト全体がネットワーク遮断下でも成功したという実証ではない**。初回frameの可読性やfallbackの視覚品質を測ったものでもない。対象を間違えたassertionの検出力を調べたもの。

## F02: 切り詰めないexcerptで元assertionが成功

同じprobeは元`src/search/search.test.ts`を`.local/test-audit-excerpt-mutant.test.ts`へコピーし、`excerpt`のimportだけを次の変異実装へ置換する。他の4関数は本番をimportしたまま。元の本番ファイルとテストは変更しない。

```javascript
const excerpt = (text, terms, max = 220) =>
  text.length <= max
    ? text
    : terms.some(t => text.toLowerCase().includes(t.toLowerCase()))
      ? '…' + text + '…'
      : text;
```

この関数は長文を一度も切り詰めない。元テストの1003文字入力・max=90に対しては1005文字を返す。それでも元assertionを残したコピーの結果は次のとおりだった。

```text
EXCERPT_MUTANT 0
✔ highlight is case-insensitive and regex-safe
✔ excerpt centers on the first hit
✔ hits: method filters by match source, scope by article; grouped by article in rank order
tests 3 / pass 3 / fail 0
```

元のテスト全体を実行した変異検証であり、F01の式単体probeとは証拠の範囲が違う。監査用3件を通常テスト462成功へ加算しない。

## 再現と資料整合確認

上記Viteを起動した状態で、リポジトリルートから:

```powershell
$env:E2E_PORT = '1443'
mise exec -- node scripts/test-audit-2026-10-23/probes.mjs
mise exec -- node scripts/test-audit-2026-10-23/inventory.mjs
mise exec -- node scripts/test-audit-2026-10-23/build-ledger.mjs
mise exec -- node scripts/test-audit-2026-10-23/verify-results.mjs
```

最後のコマンドは上記3ログがローカルにある場合に使う。共有先で再実行する際は同じ名前でrunner出力を保存する。入力コードを変更済みなら、まず監査内容を再評価する。probeの成功は「既存の弱点を再現した」ことを意味し、製品機能の合格を意味しない。Viteは確認後にCtrl+Cで終了する。

監査資料の最終確認では、463宣言の結果突合、806リンクの参照先/明示anchor/行番号範囲、監査入力hashの一致を確認した。追加した`scripts/test-audit-2026-10-23`の6スクリプトは、既存設定を用いたoxlint（`--deny-warnings`）とPrettier checkも成功した。リポジトリ全体のlint成功という主張ではない。

全件のbranch coverageや全件mutation scoreは測定していない。F03以降の反例候補は、明記したもの以外はソースのassertionと呼出し経路からの判断で、変異実行済みとは扱っていない。
