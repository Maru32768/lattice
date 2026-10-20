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

## 2. 使ってみての要望（2026-10-20）

UI 全面改修（4 層モデル: scope・facet・一覧・文書）のあとで出た要望。G1〜G27 は今回の改修で対応する（**進行中**）。G28 以降は後で着手する。

| # | 項目 | 状態 | 方針 |
|---|---|---|---|
| G1 | 日本語の記事が全部日本語で表示される | 進行中 | 記事の言語を判定し、日本語の記事は英語に訳す。混在 N% は「もう一方の言語」の割合になる。アプリ内ブラウザも同じ。 |
| G2 | 手動追加の記事がジャンル分類されない | 進行中 | 自動分類の導入前に保存した記事に classify job がなかった。起動時に未分類の記事を分類キューに入れる。 |
| G3 | タグ等の popover が一瞬左上に出る | 進行中 | 描画前に位置を決める。 |
| G4 | ペイン幅をドラッグで調節 | 進行中 | nav・一覧・文書・対話の間に区切りを置き、幅を保存する。 |
| G5 | Page 表示で切り替えると前のページが一瞬見える | 進行中 | 遷移中は native webview を隠し、読み込み後に表示する。 |
| G6 | アプリアイコン | 進行中 | 格子のアイコンを作り、ウィンドウ・タスクバー・アプリ左上で使う。 |
| G7 | Page 表示で select を開くとページが真っ白になる | 進行中 | popover を一覧ペイン内に収め、webview と重なるときだけ隠す。 |
| G8 | 戻る / 進むを履歴がないときは無効に | 進行中 | ページから `canGoBack` / `canGoForward` を通知する。 |
| G9 | ショートカットの変更・1 つの操作に複数キー | 進行中 | 操作とキーの対応を 1 つの表にし、設定画面で編集する。 |
| G10 | 文書ペインのない画面で対話を開くと右に余白 | 進行中 | 管理画面が残りの幅を使う。 |
| G11 | README（英語・日本語） | 進行中 | 先頭で言語を切り替える。他人が使う前提でセットアップと設定を書く。 |
| G12 | フィード・記事に favicon | 進行中 | backend がドメインごとに取得して DB に保存し、`data:` URL で渡す。 |
| G13 | 矢印キーで移動 | 進行中 | j/k と同じ操作にする。 |
| G14 | tmux と同じキーでペイン移動 | 進行中 | `Ctrl+B` の後に矢印・h/j/k/l・o。 |
| G15 | Page のツールバーがはみ出すと右側を押せない | 進行中 | はみ出したら横スクロール。 |
| G16 | 開いている記事を選ぶと再読み込みされる | 進行中 | 同じ記事・同じ表示なら何もしない。 |
| G17 | 既読の条件 | 進行中 | 開いたら既読にするが、scope か facet を変えるまでは未読一覧に残す。 |
| G18 | 記事の削除（Index から削除） | 進行中 | 確認ダイアログつき。記事にぶら下がるデータをすべて消す。 |
| G19 | AI プロバイダの順序をドラッグで変更 | 進行中 | dnd-kit。 |
| G20 | `aside` が翻訳されない | 進行中 | アプリ内ブラウザの翻訳対象から外していた。記事中の補足ボックスは本文として扱う。 |
| G21 | 訳したセンテンスの点線が邪魔 | 進行中 | 点線をやめ、hover の背景だけ残す。 |
| G22 | select の文字が上寄せ | 進行中 | 上下中央にする。 |
| G23 | popover を開いているときは j/k で中を移動 | 進行中 | 開いている間はグローバルなキー操作を止める。 |
| G24 | j/k で選ぶ → Enter で開く | 進行中 | 一覧にカーソルを持ち、Enter で開く。 |
| G25 | 翻訳プロンプトを UI で調節 | 進行中 | 設定 › 翻訳 に「追加の指示」。指示を変えたら訳をキャッシュから使わない。 |
| G26 | カスタムタイトルバー | 進行中 | ウィンドウの枠を消し、アプリが描くタイトルバーにする。 |
| G27 | 環境変数を mise で管理 | 進行中 | `mise.local.toml`（git 管理外）に API キーを書く。 |
| G28 | 英語レベル（CEFR A1〜C2） | 後 | レベルを設定し、翻訳に使う。案: 翻訳時に各文がレベルを超えるかを LLM に判定させ、混在モードに「レベル基準」を足す。または訳文の語彙・注釈をレベルに合わせる。 |
| G29 | 再翻訳 | 済 | Reader の ⋯ と、全部訳し終えたときの翻訳状況の横に「訳し直す」。今の訳先（cache key）の訳をこの記事の段落の分だけ消して translate job を積み直す。50 block を超えるときだけ確認する。 |
| G30 | ライセンス表記 | 済 | `LICENSE`（MIT）と `THIRD_PARTY_NOTICES.md`（Mazelingo の MIT 表記、同梱フォントの OFL）。依存ライブラリのライセンス一覧の自動生成は G41 と一緒に行う。 |
| G31 | 論文 PDF の取り込み | 後 | PDF からテキストと構造を抽出して IR に変換する。 |
| G32 | 理解度チェックのクイズと間隔反復 | 後 | 記事ごとにクイズを生成する。繰り返し出題は手動で追加した記事だけ。再出題の間隔は Anki（SM-2 系）に合わせ、最短間隔は要調整。 |
| G33 | ブラウザのタブ | 後 | 複数ページを開いておき、すぐ切り替える。 |
| G34 | Page ペインの分割 | 後 | 複数の Page ペインを横・縦に自由に並べる（tmux のように）。G33 と合わせて設計する。 |
| G35 | 技術書の取り込み | 将来 | G31 の延長。 |
| G36 | URL バーから検索 | 済 | Page のツールバーの URL をクリックすると全体を選択した入力欄になり、Enter で開く・Esc で戻す。`http(s)://` で始まる入力はそのまま、ホストらしい入力（`example.com/x`・`localhost:3000`・IP）は `https://` を付けて開き、それ以外は検索する（`toNavigation`）。設定「ブラウザ」で検索エンジン（DuckDuckGo（既定）・Google・Bing・Brave Search・Kagi・`%s` を含むカスタム URL）を選ぶ。再読み込みの隣にホームボタン（エンジンのトップページ）。 |
| G37 | 更新通知とアプリ内アップデート | 後 | Tauri updater。G41 のリリースフローが前提。 |
| G38 | データ保存先の変更 | 後 | 今は `%APPDATA%\dev.lattice.app`。インストーラーを使わない配布（zip・単体 exe）なら exe と同じフォルダを既定にする案もある。要検討。 |
| G39 | 単体テスト・E2E テストの強化 | 後 | E2E は今の mock IPC harness を土台にできる。 |
| G40 | CI でテスト | 後 | GitHub Actions（Windows runner）で `mise run test`。 |
| G41 | リリースフロー | 済 | バージョンは `package.json`・`package-lock.json`・workspace の `Cargo.toml`（両 crate が継承、`tauri.conf.json` は持たない）・`Cargo.lock` にあり、`npm run bump -- <x.y.z>` で揃え、`npm test` がずれを検出する。`CHANGELOG.md`（Keep a Changelog）。`v*` タグで `.github/workflows/release.yml` が NSIS インストーラー・portable zip・`THIRD_PARTY_LICENSES` を draft release に載せる（署名鍵の secret があれば updater 用の `.sig` と `latest.json` も）。ライセンス一覧は cargo-about と `scripts/licenses.mjs` で生成（`mise run licenses`）。手順は `docs/release.md`。 |
| G42 | 静的解析 | 後 | clippy（`-D warnings`）、ESLint、型チェックを CI に入れる。 |
| G43 | 対話の入力欄で Vim キーバインド | 後 | |
| G44 | アプリ全体を Vim 風に操作 | 後 | Chrome の Vimium のように、リンクのヒント表示などで操作する。G9 のキー設定の上に作る。 |
| G45 | モデルごとの effort 設定 | 済 | chain の各段に任意の effort（`low`〜`max`、Gemini は `low`〜`high`）。Claude CLI `--effort`、Codex CLI `model_reasoning_effort`（既定は従来どおり low）、OpenAI `reasoning.effort`、Anthropic `output_config.effort`、Gemini `thinkingConfig.thinkingLevel`。未指定は provider の既定で、保存済みの chain はそのまま読める。 |
| G46 | タスクバーに未読数バッジ | 済 | 未読数を描いた画像を Windows の overlay icon にする（99+ まで、0 で消す）。UI の未読数の変化を 500 ms まとめて backend に渡す。設定「タスクバー」でオフにできる（design-review §16）。 |
| G47 | スマホから使える簡易版 | 将来 | 同期の仕組みが前提（R2 バックアップの延長か、別の仕組みか）。 |
| G48 | Markdown の取り込みと表示 | 済 | インポート画面の「Markdown」タブで、ファイルか貼り付けたテキストを 1 つの記事にする（pulldown-cmark で IR に変換、HTML タグは捨てる）。URL の代わりに `local:md/<sha256>` を持ち、同じ本文は重複しない。Page・再試行・描画はなし。URL の画像は保存し、相対パスの画像は選んだファイルのフォルダからだけ読む（design-review §5）。 |
| G49 | 対話・要約のカスタム指示 | 済 | 設定 › 要約・対話 に全体共通の「自分について」（2000 文字まで）と、要約・対話それぞれの追加の指示。system prompt の組み込みの規則の後、untrusted input の注意の前に入れる。指示を変えると作成済みの要約を stale として表示する。 |
| G50 | Page 表示でページにフォーカスがあるとショートカットが効かない | 済 | アプリが転送するキーの一覧（`pageKeys`）を backend 経由で overlay に渡し（起動時・ページ読み込み時・変更時）、overlay がページの keydown（capture）で拾って `overlay_key` で送る。`Ctrl+K`・`Ctrl+B` とその次のキーはページの入力欄からも送り、ページには渡さない。j / k・s・m・v・[ ] などはページの入力欄の外でだけ、ページが `preventDefault` しなかったときに送る。Enter・Esc・矢印・Space はページのもの。パレット・検索・Reader への切り替え・ペイン移動はフォーカスをアプリに戻す。 |

