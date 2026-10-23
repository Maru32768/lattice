# テスト監査の対応結果

元の[463件台帳](ledger.md)の14項目・20テストへの対応。監査IDを維持し、現在の実行箇所を以下へ記録する。

検証: Node 121件、Playwright 130件、Rust 214件成功・1件ignore。抜粋の変異2種は修正後のassertionで失敗することを確認。型検査・変更箇所のlint/formatも成功。

| 課題 | 状態 | 変更と現在の検証箇所 |
| --- | --- | --- |
| <a id="F01"></a>F01 | 対応済み | 実際のfont-family・loaded face・必要glyphを初回frameで検証。冷cacheでfont取得を遅延させた負例も追加。固定500ms待機を除去。 [e2e/shell.spec.ts:41](../../e2e/shell.spec.ts#L41)、[e2e/shell.spec.ts:53](../../e2e/shell.spec.ts#L53) |
| <a id="F02"></a>F02 | 対応済み | 抜粋の正確な内容・長さ・両端・無hit・複数語を検証。全文返却と後続hit優先の両変異を拒否。 [src/search/search.test.ts:16](../../src/search/search.test.ts#L16) |
| <a id="F03"></a>F03 | 対応済み | コピー項目を実クリックし、Chromium clipboardから未保存URLを読み戻して確認。 [e2e/shell.spec.ts:202](../../e2e/shell.spec.ts#L202) |
| <a id="F04"></a>F04 | 対応済み | Rustをtoken化し、コメント・文字列内の見かけの呼出し・cfg(test)を除外。core/CLI/Tauriを再帰走査。動的field codeは明示契約として検証。 [src/i18n/backend.test.ts:35](../../src/i18n/backend.test.ts#L35)、[scripts/rust-messages.test.mjs:5](../../scripts/rust-messages.test.mjs#L5)、[scripts/rust-messages.test.mjs:24](../../scripts/rust-messages.test.mjs#L24) |
| <a id="F05"></a>F05 | 対応済み | Node cryptoで独立計算したGET/DELETEの固定署名値へ変更。AWS既知vectorとURL/escapeのassertionは維持。 [crates/lattice-core/src/r2.rs:665](../../crates/lattice-core/src/r2.rs#L665) |
| <a id="F06"></a>F06 | 対応済み | Nodeのmock timersで静穏期間のreset、cap直前未完了・到達時完了を検証。実時間の許容幅とintervalを除去。 [src/overlay/overlay.test.ts:20](../../src/overlay/overlay.test.ts#L20)、[src/overlay/overlay.test.ts:40](../../src/overlay/overlay.test.ts#L40) |
| <a id="F07"></a>F07 | 対応済み | 設定送信・同一セッション再表示という実際の保証へ3テストを改名。DB耐久性は既存の境界記録を維持。 [e2e/chat.spec.ts:11](../../e2e/chat.spec.ts#L11)、[e2e/english.spec.ts:6](../../e2e/english.spec.ts#L6)、[e2e/i18n.spec.ts:3](../../e2e/i18n.spec.ts#L3) |
| <a id="F08"></a>F08 | 対応済み | 日本語の全19カテゴリを列挙し、実navigation全体の集合・順序と一致してから全見出しを確認。 [e2e/settings.spec.ts:25](../../e2e/settings.spec.ts#L25) |
| <a id="F09"></a>F09 | 対応済み | カスタム名を再設定してから空欄解除を操作し、元名/カスタム名/空欄のrename引数列を確認。 [e2e/feedname.spec.ts:27](../../e2e/feedname.spec.ts#L27) |
| <a id="F10"></a>F10 | 対応済み | 別窓化/復帰の名称を実操作へ修正し、chat窓の引用をクリックしてmainへのcitation payloadとnewTabを確認。 [e2e/popout.spec.ts:97](../../e2e/popout.spec.ts#L97)、[e2e/popout.spec.ts:105](../../e2e/popout.spec.ts#L105) |
| <a id="F11"></a>F11 | 対応済み | URL保存テストを改名。Pageへbrowser-titleを送り、題名表示と別tab開閉後の保持を確認。 [e2e/palette.spec.ts:36](../../e2e/palette.spec.ts#L36)、[e2e/tabs.spec.ts:91](../../e2e/tabs.spec.ts#L91) |
| <a id="F12"></a>F12 | 対応済み | 外側クリックの名称をapp DOM内へ限定。別のbrowser-focus分岐試験は維持。 [e2e/menus.spec.ts:67](../../e2e/menus.spec.ts#L67) |
| <a id="F13"></a>F13 | 対応済み | needsTranslation/translationProgressのhelper契約と分かる名称へ修正。TS/Rust一致まで保証する表現を除去。 [src/reader/mixed.test.ts:48](../../src/reader/mixed.test.ts#L48)、[src/reader/mixed.test.ts:56](../../src/reader/mixed.test.ts#L56) |
| <a id="F14"></a>F14 | 対応済み | 固定badgeをジョブ試験へ、mainのno-readyをmain shell試験開始へ移動。assertionを残して独立2シナリオを統合。 [e2e/jobs.spec.ts:6](../../e2e/jobs.spec.ts#L6)、[e2e/shell.spec.ts:250](../../e2e/shell.spec.ts#L250) |

本番のnative窓・IPC配送、DB再起動の耐久性、TS/Rust共通corpusは引き続き[境界記録](boundaries.md)の範囲。今回の名称修正はその保証を拡張していない。R2期待値はregion=auto、service=s3、20130524T000000Z、空body、既存fixtureのpath/queryからNode cryptoで独立計算した。

元のinventory・input-hashes・実行結果は監査当時の記録として保持した。修正対象の現在位置は本表、構造化した対応・ログhashは[remediation.json](remediation.json)を参照。旧probes.mjsは、現在のassertionが全文返却・後続hit優先の変異を拒否する確認へ更新した。

Rustの初回並列ビルドはメモリ不足で失敗したため、ブラウザテスト終了後にcargo test --workspace -j 1で成功を確認した。通常sandboxではSchannel資格情報エラーが出るため、前回同様の承認済み実行を使用した。
