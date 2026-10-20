[English](README.md) | **日本語**

# Lattice

Lattice は、技術記事を集めて読み、検索するためのローカル中心のデスクトップアプリです。記事の本文は手元の PC に保存します。翻訳と要約には自分で選んだ AI プロバイダを使い、どの記事も原文と訳文を混ぜて読めます。

- **集める。** URL を保存する、アプリ内ブラウザで読んでいるページを追加する、RSS / Atom フィードを登録する、ブックマーク・CSV・JSON など URL を含むテキストを一括インポートする、のどれでも取り込めます。JavaScript で描画するページは描画してから保存します。
- **読む。** Reader は抽出した本文を表示します。原文・訳文・混在（割合を調節できる）を切り替えられ、block ごとに反転もできます。Page 表示は元のページを表示し、同じ翻訳を重ねます。
- **整理する。** ジャンル・タグ・難易度は自動で付き、手で変えられます。一覧は scope（未読・お気に入り・ジャンル・フィード）を選び、facet（タグ・ソース・難易度・状態）を重ねて絞り込みます。
- **検索する。** 全文検索と意味検索を組み合わせた hybrid 検索なので、日本語の検索語で英語の箇所も見つかります。結果は記事の中の一致した block を指します。
- **質問する。** 対話ペインは保存した記事をもとに回答し、引用から根拠の block に移れます。
- **残す。** データはすべて 1 つの SQLite ファイルにあります。ローカルバックアップ、JSON エクスポート、Cloudflare R2 への自動バックアップがあります。

## 必要なもの

- WebView2 のある Windows 10 / 11（Windows 11 には最初から入っています）。Windows で開発しています。macOS・Linux でのビルドは未確認です。
- [mise](https://mise.jdx.dev/)。`mise.toml` で固定した Node.js と Rust を入れます。
- Visual Studio 2022 Build Tools 17.10 以降（MSVC 14.4x）と「C++ によるデスクトップ開発」ワークロード。意味検索で使う ONNX Runtime が必要とします。
- 翻訳・要約・分類・対話には AI プロバイダが 1 つ以上要ります（[AI プロバイダ](#ai-プロバイダ)を参照）。保存・閲覧・全文検索はなしで使えます。

## はじめ方

```bash
git clone https://github.com/Maru32768/lattice.git
```

```bash
cd lattice
```

```bash
mise install
```

```bash
mise exec -- npm install
```

```bash
mise run dev
```

`mise run dev` はホットリロードつきでアプリを起動します。初回は Rust のビルドに数分かかります。

インストーラーと単体の実行ファイルを作るには:

```bash
mise exec -- npm run tauri build
```

`target/release/bundle/` に出力されます。

## 設定

設定はほとんどアプリ内にあります（サイドバー左下の歯車）。

### AI プロバイダ

設定 › AI プロバイダ で、最大 3 つのプロバイダを fallback chain として並べます。先頭から順に使い、呼び出しが失敗したら（usage limit など）次に移ります。失敗したプロバイダは 5 分間後回しにします。

| プロバイダ | 必要なもの |
|---|---|
| Claude CLI | `PATH` 上の `claude` コマンド（ログイン済み） |
| Codex CLI | `PATH` 上の `codex` コマンド（ログイン済み） |
| OpenAI API | `OPENAI_API_KEY` |
| Gemini API | `GEMINI_API_KEY` |
| Anthropic API | `ANTHROPIC_API_KEY` |

API キーはアプリ内（設定 › AI プロバイダ）に保存できます。保存したキーはローカルの DB に入り、バックアップとエクスポートには含めません。保存していなければ環境変数を読みます。

環境変数で管理する場合は、リポジトリ直下の `mise.local.toml` に書きます。mise が自動で読み込み、git は無視します。例から作ってください:

```bash
cp mise.local.toml.example mise.local.toml
```

使うキーを書き込めば、`mise run dev` がアプリに渡します。

記事の本文は信頼できない入力として扱います。AI プロバイダには tool を渡しません。CLI プロバイダは tool・MCP サーバー・ユーザー設定を無効にし、空の一時ディレクトリで実行します。

### 意味検索

意味検索は multilingual-e5-small モデル（約 470 MB）をローカルで動かします。初めて使うときにダウンロードし、準備ができるまでは全文検索の結果だけを表示します。

### バックアップ

- **ローカル。** 設定 › バックアップ で DB のコピーを作り、指定した世代数だけ残します。
- **エクスポート。** 設定 › エクスポート で記事・訳文・要約・タグ・フィード・対話を gzip した JSON Lines で書き出します。
- **Cloudflare R2。** 設定 › クラウドバックアップ で、圧縮したバックアップを定期的にアップロードします。bucket と API トークンは [`infra/r2`](infra/r2/README.md) の Terraform で作れます。

### データの保存場所

データはすべて 1 つの SQLite ファイル `%APPDATA%\dev.lattice.app\lattice.db` にあります。同じフォルダに `backups\`・`exports\`・意味検索のモデル（`models\`）があります。ログは `%LOCALAPPDATA%\dev.lattice.app\logs\` です。正確なパスは 設定 › ログ・保存場所 に表示されます。

## キーボード

`Ctrl+K` でコマンドパレットを開きます。記事・タグ・ソース・ジャンルを開く、コマンドを実行する、検索する、貼り付けた URL を開く・保存する、ができます。設定 › ショートカット にすべてのショートカットがあり、変更できます。

## 開発

```bash
mise run test
```

`mise run test` は overlay をビルドし、Rust とフロントエンドのテストを実行し、フロントエンドを型チェックしてビルドします。

| パス | 内容 |
|---|---|
| `crates/lattice-core` | Tauri に依存しないドメインロジック: 取得・抽出・保存・ジョブ・翻訳・検索・対話・バックアップ。 |
| `src-tauri` | Tauri アプリ: コマンド、バックグラウンドの runner、アプリ内ブラウザ。 |
| `src` | React のフロントエンド。 |
| `src/overlay` | アプリ内ブラウザのページに注入するスクリプト（翻訳 overlay、ページの snapshot）。 |
| `infra/r2` | R2 バックアップ用 bucket の Terraform。 |
| `docs` | 設計メモ（`design-review.md`）とロードマップ（`roadmap.md`）。 |

## ライセンス

MIT です（[LICENSE](LICENSE)）。[Mazelingo](https://github.com/Yeq6X/mazelingo) のコードを移植しており、SIL Open Font License のフォントを同梱しています。詳しくは [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照してください。