## 3. 要件定義の未実装項目

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

### 対話の広い範囲（検討中）

F9 の対話は範囲に数千記事を指定できるが、LLM に渡すのは hybrid search の上位 30 block（約 40,000 字）だけ。範囲外の資料を使えないので、「このテーマについて何が分かっているか」（§24）のような網羅型の質問に弱い。上位が 2〜3 記事に偏りやすいのも原因の一つ。NotebookLM のように数百ソースを横断して答えられるようにしたい。

| 案 | 状態 | 内容 | 代償 |
|---|---|---|---|
| 上限を上げる | 後 | `chat.rs` の `MAX_CONTEXT_CHARS` を数十万字、`TOP_K` を 100〜200 にする。定数の変更だけで済む。 | 1 回の質問のコストと待ち時間が比例して増え、CLI の usage limit に当たりやすくなる。1 回あたりの規模の上限を決める必要がある。 |
| 1 記事あたりの block 数を制限する | 後 | `retrieve()` で記事ごとに最大 3 block などに絞り、多くの記事から集める（MMR に近い）。「上限を上げる」と組み合わせる。 | 1 記事を深く読む質問では根拠が減る。 |
| 2 段階（map-reduce） | 後 | 範囲内の各記事の要約で関係する記事を選ばせ、選んだ記事の本文 block で回答させる。 | 全記事に要約が必要。今の要約は Reader から手動で作るだけなので、要約の自動生成と既存記事への backfill が先に要る。 |
| LLM に検索を繰り返させる（agentic） | 将来 | アプリ内の検索を読み取り専用の tool として渡し、LLM が何度も検索してから答える。 | 「untrusted な記事を扱う LLM に tool を渡さない」方針の見直しが要る。CLI provider で自前の tool を渡すのは難しく、作業量が最も大きい。 |

最初の 2 案を同時に入れ、網羅型の質問で足りなければ 2 段階に進むのが第一候補。

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
