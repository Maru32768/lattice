# 要約の改善(J16)のレビュー記録

設計はdesign-review §38。2つのスライスに分けて実装し、それぞれをreview-loopスキルで回した。

- スライス1(`7ceabf25..945de963`): 要約の評価ハーネス(`crates/lattice-core/examples/summary_eval.rs`)。アプリが送る内容を変えずに、`summarize::request`と`chain::provider`を切り出した
- スライス2(`fcf0d17f..b26e8a0b`): 要約のpromptと入力の変更(`summary-v2`)と、文書・UIの文言

どちらのスライスも、先に片づけ(ponytail-review、simplify。スライス2では文書の推敲prose-polishも)をかけた。そのあと回ごとに、サブエージェントが次の2つの観点で別々にレビューし、親(このレビューを回したセッション)が指摘を再現してから直した。2回目からは、前の回の修正とその影響先を中心に見た。どちらのスライスも3回目にShouldが残ったので止め、利用者の判断でまとめて直した。そのあと別のモデル(FableとCodex)に1回ずつ読ませ、その修正の差分を追加で確かめてから、最終確認をかけた。

- `correctness`: 実装の誤り、設計との食い違い、影響先
- `test-quality`: 意味のないテスト、検証されていない振る舞い、変異(mutation)と性質の検証

この記録は、指摘を人手で見なくても検出できる仕組み(lint、テスト、CIのチェック、エージェントへの指示)を作るときの材料にする。そのため、指摘ごとに「何があれば機械的に見つかったか」を残す。

## `findings.tsv`の列

| 列 | 内容 |
|---|---|
| `id` | 通し番号 |
| `milestone` | ロードマップの項目とスライス(`J16-1`・`J16-2`) |
| `round` | 何回目のレビューか。`ponytail`・`simplify`・`prose`は片づけと推敲、`1`〜`3`は2つの観点のレビュー、`fable`・`codex`は別のモデルのレビュー、`followup`はその修正の差分の追加の確認、`final`は最終確認 |
| `reviewer` | `correctness`・`test-quality`・`both`(両方が見つけた)・`fable`・`codex`・`ponytail-review`・`simplify`・`prose-polish`・`final-check`・`parent`(親が挙げたもの) |
| `commit` | レビューした範囲の先頭のコミット |
| `severity` | `high`・`medium`・`low`(Must・Should・Couldに当たる。片づけと推敲は`low`) |
| `category` | `correctness`・`security`・`test-coverage`・`performance`・`robustness`・`ux`・`docs`・`simplification` |
| `file` | 場所(`path:line`)。行番号はレビューしたときのもの |
| `summary` | 指摘の内容 |
| `outcome` | `fixed`・`dismissed`・`deferred` |
| `resolution` | 直したコミットか、直さなかった理由 |
| `caught_by` | 機械的に見つけるなら何か(`unit-test`・`property-test`・`mutation`・`lint`・`agent-brief`・`none`) |
| `harness_idea` | その仕組みの具体案 |

`summary.md`は、回ごとの指摘数と、全体から読み取れる傾向をまとめる。数は`findings.tsv`からスクリプトで数えた。
