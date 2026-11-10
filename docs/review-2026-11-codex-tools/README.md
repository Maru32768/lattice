# Codex CLIのtoolの締め出しのレビュー記録

Codex CLI 0.164.0は、Latticeがtool featureをすべて無効にしても、モデルに`clock.sleep`と`collaboration.*`(サブエージェントの起動など)を見せていた。model catalogが、feature flagと関係なくcode modeとサブエージェントを有効にするためだった。修正(`crates/lattice-core/src/codex.rs`)のあと、サブエージェントが次の2つのスキルでレビューし、指摘が出る間は繰り返す。

- `code-review`: 正しさのバグ
- `ponytail:ponytail-review`: ロジック・安全性・負荷・テスト・要らないコード

この記録は、指摘を人手で見なくても検出できる仕組みを作るときの材料にする。列は[review-2026-11-mobile](../review-2026-11-mobile/README.md)と同じ。

## 傾向

- 1回目の9件のうち5件は、新しく足したテストが本当に確かめたいものを見ていないという指摘だった(既定のモデルだけ、使われないcatalog、名前の読み落とし、見えない種類のtool)。外部のCLIの出力を読むテストは、入力を変えると結果が変わることを一度は確かめないと、何も見ていなくても通る。
- 2件はCodexの版の違いから来ていた。`--disable`は知らない名前で失敗し、`-c`は知らないキーを黙って無視する。どちらの形で渡すかで、古い版で壊れるか、新しい版で黙って効かなくなるかが決まる。
