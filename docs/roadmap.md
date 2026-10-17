# ロードマップ（未実装項目）

要件定義と 2026-10-17 時点の実装を突き合わせた未実装項目の一覧。実装済みの内容は `docs/design-review.md` を参照。

状態: **済** は実装済み（`docs/design-review.md` の該当節を参照）、**進行中** は着手済み、**次** は次に着手する、**後** は MVP 後でよい、**将来** は Phase 2 以降。

## 1. 使ってみての要望（2026-10-17）

| # | 項目 | 状態 | 方針 |
|---|---|---|---|
| F1 | 記事一覧クリック時に固まる | 済 | クリックした記事を即座に選択状態にし、ページの読み込み中はローディングを表示する。 |
| F2 | 「その他のモデル」が選べない | 済 | `SettingsView` の select が `custom` を選んでも preset 値のまま戻るバグ。F3 の設定 UI で作り直す。 |
| F3 | モデルの Fallback（最大 3 つ） | 済 | provider + model の組を 3 つまで並べ、1 つ目が usage limit などで失敗したら 2 つ目を使う。`LlmProvider` を実装する chain として作るので、domain 側は変わらない。 |
| F4 | Codex CLI / OpenAI API / Gemini API | 済 | §9。adapter を追加する。API key は DB の `settings` に `secret.` 接頭辞で保存し、バックアップからは除く。 |
| F5 | 自動分類 | 済 | LLM の `classify` job（§4.6）。記事にジャンルを付ける。ジャンルは既存ジャンルを優先して再利用させ、ユーザーが変更できる。 |
| F6 | RSS / Atom | 済 | §13。feed を登録し、定期的に取得して新着を ingest job に流す。 |
| F7 | 2 つの表示モード | 済 | 「feed ごと → その中でジャンルごと」と「ジャンルごと」を切り替える。 |
| F8 | 追加日時ソート | 済 | 一覧の並び順を 追加日時（新しい順／古い順）・公開日時 から選べるようにする。 |
| F9 | LLM との対話ペイン | 済 | NotebookLM のように、保存した記事を根拠に回答し、根拠の block を引用・ジャンプできる。スコープ（この記事／タグ／ジャンル／feed／全体）を指定する。全体のときは hybrid search で上位 block だけを渡す。 |
| F10 | Cloudflare R2 への自動バックアップ | 済 | bucket などは `infra/` の Terraform で管理する。アプリは S3 互換 API で `VACUUM INTO` のコピーを圧縮してアップロードする。API キーはユーザーが後で設定する。 |
| F11 | JS で描画するページの保存 | 済 | アプリ内ブラウザで開いているページは描画後の DOM を保存する（済）。bulk import / RSS の記事は非表示 webview で描画する（済）。 |

## 2. 要件定義の未実装項目

### MVP 後すぐ

| 項目 | 要件 | 状態 | 備考 |
|---|---|---|---|
| 検索の metadata filter | §6 UC6, §10 | 一部済 | 未読・お気に入り・タグ・ジャンル・feed は済。domain・期間は未着手。 |
| 再抽出コマンドと block ID の再利用 | §4.2, §6 | 済 | snapshot から再抽出し、`text_hash` が一致する block の id を再利用する。 |
| bulk import の同一ホスト宛て並列数の制限 | §15 | 済 | 同じホストへの同時取得を 1 本にする。 |
| job の一覧と再実行 UI | §4.6, §25 Observability | 済 | 失敗した job（job・記事・エラー・試行回数・時刻）を一覧し、再実行できる。 |
| エクスポート | §17 | 済 | 記事・訳・要約・対話を JSONL（gzip）で書き出す（design-review §10）。 |
| 画像の保存 | §26-10 | 済 | SQLite に保存し、Reader には `data:` URL で渡す（design-review §14）。 |

### LLM 処理

| 項目 | 要件 | 状態 | 備考 |
|---|---|---|---|
| タグ付け | §3 UC7 | 済 | F5 の分類と同じ job でタグ候補も出す。 |
| difficulty estimation | §3 UC7, §4.6 | 済 | Phase 3 の表示制御の入力になる。 |
| relevance estimation | §3 UC7, §12 | 後 | 「High relevance」inbox に使う。 |
| 要約の種類（short / detailed / key_points） | §4.4 | 後 | 今は normal だけ。 |
| technical term を英語のまま残すモード | §8 | 済 | 翻訳 prompt の option にする。 |
| Anthropic API provider | §9 | 済 | `anthropic.rs`（design-review §6）。 |
| Local Model provider | §9 | 後 | F4 の adapter と同じ形で追加できる。 |
| F9 のスコープに genre / feed | F9 | 済 | |

### 検索

| 項目 | 要件 | 状態 | 備考 |
|---|---|---|---|
| reranker | §10.3 | 将来 | |
| vector index（sqlite-vec / ANN） | §16 | 将来 | 10^6 block を超えたら。`Store::scan_embeddings` を差し替える。 |

### 収集

| 項目 | 要件 | 状態 | 備考 |
|---|---|---|---|
| Browser extension | §13 | 将来 | |
| Pocket / Raindrop import | §13 | 後 | 今の bulk import は URL を抜き出すので、export ファイルはそのまま読める。専用 import は tag・既読も取り込む場合に作る。 |
| GitHub trending / Hacker News / RSSHub | §13 | 後 | F6 の feed として登録できるもの（RSSHub など）はそれで足りる。 |
| Discord 通知 | §12 | 将来 | |

### Phase 2〜5

| Phase | 内容 | 状態 |
|---|---|---|
| 2 | Semantic Knowledge Base（全 block の embedding と自然言語検索） | 実装済み（hybrid search）。F9 の対話ペインで「資料群への問い合わせ」に近づける。 |
| 3 | Reading Personalization（理解度に応じた表示） | 将来 |
| 4 | Knowledge Graph（Concept と relation） | 将来 |
| 5 | Personal Knowledge Integration（既知・新規・矛盾の抽出） | 将来 |
