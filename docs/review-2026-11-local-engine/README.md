# ローカルの翻訳エンジン(M1)のレビュー記録

設計はdesign-review §35。実装(`9f350b1..d7c855d`の6コミット)を、review-loopスキルで回した。回ごとに、サブエージェントが次の2つの観点で別々にレビューし、親(このレビューを回したセッション)が指摘を再現してから直した。指摘が残る間は、前の回の修正とその影響先を中心に繰り返した。収束したあとで、別のモデル(FableとCodex)に1回ずつ読ませ、Fableの指摘を直した差分にもう1回かけた。最後にponytail-review、simplify、文書の推敲(prose-polish)と最終確認をかけた。

- `correctness`: 実装の誤り、設計との食い違い、影響先
- `test-quality`: 意味のないテスト、検証されていない振る舞い、変異(mutation)と性質の検証

この記録は、指摘を人手で見なくても検出できる仕組み(lint、テスト、CIのチェック、エージェントへの指示)を作るときの材料にする。そのため、指摘ごとに「何があれば機械的に見つかったか」を残す。

## `findings.tsv`の列

| 列 | 内容 |
|---|---|
| `id` | 通し番号 |
| `milestone` | ロードマップの項目(M1) |
| `round` | 何回目のレビューか。`fable`・`codex`は収束後の別モデルのレビュー、`5`はFableの指摘を直した差分のレビュー、`ponytail`・`simplify`・`prose`は片づけと推敲、`final`は最終確認 |
| `reviewer` | `correctness`・`test-quality`・`both`(両方が見つけた)・`fable`・`codex`・`ponytail-review`・`simplify`・`prose-polish`・`final-check`・`parent`(依頼元が挙げたもの) |
| `commit` | レビューした範囲の先頭のコミット |
| `severity` | `high`・`medium`・`low`(Must・Should・Couldに当たる) |
| `category` | `correctness`・`security`・`test-coverage`・`performance`・`ux`・`docs`・`i18n`・`simplification`など |
| `file` | 場所(`path:line`)。行番号はレビューしたときのもの |
| `summary` | 指摘の内容 |
| `outcome` | `fixed`・`dismissed`・`deferred` |
| `resolution` | 直したコミットか、直さなかった理由 |
| `caught_by` | 機械的に見つけるなら何か(`unit-test`・`property-test`・`mutation`・`e2e`・`lint`・`benchmark`・`agent-brief`・`none`) |
| `harness_idea` | その仕組みの具体案 |

`summary.md`は、回ごとの指摘数と、全体から読み取れる傾向をまとめる。数は`findings.tsv`からスクリプトで数えた。
