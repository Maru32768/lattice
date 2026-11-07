# スマホ閲覧(G47)のレビュー記録

設計はdesign-review §32。実装の段階(M1〜M4)ごとに、サブエージェントが次の2つのスキルでレビューし、指摘が多い間は同じ段階を繰り返す。

- `code-review`: 正しさのバグ
- `ponytail:ponytail-review`: ロジック・安全性・負荷・テスト・要らないコード

この記録は、指摘を人手で見なくても検出できる仕組み(lint、テスト、CIのチェック、エージェントへの指示)を作るときの材料にする。そのため、指摘ごとに「何があれば機械的に見つかったか」を残す。

## `findings.tsv`の列

| 列 | 内容 |
|---|---|
| `id` | 通し番号 |
| `milestone` | M1〜M4 |
| `round` | その段階の何回目のレビューか |
| `reviewer` | `code-review`か`ponytail-review` |
| `commit` | レビューした範囲の先頭のコミット |
| `severity` | `high`・`medium`・`low` |
| `category` | `correctness`・`security`・`data-loss`・`test-coverage`・`simplification`・`ux`など |
| `file` | 場所(`path:line`) |
| `summary` | 指摘の内容 |
| `outcome` | `fixed`・`dismissed`・`deferred` |
| `resolution` | 直したコミットか、直さなかった理由 |
| `caught_by` | 機械的に見つけるなら何か(`unit-test`・`property-test`・`e2e`・`lint`・`type`・`agent-brief`・`none`) |
| `harness_idea` | その仕組みの具体案 |

`summary.md`は、段階ごとの指摘数と、全体から読み取れる傾向をまとめる。
