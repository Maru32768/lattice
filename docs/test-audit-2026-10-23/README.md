# テスト価値監査・台帳

<!-- remediation -->
**修正後: 14項目・20テストの対応完了。[対応内容・現在のテスト位置・検証結果](remediation.md)。以下の件数・指摘本文は監査時点の記録。**

2026-10-23の作業ツリーにある**112ファイル・463テスト宣言**を確認した。実際のassertion、fixture、モック、本番の呼び出し先を照合し、**14項目・20テスト**を改善候補にした。既存コード・テストの削除や修正は行っていない。

最も先に直すべきなのは、実フォントと違う名前を検証するメニューテストと、全文を返す変異実装でも通る検索抜粋テスト。どちらも合格の意味が要求より弱いことを再現した。単に短いテストや同じ機能を扱う別レイヤーのテストを低価値と数えてはいない。

## 読む資料

| 資料 | 内容 |
| --- | --- |
| [全件台帳](ledger.md) | 463件の宣言位置・原題・実際に守るもの・判断。ファイルごとの本番接続先、モック境界、重複判断 |
| [改善候補](findings.md) | 14項目の根拠、対象20件、優先度、代替保証、対応完了条件 |
| [本番経路・重複の評価](boundaries.md) | 実行される層、途切れる境界、許容するモック、追加すると価値のある試験 |
| [実行結果・反例](evidence.md) | 全runnerの実行結果、再現した2件、再実行手順と環境上の回避策 |
| [構造化台帳](ledger.json) | 全件の境界・判断・対応案・実行結果・未着手状態。file + nameで後続作業と照合可能 |

## 件数と判断

| レイヤー | 宣言 | 成功 | ignore |
| --- | ---: | ---: | ---: |
| Rust core | 176 | 175 | 1 |
| Rust Tauri | 26 | 26 | 0 |
| Rust CLI unit | 6 | 6 | 0 |
| Rust CLI integration | 7 | 7 | 0 |
| Node（frontend・scripts・mock名照合） | 118 | 118 | 0 |
| Playwright（実UI＋モックbackend） | 130 | 130 | 0 |
| 合計 | **463** | **462** | **1** |

| 判断 | テスト数 | 意味 |
| --- | ---: | --- |
| 維持 | 442 | 現時点で削除・統合を正当化する代替保証を認めない |
| 維持・任意疎通 | 1 | 有償Codex実呼び出しのignore試験。今回未実行 |
| 補強 | 8 | 守りたい契約は有用だが、oracleや入力分岐を強める |
| 範囲・名称修正 | 10 | 実際の保証を残し、過大な名称・説明を直す。必要な未検証経路は別途追加 |
| 統合候補 | 2 | assertionを既存シナリオへ移し、独立した画面初期化を省ける |

**無条件で削除してよいと判断したテストは0件。** F14の2件もassertionを捨てる提案ではない。14項目は改善課題の数、20件は一意な対象テストの数で、全て対応未着手。

## 優先順位

1. **P1: F01・F02** — 誤った対象を検証するoracle、重大に弱いoracleを修正する。反例が修正後に落ちることを完了条件にする。
2. **P2: F03・F04・F06・F09** — コピーの実操作、使用中codeの判定、timer制御、空欄の解除を追加・補強する。
3. **P3: F05・F07・F08・F10〜F14** — 署名の独立期待値、保証範囲の名称、カテゴリ列挙、統合を整理する。

この優先度は**テスト改善の順序**であり、本番障害の深刻度ではない。テストが弱いことだけから本番に障害があるとは判断していない。

## 調査範囲と手順

- `src`、`e2e`、`scripts`のtest/spec宣言、`crates`と`src-tauri`のRust test宣言を列挙した。別のtest framework構文や対象外ディレクトリに試験がないかも検索し、runnerの実行件数と突合した。
- 全112ファイルのテスト本文と共通fixture/harnessを読み、テスト名ではなくassertionから各行の保証を記述した。主要な呼び出し先・本番adapter・モックの分岐を照合した。全本番ソースの網羅的なコードレビューとは異なる。
- 重複は「同じ機能名か」ではなく「同じ故障を同じ境界で検出し、代替可能か」で判断した。関連試験を消すと失う保証を各ファイル欄へ記録した。
- Rust、Node、Playwrightを実行した。再現性の高い問題2件は監査用probeで確認した。全件に対する網羅的mutation testingやstatement/branch coverage計測は実施していない。
- Playwrightは**130件すべてモックbackend**。実React画面・keyboard/pointer・localStorageを使う一方、Tauri IPC、native window、WebView2、SQLiteとの一続きの動作は実行していない。Rust/coreの実DB試験と合わせても、橋渡し部分の試験を自動的に満たすわけではない。
- 既存CIにあるbuild/lint/clippy全体を再実行したという報告ではない。今回の検証対象はテスト群と監査資料。`npm run e2e`に含まれるE2E型検査は成功した。

## スナップショットと再生成

基準HEAD: `ff8dd646be45a9a9a2eac1d90f4567f238d291fa`。監査開始時から未コミット変更があった`src/app/Palette.tsx`と`src/app/TitleBar.tsx`も、その作業ツリーの内容を接続先として確認した。この監査はそれらを変更していない。

[inventory.mjs](../../scripts/test-audit-2026-10-23/inventory.mjs)が宣言を抽出し、[review-data.mjs](../../scripts/test-audit-2026-10-23/review-data.mjs)が人手で確認した463件の要約と14課題を保持する。[profiles.mjs](../../scripts/test-audit-2026-10-23/profiles.mjs)が112ファイルの本番境界・重複判断を保持し、[build-ledger.mjs](../../scripts/test-audit-2026-10-23/build-ledger.mjs)がMarkdown/JSON台帳を生成する。[input-hashes.json](input-hashes.json)で監査入力を固定した。

リポジトリルートで実行:

```powershell
mise exec -- node scripts/test-audit-2026-10-23/inventory.mjs
mise exec -- node scripts/test-audit-2026-10-23/build-ledger.mjs
```

生成器は未記入・重複ID・存在しない参照先・入力hash変化をエラーにする。修正後は元のinventory/hashを凍結し、`scripts/test-audit-2026-10-23/record-remediation.mjs`で元のIDへ対応結果を記録する。元snapshotの再生成コマンドは、入力が変わっていれば出力を書き換える前に拒否する。新しい全件監査は別snapshotとして作成する。T001〜T463はこのsnapshot内のIDであり、修正でテストを統合しても対応台帳から追跡できる。
