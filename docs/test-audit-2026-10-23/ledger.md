# 全テスト台帳（2026-10-23）

<!-- remediation -->
**修正後: 14項目・20テストの対応完了。[対応内容・現在のテスト位置・検証結果](remediation.md)。以下の件数・指摘本文は監査時点の記録。**

463宣言・112ファイルを対象に、各本文のassertion・入力・fixtureと本番側の接続を確認した記録。自動採点やテスト名だけの分類ではない。実行は462成功・1 ignore。

[監査結果](README.md) / [改善候補14項目・20テスト](findings.md) / [本番経路との境界](boundaries.md) / [実行・再現証拠](evidence.md) / [構造化台帳](ledger.json)

「維持」は完全性の認定ではなく、現時点で削除・統合の根拠を認めなかったという判断。「補強」も元の保証を捨てる提案ではない。各ファイルの境界・重複判断は配下の全行に適用する。試験名は原文を残し、「実際に守るもの」で射程を補正した。

| 判定 | 件数 |
| --- | ---: |
| 維持 | 442 |
| 維持・任意疎通 | 1 |
| 補強 | 8 |
| 範囲・名称修正 | 10 |
| 統合候補 | 2 |

## crates/lattice-cli/src/main.rs（1件）

本番の接続先: [crates/lattice-cli/src/main.rs](../../crates/lattice-cli/src/main.rs)。

境界: 実error出力値。プロセス起動はintegration側。

重複判断: core msgはコード化、CLI mainは公開JSON形状。別の出力境界。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T001"></a>[T001:116](../../crates/lattice-cli/src/main.rs#L116) | coded_errors_stay_structured | CLIエラーをcode/paramsの構造のままJSONへ出す | 維持 / 成功 |

## crates/lattice-cli/src/mcp.rs（2件）

本番の接続先: [crates/lattice-cli/src/mcp.rs](../../crates/lattice-cli/src/mcp.rs)、[crates/lattice-cli/src/ops.rs](../../crates/lattice-cli/src/ops.rs)。

境界: 実MCP schema/result構築。stdio framingはintegration側。

重複判断: opsの引数変換とCLI integrationの実protocolに補完する。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T002"></a>[T002:150](../../crates/lattice-cli/src/mcp.rs#L150) | tool_schemas_match_the_command_arguments | MCPのツール定義が各操作の引数スキーマを公開する | 維持 / 成功 |
| <a id="T003"></a>[T003:168](../../crates/lattice-cli/src/mcp.rs#L168) | results_carry_the_note_and_stay_within_the_cap | MCP結果に注意書きを付け、出力サイズ上限を守る | 維持 / 成功 |

## crates/lattice-cli/src/ops.rs（3件）

本番の接続先: [crates/lattice-cli/src/ops.rs](../../crates/lattice-cli/src/ops.rs)。

境界: 実操作型変換・一時Storeを使った操作。CLI引数parser/stdioは一部別試験。

重複判断: integrationと同じ処理を含むがscope分岐とMCP変換の故障を局所化する。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T004"></a>[T004:386](../../crates/lattice-cli/src/ops.rs#L386) | scopes_parse_into_the_apps_filters | CLIのscope指定をアプリ共通の検索・一覧フィルタへ変換する | 維持 / 成功 |
| <a id="T005"></a>[T005:428](../../crates/lattice-cli/src/ops.rs#L428) | lists_collections_and_prints_blocks_with_ids | 実Storeのコレクション一覧とID付き記事ブロックを返す | 維持 / 成功 |
| <a id="T006"></a>[T006:455](../../crates/lattice-cli/src/ops.rs#L455) | mcp_calls_and_arguments_parse_into_the_same_ops | MCPの名前・引数をCLIと同じ操作型へ変換する | 維持 / 成功 |

## crates/lattice-cli/tests/cli.rs（7件）

本番の接続先: [crates/lattice-cli/src/main.rs](../../crates/lattice-cli/src/main.rs)、[crates/lattice-cli/src/ops.rs](../../crates/lattice-cli/src/ops.rs)、[crates/lattice-cli/src/mcp.rs](../../crates/lattice-cli/src/mcp.rs)。

境界: 実CLI binaryをspawnし、一時DB・stdin/stdout・exit statusを使う。外部LLMを使わない。

重複判断: unitより広いがCLI接続・write gate・DB非作成・stdioを独立に保護。7件維持。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T007"></a>[T007:65](../../crates/lattice-cli/tests/cli.rs#L65) | reads_the_library | 実CLIプロセスが一時DBの記事・ブロック・検索結果を読む | 維持 / 成功 |
| <a id="T008"></a>[T008:99](../../crates/lattice-cli/tests/cli.rs#L99) | a_folder_scopes_to_its_feeds_and_feeds_name_their_folder | 実CLIでフォルダの所属フィードへ絞り、フォルダ名を出す | 維持 / 成功 |
| <a id="T009"></a>[T009:115](../../crates/lattice-cli/tests/cli.rs#L115) | a_question_without_sources_is_answered_without_the_llm | 資料がない質問ではLLMを使わず回答する | 維持 / 成功 |
| <a id="T010"></a>[T010:123](../../crates/lattice-cli/tests/cli.rs#L123) | writes_need_the_opt_in | 実CLIの書き込みは明示オプトインなしでは拒否する | 維持 / 成功 |
| <a id="T011"></a>[T011:152](../../crates/lattice-cli/tests/cli.rs#L152) | a_missing_database_is_an_error_and_is_not_created | 存在しないDBをエラーにし、誤って新規作成しない | 維持 / 成功 |
| <a id="T012"></a>[T012:180](../../crates/lattice-cli/tests/cli.rs#L180) | serves_mcp_over_stdio | 実CLIのstdioでMCP初期化・一覧・呼び出しを処理する | 維持 / 成功 |
| <a id="T013"></a>[T013:223](../../crates/lattice-cli/tests/cli.rs#L223) | mcp_write_tools_need_the_opt_in | MCP経由の書き込みにも明示オプトインを要求する | 維持 / 成功 |

## crates/lattice-core/src/anthropic.rs（2件）

本番の接続先: [crates/lattice-core/src/anthropic.rs](../../crates/lattice-core/src/anthropic.rs)。

境界: 実providerのrequest構築/response解析。外部HTTPと実認証は呼ばない。

重複判断: Gemini/OpenAIは別wire protocolなので重複ではない。chainはfallbackの責務。各assertionを維持。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T014"></a>[T014:74](../../crates/lattice-core/src/anthropic.rs#L74) | builds_request_and_parses_response | Anthropicのリクエスト形状と応答解析を固定例で検証する | 維持 / 成功 |
| <a id="T015"></a>[T015:99](../../crates/lattice-core/src/anthropic.rs#L99) | missing_key_is_unavailable | Anthropicキー未設定を利用不能として扱う | 維持 / 成功 |

## crates/lattice-core/src/backup.rs（3件）

本番の接続先: [crates/lattice-core/src/backup.rs](../../crates/lattice-core/src/backup.rs)。

境界: 実世代選択と一時フォルダ内のファイル操作。常駐schedulerの起動は含まない。

重複判断: storeのDB snapshotとR2の遠隔世代管理は異なる境界。名前判定と実削除は相補。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T016"></a>[T016:99](../../crates/lattice-core/src/backup.rs#L99) | stale_keeps_newest_and_current | 保持世代の選択で最新と現在のバックアップを残す | 維持 / 成功 |
| <a id="T017"></a>[T017:109](../../crates/lattice-core/src/backup.rs#L109) | local_names | ローカルバックアップの名前・対象判定を守る | 維持 / 成功 |
| <a id="T018"></a>[T018:119](../../crates/lattice-core/src/backup.rs#L119) | backup_prunes_only_old_backups | 実ファイルの世代整理が古いバックアップだけを消す | 維持 / 成功 |

## crates/lattice-core/src/chain.rs（2件）

本番の接続先: [crates/lattice-core/src/chain.rs](../../crates/lattice-core/src/chain.rs)。

境界: 実chainに失敗/成功providerを差し込む。実サービス・CLIは呼ばない。

重複判断: 各providerのwire試験とは異なるfallback/設定migrationを保護。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T019"></a>[T019:230](../../crates/lattice-core/src/chain.rs#L230) | falls_back_and_cools_down_failed_entry | プロバイダ失敗時に次段へ進み、失敗段をクールダウンする | 維持 / 成功 |
| <a id="T020"></a>[T020:249](../../crates/lattice-core/src/chain.rs#L249) | config_migrates_legacy_model_and_keys | 旧モデル・APIキー設定を新しいプロバイダチェーンへ移す | 維持 / 成功 |

## crates/lattice-core/src/chat.rs（6件）

本番の接続先: [crates/lattice-core/src/chat.rs](../../crates/lattice-core/src/chat.rs)。

境界: 実Storeと対話/資料選択コード。LLM/embeddingを制御したfixtureに置換。

重複判断: src/chatは表示用引用・scope、e2e/chatは入力UI。ここは資料制約とDB履歴なので維持。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T021"></a>[T021:523](../../crates/lattice-core/src/chat.rs#L523) | search_filter_restricts_to_articles | 対話の検索対象を指定記事だけに限定する | 維持 / 成功 |
| <a id="T022"></a>[T022:536](../../crates/lattice-core/src/chat.rs#L536) | article_scope_sends_full_text_validates_citations_and_persists | 記事全文の対話入力、引用番号の検証、履歴保存を連携させる | 維持 / 成功 |
| <a id="T023"></a>[T023:574](../../crates/lattice-core/src/chat.rs#L574) | large_scope_retrieves_within_scope_only | 大きな対話scopeでも範囲外の記事を検索資料へ混ぜない | 維持 / 成功 |
| <a id="T024"></a>[T024:609](../../crates/lattice-core/src/chat.rs#L609) | budget_setting_sizes_the_context | 対話予算設定に応じて投入コンテキスト量を変える | 維持 / 成功 |
| <a id="T025"></a>[T025:629](../../crates/lattice-core/src/chat.rs#L629) | diversify_caps_blocks_per_article_then_fills | 資料選択を記事ごとに分散し、余り枠を埋める | 維持 / 成功 |
| <a id="T026"></a>[T026:641](../../crates/lattice-core/src/chat.rs#L641) | input_respects_context_cap | 対話入力が設定されたコンテキスト上限を超えない | 維持 / 成功 |

## crates/lattice-core/src/classify.rs（4件）

本番の接続先: [crates/lattice-core/src/classify.rs](../../crates/lattice-core/src/classify.rs)。

境界: 実SQLiteと分類job。LLM応答はfixture。

重複判断: jobsの一般再試行とは別のbatch全件終了、手動genre保持がある。migrationとは実行時の責務が違う。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T027"></a>[T027:330](../../crates/lattice-core/src/classify.rs#L330) | batches_reuses_genres_and_keeps_manual_choice | 分類をバッチ化し、既存ジャンルと手動選択を保持する | 維持 / 成功 |
| <a id="T028"></a>[T028:381](../../crates/lattice-core/src/classify.rs#L381) | renames_merges_and_deletes_genres | ジャンルの改名・統合・削除をDBへ反映する | 維持 / 成功 |
| <a id="T029"></a>[T029:417](../../crates/lattice-core/src/classify.rs#L417) | startup_backfill_queues_articles_that_never_had_a_job | 分類ジョブ履歴のない記事だけを起動時補完へ回す | 維持 / 成功 |
| <a id="T030"></a>[T030:437](../../crates/lattice-core/src/classify.rs#L437) | failures_finish_every_batched_job | 分類バッチ失敗時に対象ジョブを取り残さない | 維持 / 成功 |

## crates/lattice-core/src/claude.rs（2件）

本番の接続先: [crates/lattice-core/src/claude.rs](../../crates/lattice-core/src/claude.rs)。

境界: 実CLI adapterの応答解析・引数構築。Claudeプロセス起動は含まない。

重複判断: Codexのevent形式とは別。引数省略と応答解析は異なる故障条件。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T031"></a>[T031:115](../../crates/lattice-core/src/claude.rs#L115) | parses_structured_output | Claude CLIの構造化応答を解析する | 維持 / 成功 |
| <a id="T032"></a>[T032:128](../../crates/lattice-core/src/claude.rs#L128) | passes_model_and_effort_only_when_set | Claude CLI引数に指定時だけmodel/effortを渡す | 維持 / 成功 |

## crates/lattice-core/src/codex.rs（3件）

本番の接続先: [crates/lattice-core/src/codex.rs](../../crates/lattice-core/src/codex.rs)。

境界: 通常2件はevent解析とeffort既定値。live_codex_execだけ実CLI疎通だがignore。

重複判断: Claudeとはprotocolが異なる。無効化された疎通試験を成功数へ入れない。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T033"></a>[T033:157](../../crates/lattice-core/src/codex.rs#L157) | parses_exec_events | Codex execのイベントから応答・失敗を解析する | 維持 / 成功 |
| <a id="T034"></a>[T034:175](../../crates/lattice-core/src/codex.rs#L175) | effort_defaults_to_low | Codexのeffort省略時の値をlowにする | 維持 / 成功 |
| <a id="T035"></a>[T035:183](../../crates/lattice-core/src/codex.rs#L183) | live_codex_exec | 実Codex execから文字列を得る疎通確認（通常はignore） | 維持・任意疎通 / ignore・未実行 |

## crates/lattice-core/src/embed.rs（1件）

本番の接続先: [crates/lattice-core/src/embed.rs](../../crates/lattice-core/src/embed.rs)。

境界: 実offline load/cache存在判定。モデル推論精度やdownload成功は対象外。

重複判断: searchの検索融合とは異なる、意図しないネットワーク取得防止。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T036"></a>[T036:126](../../crates/lattice-core/src/embed.rs#L126) | offline_never_downloads_and_sees_the_cached_model | オフライン埋め込み器は取得せず、既存モデルキャッシュを認識する | 維持 / 成功 |

## crates/lattice-core/src/export.rs（3件）

本番の接続先: [crates/lattice-core/src/export.rs](../../crates/lattice-core/src/export.rs)。

境界: 実Storeからexport値を生成。GUIファイル選択と外部viewerは対象外。

重複判断: e2e/groupsのexport要求と補完。秘密値除外・所属・folderの出力内容はここでしか直接守らない。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T037"></a>[T037:197](../../crates/lattice-core/src/export.rs#L197) | exports_articles_translations_and_chat_without_secrets_or_html | 記事・翻訳・対話を出力し、秘密値とHTMLを混入させない | 維持 / 成功 |
| <a id="T038"></a>[T038:259](../../crates/lattice-core/src/export.rs#L259) | a_group_export_has_its_articles_and_every_article_its_groups | グループ限定exportと記事の全所属グループを保つ | 維持 / 成功 |
| <a id="T039"></a>[T039:285](../../crates/lattice-core/src/export.rs#L285) | feeds_carry_their_folder | exportしたフィードに所属フォルダを含める | 維持 / 成功 |

## crates/lattice-core/src/extract.rs（2件）

本番の接続先: [crates/lattice-core/src/extract.rs](../../crates/lattice-core/src/extract.rs)。

境界: HTML fixtureを実extractorへ通す。ライブサイト/取得は含まない。

重複判断: ingestは抽出後のDB連携、markdown/pdfは異形式。aside境界と記事分割は相補。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T040"></a>[T040:326](../../crates/lattice-core/src/extract.rs#L326) | keeps_asides_inside_the_article_body | 記事内asideを抽出本文から落とさない | 維持 / 成功 |
| <a id="T041"></a>[T041:337](../../crates/lattice-core/src/extract.rs#L337) | segments_article_into_blocks | HTML記事を種別付きブロックへ分割する | 維持 / 成功 |

## crates/lattice-core/src/favicons.rs（4件）

本番の接続先: [crates/lattice-core/src/favicons.rs](../../crates/lattice-core/src/favicons.rs)。

境界: 実URL検証・queue/store/cache処理。公開サイトの実favicon取得は保証しない。

重複判断: fetch/imagesとprivate拒否が重なるが入口が別。重複投入・週次更新も固有。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T042"></a>[T042:154](../../crates/lattice-core/src/favicons.rs#L154) | finds_icon_links | HTMLからfavicon候補リンクを解決する | 維持 / 成功 |
| <a id="T043"></a>[T043:167](../../crates/lattice-core/src/favicons.rs#L167) | rejects_anything_but_a_bare_host | favicon取得対象を裸のホスト名へ制限する | 維持 / 成功 |
| <a id="T044"></a>[T044:175](../../crates/lattice-core/src/favicons.rs#L175) | queues_once_serves_and_refetches_weekly | faviconを重複キュー投入せず、保存・配信・週次再取得する | 維持 / 成功 |
| <a id="T045"></a>[T045:196](../../crates/lattice-core/src/favicons.rs#L196) | private_hosts_are_refused_and_the_failure_stored | privateホストのfaviconを拒否し失敗を保存する | 維持 / 成功 |

## crates/lattice-core/src/feed_filter.rs（6件）

本番の接続先: [crates/lattice-core/src/feed_filter.rs](../../crates/lattice-core/src/feed_filter.rs)。

境界: 実規則評価・parser・Store/poll。LLMは制御応答。

重複判断: src/feedFilterは理由表示と編集、e2eは操作。規則優先・失敗時許可はbackend固有で維持。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T046"></a>[T046:582](../../crates/lattice-core/src/feed_filter.rs#L582) | exclusions_win_and_any_include_must_match_in_each_scope | feed除外規則優先と各scope内includeのOR条件を守る | 維持 / 成功 |
| <a id="T047"></a>[T047:600](../../crates/lattice-core/src/feed_filter.rs#L600) | author_category_language_and_length | 著者・カテゴリ・言語・長さのfeed条件を判定する | 維持 / 成功 |
| <a id="T048"></a>[T048:627](../../crates/lattice-core/src/feed_filter.rs#L627) | validation_tidies_and_rejects_bad_regexes | feed規則の空白等を整え、不正正規表現を拒否する | 維持 / 成功 |
| <a id="T049"></a>[T049:648](../../crates/lattice-core/src/feed_filter.rs#L648) | parsed_entries_carry_what_the_rules_read | RSS/Atomからフィルタが読む属性を取り出す | 維持 / 成功 |
| <a id="T050"></a>[T050:688](../../crates/lattice-core/src/feed_filter.rs#L688) | a_poll_keeps_rejected_entries_with_their_reason_and_never_judges_them_again | 拒否記事と理由を残し、同じエントリを再判定しない | 維持 / 成功 |
| <a id="T051"></a>[T051:726](../../crates/lattice-core/src/feed_filter.rs#L726) | the_llm_judges_what_the_rules_let_through_and_fails_open | 規則通過分だけLLM判定し、LLM失敗時は取り込みを許す | 維持 / 成功 |

## crates/lattice-core/src/feed_folders.rs（4件）

本番の接続先: [crates/lattice-core/src/feed_folders.rs](../../crates/lattice-core/src/feed_folders.rs)。

境界: 実SQLiteで所属・順序・scope・OPML変換を実行。

重複判断: TSは楽観表示、e2eは操作接続。mockがTS helperを共有するため、この独立Rust側を残す。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T052"></a>[T052:252](../../crates/lattice-core/src/feed_folders.rs#L252) | folders_are_named_ordered_and_deleting_one_keeps_its_feeds | フォルダ名・順序を保存し、削除時もフィードを残す | 維持 / 成功 |
| <a id="T053"></a>[T053:287](../../crates/lattice-core/src/feed_folders.rs#L287) | feeds_keep_the_users_order_within_their_folder | フォルダ内のユーザー指定フィード順を保存する | 維持 / 成功 |
| <a id="T054"></a>[T054:316](../../crates/lattice-core/src/feed_folders.rs#L316) | a_folder_scopes_lists_and_search_to_its_feeds_articles | フォルダ内フィードの記事だけを一覧・検索する | 維持 / 成功 |
| <a id="T055"></a>[T055:340](../../crates/lattice-core/src/feed_folders.rs#L340) | opml_round_trips_folders | OPMLの階層をフォルダとしてimport/exportする | 維持 / 成功 |

## crates/lattice-core/src/feeds.rs（10件）

本番の接続先: [crates/lattice-core/src/feeds.rs](../../crates/lattice-core/src/feeds.rs)。

境界: RSS/Atom fixtureと実Storeによる取り込み。ネットワーク境界は制御される。

重複判断: feed_filterは採否、feed_foldersは所属。回復の各race条件は異なるため似た名前でも維持。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T056"></a>[T056:531](../../crates/lattice-core/src/feeds.rs#L531) | parses_rss_and_atom | RSSとAtomの標準エントリを解析する | 維持 / 成功 |
| <a id="T057"></a>[T057:545](../../crates/lattice-core/src/feeds.rs#L545) | finds_feed_links_on_a_page | ページ内のフィードリンクを発見・解決する | 維持 / 成功 |
| <a id="T058"></a>[T058:568](../../crates/lattice-core/src/feeds.rs#L568) | entry_dates_fill_missing_published_at | feedエントリ日付で未設定の公開日時だけを補う | 維持 / 成功 |
| <a id="T059"></a>[T059:625](../../crates/lattice-core/src/feeds.rs#L625) | keeps_entry_titles_and_only_full_content | feedタイトルを保持し、全文と短い概要を区別する | 維持 / 成功 |
| <a id="T060"></a>[T060:633](../../crates/lattice-core/src/feeds.rs#L633) | refused_pages_fall_back_to_the_feed_text_or_a_render | ページ取得拒否時にfeed本文または描画へフォールバックする | 維持 / 成功 |
| <a id="T061"></a>[T061:675](../../crates/lattice-core/src/feeds.rs#L675) | articles_that_failed_before_the_feed_text_was_kept_recover_once | feed本文保存前に失敗した既存記事を一度だけ回復する | 維持 / 成功 |
| <a id="T062"></a>[T062:704](../../crates/lattice-core/src/feeds.rs#L704) | an_article_that_failed_while_its_feed_text_was_being_stored_is_retried | feed本文保存と記事失敗が重なった場合も再試行する | 維持 / 成功 |
| <a id="T063"></a>[T063:721](../../crates/lattice-core/src/feeds.rs#L721) | names_and_icons_override_the_feeds_own | フィード名・アイコンの上書きと解除を保存する | 維持 / 成功 |
| <a id="T064"></a>[T064:751](../../crates/lattice-core/src/feeds.rs#L751) | an_entry_listed_twice_in_one_poll_is_queued_once | 同一poll内の重複エントリを一度だけキューへ入れる | 維持 / 成功 |
| <a id="T065"></a>[T065:761](../../crates/lattice-core/src/feeds.rs#L761) | imports_only_unseen_entries_and_caps_first_import | 未知エントリだけ取り込み、初回取得数を制限する | 維持 / 成功 |

## crates/lattice-core/src/fetch.rs（5件）

本番の接続先: [crates/lattice-core/src/fetch.rs](../../crates/lattice-core/src/fetch.rs)。

境界: IP/URL/エラー/charsetの実判定とprivate宛先拒否。公開HTTP成功・全redirect連鎖の実地試験ではない。

重複判断: 画像/faviconでもSSRF境界がある。別の呼び出し口を保護するので機械的に統合しない。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T066"></a>[T066:196](../../crates/lattice-core/src/fetch.rs#L196) | classifies_addresses | IPアドレスのpublic/private分類を境界例で守る | 維持 / 成功 |
| <a id="T067"></a>[T067:226](../../crates/lattice-core/src/fetch.rs#L226) | refuses_private_targets | private宛てHTTP取得を拒否する | 維持 / 成功 |
| <a id="T068"></a>[T068:235](../../crates/lattice-core/src/fetch.rs#L235) | names_common_network_failures | 代表的なネットワーク失敗をユーザー向け原因へ分類する | 維持 / 成功 |
| <a id="T069"></a>[T069:271](../../crates/lattice-core/src/fetch.rs#L271) | tells_pdfs_from_pages | Content-Type等からPDFとページを判別する | 維持 / 成功 |
| <a id="T070"></a>[T070:284](../../crates/lattice-core/src/fetch.rs#L284) | detects_charset | 宣言・内容から文字コードを選ぶ | 維持 / 成功 |

## crates/lattice-core/src/gemini.rs（1件）

本番の接続先: [crates/lattice-core/src/gemini.rs](../../crates/lattice-core/src/gemini.rs)。

境界: 実providerのrequest構築/response解析。実HTTP/認証は対象外。

重複判断: Anthropic/OpenAIとwire protocolが異なるため維持。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T071"></a>[T071:69](../../crates/lattice-core/src/gemini.rs#L69) | builds_request_and_parses_response | Geminiリクエスト形状と応答解析を固定例で検証する | 維持 / 成功 |

## crates/lattice-core/src/groups.rs（3件）

本番の接続先: [crates/lattice-core/src/groups.rs](../../crates/lattice-core/src/groups.rs)。

境界: 実SQLiteで多対多所属・一覧/検索・削除連鎖を確認。

重複判断: store migrationは既存DB更新、UI testsは操作。名前正規化・連鎖削除も別契約。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T072"></a>[T072:124](../../crates/lattice-core/src/groups.rs#L124) | membership_is_many_to_many_and_filters_lists_and_search | グループ多対多所属を一覧・検索の絞り込みへ反映する | 維持 / 成功 |
| <a id="T073"></a>[T073:145](../../crates/lattice-core/src/groups.rs#L145) | names_are_trimmed_and_unique_ignoring_case | グループ名のtrimと大文字小文字無視の一意性を守る | 維持 / 成功 |
| <a id="T074"></a>[T074:161](../../crates/lattice-core/src/groups.rs#L161) | deleting_a_group_keeps_its_articles_and_deleting_an_article_leaves_its_groups | グループ削除で記事を、記事削除でグループを巻き込まない | 維持 / 成功 |

## crates/lattice-core/src/images.rs（4件）

本番の接続先: [crates/lattice-core/src/images.rs](../../crates/lattice-core/src/images.rs)。

境界: 実検証・保存/配信/GC・補完処理をfixtureと一時storeで実行。

重複判断: fetchの防御と入口が異なり、GC/参照数は画像固有。Markdown相対pathも別境界。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T075"></a>[T075:282](../../crates/lattice-core/src/images.rs#L282) | filters_by_type_and_size | 画像の形式・サイズ制約を守る | 維持 / 成功 |
| <a id="T076"></a>[T076:299](../../crates/lattice-core/src/images.rs#L299) | refuses_other_schemes_and_private_hosts | 画像取得で危険なscheme/privateホストを拒否する | 維持 / 成功 |
| <a id="T077"></a>[T077:329](../../crates/lattice-core/src/images.rs#L329) | dedups_serves_and_collects_garbage | 画像を重複保存せず、参照・配信・不要データ回収する | 維持 / 成功 |
| <a id="T078"></a>[T078:359](../../crates/lattice-core/src/images.rs#L359) | backfill_skips_tried_urls_and_respects_the_setting | 画像補完は試行済みURLを避け、設定オフを尊重する | 維持 / 成功 |

## crates/lattice-core/src/ingest.rs（8件）

本番の接続先: [crates/lattice-core/src/ingest.rs](../../crates/lattice-core/src/ingest.rs)。

境界: 実抽出・Store・job処理をfixture取得器で接続。OSファイルdialog/実ページ描画は含まない。

重複判断: extract/pdf/markdownの形式処理をDB保存へ接続する層。再保存・dedup・再抽出の故障は異なる。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T079"></a>[T079:202](../../crates/lattice-core/src/ingest.rs#L202) | extracts_urls_from_any_format | 貼り付け形式の異なる入力からURLを抽出する | 維持 / 成功 |
| <a id="T080"></a>[T080:222](../../crates/lattice-core/src/ingest.rs#L222) | enqueue_counts_and_is_idempotent | 記事投入の件数と再投入の冪等性を守る | 維持 / 成功 |
| <a id="T081"></a>[T081:249](../../crates/lattice-core/src/ingest.rs#L249) | stores_blocks_and_dedups | 抽出ブロックを保存し、同じ内容を重複登録しない | 維持 / 成功 |
| <a id="T082"></a>[T082:272](../../crates/lattice-core/src/ingest.rs#L272) | one_fetch_per_host_at_a_time | 同一ホストへの取得を同時実行しない | 維持 / 成功 |
| <a id="T083"></a>[T083:286](../../crates/lattice-core/src/ingest.rs#L286) | rendered_save_replaces_thin_extraction_and_reextract_keeps_ids | 描画結果で薄い抽出を更新し、再抽出で同一ブロックIDを保つ | 維持 / 成功 |
| <a id="T084"></a>[T084:306](../../crates/lattice-core/src/ingest.rs#L306) | resaving_an_extracted_article_never_merges_it_away | 保存済み記事の再保存で記事自体が別記事へ吸収されない | 維持 / 成功 |
| <a id="T085"></a>[T085:322](../../crates/lattice-core/src/ingest.rs#L322) | a_pdf_url_becomes_an_article_of_that_url | PDFのURLを元URLの記事として取り込む | 維持 / 成功 |
| <a id="T086"></a>[T086:347](../../crates/lattice-core/src/ingest.rs#L347) | extraction_failure_is_recorded_and_retryable | 抽出失敗を保存し、再試行可能にする | 維持 / 成功 |

## crates/lattice-core/src/instructions.rs（2件）

本番の接続先: [crates/lattice-core/src/instructions.rs](../../crates/lattice-core/src/instructions.rs)。

境界: 実設定保存・prompt結合・version算出。LLMによる指示遵守までは保証しない。

重複判断: jobs/segmentsは指示の利用先。上限・非信頼入力の配置はここで独立して維持。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T087"></a>[T087:107](../../crates/lattice-core/src/instructions.rs#L107) | saves_trims_and_limits | 追加指示をtrimして保存し、文字数上限を守る | 維持 / 成功 |
| <a id="T088"></a>[T088:120](../../crates/lattice-core/src/instructions.rs#L120) | untrusted_rule_stays_last_and_version_tracks_the_text | 非信頼入力の扱いを末尾に残し、指示変更で版を変える | 維持 / 成功 |

## crates/lattice-core/src/job_status.rs（2件）

本番の接続先: [crates/lattice-core/src/job_status.rs](../../crates/lattice-core/src/job_status.rs)。

境界: 実SQLiteの状態一覧とretry/cancel操作。UI表示は対象外。

重複判断: jobsは実行、storeはqueue遷移、e2e/jobsは表示・説明。各境界を残す。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T089"></a>[T089:142](../../crates/lattice-core/src/job_status.rs#L142) | lists_failures_and_retries_batched_classify_jobs | ジョブ失敗一覧と分類バッチの再試行を扱う | 維持 / 成功 |
| <a id="T090"></a>[T090:175](../../crates/lattice-core/src/job_status.rs#L175) | a_running_job_is_neither_cancelled_nor_retried | 実行中ジョブのキャンセル・再試行を拒否する | 維持 / 成功 |

## crates/lattice-core/src/jobs.rs（10件）

本番の接続先: [crates/lattice-core/src/jobs.rs](../../crates/lattice-core/src/jobs.rs)。

境界: 実Store/job runnerと制御LLM・取得器。Tauri常駐loopや実外部サービスは含まない。

重複判断: storeのqueue primitiveと重なるが、翻訳/要約/cacheの業務連携を追加で守る。各失敗状態は別。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T091"></a>[T091:184](../../crates/lattice-core/src/jobs.rs#L184) | translates_prose_blocks_and_is_idempotent | 翻訳対象本文だけを訳し、再実行で重複処理しない | 維持 / 成功 |
| <a id="T092"></a>[T092:234](../../crates/lattice-core/src/jobs.rs#L234) | saved_articles_are_translated_only_when_asked_and_not_when_japanese | 保存だけでは翻訳せず、明示要求でも対象言語済み本文を除く | 維持 / 成功 |
| <a id="T093"></a>[T093:255](../../crates/lattice-core/src/jobs.rs#L255) | retranslate_drops_the_cache_and_translates_again | 再翻訳要求で既存キャッシュを捨てて訳し直す | 維持 / 成功 |
| <a id="T094"></a>[T094:277](../../crates/lattice-core/src/jobs.rs#L277) | japanese_articles_translate_into_english | 日本語記事を英語へ翻訳するジョブ経路を守る | 維持 / 成功 |
| <a id="T095"></a>[T095:304](../../crates/lattice-core/src/jobs.rs#L304) | failure_backs_off_and_manual_retry_resumes | ジョブ失敗時のbackoffと手動再試行からの再開を守る | 維持 / 成功 |
| <a id="T096"></a>[T096:319](../../crates/lattice-core/src/jobs.rs#L319) | summarizes_and_marks_stale_after_content_change | 要約保存と本文変更によるstale化を守る | 維持 / 成功 |
| <a id="T097"></a>[T097:334](../../crates/lattice-core/src/jobs.rs#L334) | summary_follows_the_users_instructions_and_goes_stale_when_they_change | 要約に追加指示を適用し、指示変更でstale化する | 維持 / 成功 |
| <a id="T098"></a>[T098:363](../../crates/lattice-core/src/jobs.rs#L363) | favicon_jobs_need_no_article | 記事に紐づかないfaviconジョブを実行する | 維持 / 成功 |
| <a id="T099"></a>[T099:375](../../crates/lattice-core/src/jobs.rs#L375) | run_article_runs_only_that_articles_jobs | 指定記事実行で他記事のジョブを動かさない | 維持 / 成功 |
| <a id="T100"></a>[T100:389](../../crates/lattice-core/src/jobs.rs#L389) | recovers_jobs_left_running | 前回実行中のまま残ったジョブを回復する | 維持 / 成功 |

## crates/lattice-core/src/llm.rs（1件）

本番の接続先: [crates/lattice-core/src/llm.rs](../../crates/lattice-core/src/llm.rs)。

境界: JSON schemaの実変換。各APIがそのschemaを受け入れるかは対象外。

重複判断: providerのwire試験と補完。小さい試験でもobject閉鎖の契約は独立。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T101"></a>[T101:105](../../crates/lattice-core/src/llm.rs#L105) | strict_schema_closes_objects | strict JSON schemaのobjectを閉じる | 維持 / 成功 |

## crates/lattice-core/src/location.rs（8件）

本番の接続先: [crates/lattice-core/src/location.rs](../../crates/lattice-core/src/location.rs)。

境界: 一時ディレクトリで保存先選択・bootstrap読書きを実行。OS全体の権限設定は再現しない。

重複判断: Tauri locationはcopyと移動先制約、CLIは実起動。優先順位の各branchを残す。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T102"></a>[T102:141](../../crates/lattice-core/src/location.rs#L141) | the_portable_marker_wins_over_everything | portableマーカーを他の保存先設定より優先する | 維持 / 成功 |
| <a id="T103"></a>[T103:149](../../crates/lattice-core/src/location.rs#L149) | without_marker_or_bootstrap_the_default_folder_is_used | マーカーもbootstrapもなければ既定保存先を選ぶ | 維持 / 成功 |
| <a id="T104"></a>[T104:156](../../crates/lattice-core/src/location.rs#L156) | a_valid_bootstrap_names_the_folder | 有効なbootstrap指定を保存先として使う | 維持 / 成功 |
| <a id="T105"></a>[T105:163](../../crates/lattice-core/src/location.rs#L163) | an_invalid_bootstrap_falls_back_with_a_warning | 不正bootstrapでは警告付きで既定保存先へ戻す | 維持 / 成功 |
| <a id="T106"></a>[T106:172](../../crates/lattice-core/src/location.rs#L172) | the_bootstrap_round_trips_and_choosing_the_default_removes_it | bootstrapを往復保存し、既定保存先に戻すと削除する | 維持 / 成功 |
| <a id="T107"></a>[T107:185](../../crates/lattice-core/src/location.rs#L185) | a_chosen_folder_without_a_database_falls_back_to_the_default | 選択フォルダにDBがなければ既定保存先へ戻す | 維持 / 成功 |
| <a id="T108"></a>[T108:203](../../crates/lattice-core/src/location.rs#L203) | an_unwritable_bootstrap_is_an_error | bootstrapを書き込めない場合はエラーにする | 維持 / 成功 |
| <a id="T109"></a>[T109:212](../../crates/lattice-core/src/location.rs#L212) | the_default_folder_is_named_by_the_identifier | アプリ識別子から既定保存フォルダ名を決める | 維持 / 成功 |

## crates/lattice-core/src/markdown.rs（5件）

本番の接続先: [crates/lattice-core/src/markdown.rs](../../crates/lattice-core/src/markdown.rs)。

境界: 実Markdown parserと一時ファイル/Store。OS選択dialogは通らない。

重複判断: HTML/PDFとは別形式、ingestとは別の相対画像境界。idempotencyを別形式でも保護。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T110"></a>[T110:375](../../crates/lattice-core/src/markdown.rs#L375) | converts_markdown_to_blocks | Markdownを種別付き記事ブロックへ変換する | 維持 / 成功 |
| <a id="T111"></a>[T111:410](../../crates/lattice-core/src/markdown.rs#L410) | joins_japanese_lines_and_drops_inline_script_text | 日本語改行を結合し、inline script本文を落とす | 維持 / 成功 |
| <a id="T112"></a>[T112:426](../../crates/lattice-core/src/markdown.rs#L426) | title_falls_back_to_name_then_first_line | Markdownタイトルをファイル名・先頭行へフォールバックする | 維持 / 成功 |
| <a id="T113"></a>[T113:434](../../crates/lattice-core/src/markdown.rs#L434) | imports_once_per_text_and_reextracts_in_place | 同じMarkdown本文は一度だけ登録し、その場で再抽出する | 維持 / 成功 |
| <a id="T114"></a>[T114:450](../../crates/lattice-core/src/markdown.rs#L450) | reads_relative_images_only_inside_the_picked_folder | 相対画像読み込みを選択したフォルダ内へ制限する | 維持 / 成功 |

## crates/lattice-core/src/msg.rs（1件）

本番の接続先: [crates/lattice-core/src/msg.rs](../../crates/lattice-core/src/msg.rs)。

境界: 実msg macroのJSON形状。frontendの翻訳表示は別。

重複判断: i18n/backendの静的照合と相補。小ささだけで低価値としない。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T115"></a>[T115:24](../../crates/lattice-core/src/msg.rs#L24) | codes_and_params_are_json | メッセージcode/paramsをJSON形式で表す | 維持 / 成功 |

## crates/lattice-core/src/openai.rs（1件）

本番の接続先: [crates/lattice-core/src/openai.rs](../../crates/lattice-core/src/openai.rs)。

境界: 実providerのrequest構築/response解析。実HTTP/認証は対象外。

重複判断: Gemini/Anthropicとはwire protocolが異なるため維持。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T116"></a>[T116:72](../../crates/lattice-core/src/openai.rs#L72) | builds_request_and_parses_response | OpenAIリクエスト形状と応答解析を固定例で検証する | 維持 / 成功 |

## crates/lattice-core/src/pdf.rs（4件）

本番の接続先: [crates/lattice-core/src/pdf.rs](../../crates/lattice-core/src/pdf.rs)。

境界: 生成/固定PDF bytesを実parser・Storeへ通す。多様な実論文corpus、OSdialogは含まない。

重複判断: e2e/pdfはprepared articleだけなので代替不能。helpersは形式判定等の独立branch。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T117"></a>[T117:883](../../crates/lattice-core/src/pdf.rs#L883) | rebuilds_a_two_column_paper | 人工PDFの二段組本文を読む順へ組み立てる | 維持 / 成功 |
| <a id="T118"></a>[T118:918](../../crates/lattice-core/src/pdf.rs#L918) | title_falls_back_to_metadata_then_name | PDFタイトルをmetadata・ファイル名へフォールバックする | 維持 / 成功 |
| <a id="T119"></a>[T119:929](../../crates/lattice-core/src/pdf.rs#L929) | helpers | PDF形式・節番号・参考文献番号・caption・日付の補助判定を守る | 維持 / 成功 |
| <a id="T120"></a>[T120:943](../../crates/lattice-core/src/pdf.rs#L943) | imports_once_per_file_and_reextracts_in_place | 同じPDFを重複登録せず、再抽出を既存記事へ反映する | 維持 / 成功 |

## crates/lattice-core/src/quiz.rs（7件）

本番の接続先: [crates/lattice-core/src/quiz.rs](../../crates/lattice-core/src/quiz.rs)。

境界: 実quiz解析・SQLite・due管理。LLM応答と時刻を制御。

重複判断: srsは間隔計算、e2eは回答UI。カード登録・日次上限・cascadeはDB固有。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T121"></a>[T121:510](../../crates/lattice-core/src/quiz.rs#L510) | parse_keeps_well_formed_questions_and_maps_sources | quiz応答の有効な設問だけを残し、引用元へ対応付ける | 維持 / 成功 |
| <a id="T122"></a>[T122:528](../../crates/lattice-core/src/quiz.rs#L528) | the_job_stores_a_quiz_that_goes_stale_with_the_text_or_the_profile | quiz生成ジョブの保存と本文・プロフィール変更によるstale化を守る | 維持 / 成功 |
| <a id="T123"></a>[T123:557](../../crates/lattice-core/src/quiz.rs#L557) | a_reply_without_usable_questions_fails_the_job | 有効な設問がない生成応答をジョブ失敗にする | 維持 / 成功 |
| <a id="T124"></a>[T124:577](../../crates/lattice-core/src/quiz.rs#L577) | adding_to_review_counts_reader_answers_and_queues_the_rest_as_new | quiz回答済み状態を復習へ引き継ぎ、未回答を新規カードにする | 維持 / 成功 |
| <a id="T125"></a>[T125:614](../../crates/lattice-core/src/quiz.rs#L614) | daily_limits_and_due_times | 復習の一日上限とdue日時を守る | 維持 / 成功 |
| <a id="T126"></a>[T126:642](../../crates/lattice-core/src/quiz.rs#L642) | settings_are_validated | 復習設定の入力範囲を検証する | 維持 / 成功 |
| <a id="T127"></a>[T127:660](../../crates/lattice-core/src/quiz.rs#L660) | deleting_the_article_removes_its_quizzes_cards_and_log | 記事削除に伴いquiz・カード・履歴を消す | 維持 / 成功 |

## crates/lattice-core/src/r2.rs（8件）

本番の接続先: [crates/lattice-core/src/r2.rs](../../crates/lattice-core/src/r2.rs)。

境界: 実SigV4/URL/XML/設定/世代選択。R2実サーバーへのPUT/GET/DELETEはしない。

重複判断: AWS既知vector T128は残す。T133の自己参照部分だけF05。local backupと対象が異なる。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T128"></a>[T128:568](../../crates/lattice-core/src/r2.rs#L568) | sigv4_matches_aws_examples | AWS既知の署名値とSigV4計算結果を比較する | 維持 / 成功 |
| <a id="T129"></a>[T129:575](../../crates/lattice-core/src/r2.rs#L575) | builds_path_style_r2_request | R2のpath-style PUTリクエストを組み立てる | 維持 / 成功 |
| <a id="T130"></a>[T130:594](../../crates/lattice-core/src/r2.rs#L594) | utc_dates_and_keys | UTC日付・バックアップキーを生成する | 維持 / 成功 |
| <a id="T131"></a>[T131:606](../../crates/lattice-core/src/r2.rs#L606) | settings_hide_secret_and_drive_schedule | R2設定の秘密値を隠し、スケジュールへ反映する | 維持 / 成功 |
| <a id="T132"></a>[T132:643](../../crates/lattice-core/src/r2.rs#L643) | generations_and_clearing_secret | R2保持世代設定と秘密値クリアを保存する | 維持 / 成功 |
| <a id="T133"></a>[T133:664](../../crates/lattice-core/src/r2.rs#L664) | signs_list_and_delete_requests | R2 list/deleteのURLと署名への引数の接続を守る | 補強 / [P3 F05](findings.md#F05) |
| <a id="T134"></a>[T134:685](../../crates/lattice-core/src/r2.rs#L685) | parses_list_pages | R2一覧XMLのページ・継続トークンを解析する | 維持 / 成功 |
| <a id="T135"></a>[T135:704](../../crates/lattice-core/src/r2.rs#L704) | selects_old_generations_of_this_device_only | 当該端末の古い世代だけを削除候補にする | 維持 / 成功 |

## crates/lattice-core/src/relevance.rs（3件）

本番の接続先: [crates/lattice-core/src/relevance.rs](../../crates/lattice-core/src/relevance.rs)。

境界: 実検証・SQLite/batch処理。LLMはfixture。

重複判断: e2e/relevanceの表示・設定操作とは別。score範囲、profile stale、auto設定を個別に残す。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T136"></a>[T136:266](../../crates/lattice-core/src/relevance.rs#L266) | reasons_and_scores_are_validated | 重要度応答の理由とscore範囲を検証する | 維持 / 成功 |
| <a id="T137"></a>[T137:275](../../crates/lattice-core/src/relevance.rs#L275) | rates_in_one_batch_and_goes_stale_when_the_profile_changes | 重要度を一括評価し、プロフィール変更時にstale化する | 維持 / 成功 |
| <a id="T138"></a>[T138:322](../../crates/lattice-core/src/relevance.rs#L322) | auto_rating_and_threshold_settings | 自動重要度評価と閾値設定を適用する | 維持 / 成功 |

## crates/lattice-core/src/render.rs（3件）

本番の接続先: [crates/lattice-core/src/render.rs](../../crates/lattice-core/src/render.rs)。

境界: 描画jobの投入・結果採否を実Storeで検証。native hidden webviewの実行は含まない。

重複判断: ingestの抽出更新とは異なる描画再投入防止。e2e/Page testsもnative描画は代替しない。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T139"></a>[T139:117](../../crates/lattice-core/src/render.rs#L117) | thin_fetch_queues_one_render_and_rendering_never_requeues | 薄い抽出で描画を一度だけ投入し、描画が再描画を連鎖させない | 維持 / 成功 |
| <a id="T140"></a>[T140:136](../../crates/lattice-core/src/render.rs#L136) | full_fetch_or_setting_off_queues_nothing | 十分な本文・描画無効設定では描画ジョブを投入しない | 維持 / 成功 |
| <a id="T141"></a>[T141:148](../../crates/lattice-core/src/render.rs#L148) | failed_or_shorter_rendering_keeps_the_article | 描画失敗や短い結果で既存記事を失わない | 維持 / 成功 |

## crates/lattice-core/src/search.rs（2件）

本番の接続先: [crates/lattice-core/src/search.rs](../../crates/lattice-core/src/search.rs)。

境界: 実Store/FTSと制御embeddingを用いて検索融合を実行。実モデルの関連度評価ではない。

重複判断: TSは表示用filter/excerpt、e2eはfixture hitの操作。検索backendの試験を削らない。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T142"></a>[T142:147](../../crates/lattice-core/src/search.rs#L147) | rrf_prefers_agreement | RRFで複数検索が一致した結果を優先する | 維持 / 成功 |
| <a id="T143"></a>[T143:196](../../crates/lattice-core/src/search.rs#L196) | lexical_semantic_and_fallbacks | 実Storeの全文検索・埋め込み検索と失敗時fallbackを組み合わせる | 維持 / 成功 |

## crates/lattice-core/src/segments.rs（8件）

本番の接続先: [crates/lattice-core/src/segments.rs](../../crates/lattice-core/src/segments.rs)。

境界: 実翻訳単位・prompt/cache/再試行処理。翻訳応答を制御。

重複判断: overlay/readerに似た言語判定があるが実行runtimeが異なる。共通corpus候補、削除対象ではない。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T144"></a>[T144:492](../../crates/lattice-core/src/segments.rs#L492) | plain_text_matches_block_text | 翻訳用plain textと記事ブロック本文を一致させる | 維持 / 成功 |
| <a id="T145"></a>[T145:500](../../crates/lattice-core/src/segments.rs#L500) | term_mode_changes_prompt_not_language | 用語モードが指示だけを変え、対象言語を変えない | 維持 / 成功 |
| <a id="T146"></a>[T146:512](../../crates/lattice-core/src/segments.rs#L512) | japanese_sources_translate_into_english | 日本語原文の英訳指示・判定を守る | 維持 / 成功 |
| <a id="T147"></a>[T147:540](../../crates/lattice-core/src/segments.rs#L540) | user_instructions_extend_the_prompt_and_the_key | ユーザー指示を翻訳promptとキャッシュキーへ反映する | 維持 / 成功 |
| <a id="T148"></a>[T148:556](../../crates/lattice-core/src/segments.rs#L556) | long_unit_limits | 長い翻訳単位の分割上限を守る | 維持 / 成功 |
| <a id="T149"></a>[T149:564](../../crates/lattice-core/src/segments.rs#L564) | reconcile_rejects_duplicates_and_garbage | 翻訳結果の重複・不正IDを受け入れない | 維持 / 成功 |
| <a id="T150"></a>[T150:577](../../crates/lattice-core/src/segments.rs#L577) | batch_retry_and_resplit | 翻訳バッチの再試行と再分割を守る | 維持 / 成功 |
| <a id="T151"></a>[T151:611](../../crates/lattice-core/src/segments.rs#L611) | origin_is_per_snippet | 出典を翻訳snippet単位で保持する | 維持 / 成功 |

## crates/lattice-core/src/srs.rs（5件）

本番の接続先: [crates/lattice-core/src/srs.rs](../../crates/lattice-core/src/srs.rs)。

境界: 実間隔計算へ明示的な状態・gradeを与える純粋試験。

重複判断: quiz/vocabはDB登録・due selection、e2eは採点UI。各grade/interval境界を残す。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T152"></a>[T152:121](../../crates/lattice-core/src/srs.rs#L121) | good_every_time_follows_sm2_and_stops_at_the_maximum | Good継続時のSM2間隔増加と最大値を守る | 維持 / 成功 |
| <a id="T153"></a>[T153:130](../../crates/lattice-core/src/srs.rs#L130) | a_lapse_relearns_from_the_minimum_with_lower_ease | 忘却時にeaseを下げ、最小間隔から再学習する | 維持 / 成功 |
| <a id="T154"></a>[T154:140](../../crates/lattice-core/src/srs.rs#L140) | hard_and_easy_adjust_ease_within_bounds | Hard/Easyによるease変化を上下限内へ抑える | 維持 / 成功 |
| <a id="T155"></a>[T155:151](../../crates/lattice-core/src/srs.rs#L151) | short_minimum_interval_acts_as_a_learning_step | 短い最小間隔を学習ステップとして使う | 維持 / 成功 |
| <a id="T156"></a>[T156:161](../../crates/lattice-core/src/srs.rs#L161) | previews_order_hard_good_easy_even_for_short_intervals | 短い間隔でもHard・Good・Easyのpreview順を守る | 維持 / 成功 |

## crates/lattice-core/src/store.rs（21件）

本番の接続先: [crates/lattice-core/src/store.rs](../../crates/lattice-core/src/store.rs)。

境界: 旧schema/現schemaの実SQLite、一時ファイルbackup、queueの状態遷移。Tauri橋渡しは含まない。

重複判断: 21件は異なるmigration元/保存制約。新規DBで通る試験で旧DB移行を代替しない。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T157"></a>[T157:1662](../../crates/lattice-core/src/store.rs#L1662) | snapshot_migration_keeps_old_rows | snapshot追加migrationで既存行を保持する | 維持 / 成功 |
| <a id="T158"></a>[T158:1679](../../crates/lattice-core/src/store.rs#L1679) | upgrades_a_database_from_the_last_release_schema | 前リリースschemaのDBを現行へ上げる | 維持 / 成功 |
| <a id="T159"></a>[T159:1701](../../crates/lattice-core/src/store.rs#L1701) | quiz_migration_upgrades_an_existing_library | quiz追加migrationで既存ライブラリを維持する | 維持 / 成功 |
| <a id="T160"></a>[T160:1716](../../crates/lattice-core/src/store.rs#L1716) | vocab_migration_upgrades_an_existing_library | vocab追加migrationで既存ライブラリを維持する | 維持 / 成功 |
| <a id="T161"></a>[T161:1736](../../crates/lattice-core/src/store.rs#L1736) | cloze_cards_go_and_meaning_cards_keep_their_history | clozeを廃止してもmeaningカード履歴を保持する | 維持 / 成功 |
| <a id="T162"></a>[T162:1768](../../crates/lattice-core/src/store.rs#L1768) | group_migration_upgrades_an_existing_library | group追加migrationで既存ライブラリを維持する | 維持 / 成功 |
| <a id="T163"></a>[T163:1784](../../crates/lattice-core/src/store.rs#L1784) | relevance_migration_upgrades_an_existing_library | relevance追加migrationで既存ライブラリを維持する | 維持 / 成功 |
| <a id="T164"></a>[T164:1799](../../crates/lattice-core/src/store.rs#L1799) | feed_folder_migration_upgrades_an_existing_library | feed-folder追加migrationで既存ライブラリを維持する | 維持 / 成功 |
| <a id="T165"></a>[T165:1820](../../crates/lattice-core/src/store.rs#L1820) | feed_order_migration_keeps_the_order_by_name | feed-order追加migrationで従来の名前順を引き継ぐ | 維持 / 成功 |
| <a id="T166"></a>[T166:1841](../../crates/lattice-core/src/store.rs#L1841) | feed_filter_migration_upgrades_an_existing_library | feed-filter追加migrationで既存ライブラリを維持する | 維持 / 成功 |
| <a id="T167"></a>[T167:1859](../../crates/lattice-core/src/store.rs#L1859) | medium_feed_links_are_normalized_again | Mediumの旧feed URLを再正規化する | 維持 / 成功 |
| <a id="T168"></a>[T168:1886](../../crates/lattice-core/src/store.rs#L1886) | translation_migration_keeps_rows_searchable | 翻訳migration後も既存行を検索可能にする | 維持 / 成功 |
| <a id="T169"></a>[T169:1909](../../crates/lattice-core/src/store.rs#L1909) | re_extraction_reuses_ids_of_unchanged_blocks | 再抽出で内容不変のブロックIDを再利用する | 維持 / 成功 |
| <a id="T170"></a>[T170:1949](../../crates/lattice-core/src/store.rs#L1949) | deleting_an_article_leaves_nothing_orphaned | 記事削除時に関連レコードを孤児として残さない | 維持 / 成功 |
| <a id="T171"></a>[T171:2002](../../crates/lattice-core/src/store.rs#L2002) | re_enqueue_gives_a_failed_job_fresh_attempts | 失敗ジョブ再投入で試行回数をリセットする | 維持 / 成功 |
| <a id="T172"></a>[T172:2021](../../crates/lattice-core/src/store.rs#L2021) | a_job_that_keeps_failing_backs_off_doubling_then_fails_for_good | 連続失敗の待機を倍増し、上限到達で失敗を確定する | 維持 / 成功 |
| <a id="T173"></a>[T173:2048](../../crates/lattice-core/src/store.rs#L2048) | only_fetch_jobs_wait_for_a_running_fetch_on_the_same_host | 同一ホスト待機をfetchジョブだけに適用する | 維持 / 成功 |
| <a id="T174"></a>[T174:2067](../../crates/lattice-core/src/store.rs#L2067) | inbox_filters_and_tags | inbox条件とタグで記事を絞る | 維持 / 成功 |
| <a id="T175"></a>[T175:2091](../../crates/lattice-core/src/store.rs#L2091) | genre_and_feed_filters_restrict_lists_and_search | genre/feed条件を一覧・検索へ適用する | 維持 / 成功 |
| <a id="T176"></a>[T176:2127](../../crates/lattice-core/src/store.rs#L2127) | sorts_by_saved_and_published | 保存日時・公開日時で記事をソートする | 維持 / 成功 |
| <a id="T177"></a>[T177:2142](../../crates/lattice-core/src/store.rs#L2142) | settings_and_backup | 設定を保存し、DBバックアップへ反映する | 維持 / 成功 |

## crates/lattice-core/src/summarize.rs（1件）

本番の接続先: [crates/lattice-core/src/summarize.rs](../../crates/lattice-core/src/summarize.rs)。

境界: 実要約入力の整形・切詰め。要約生成の品質は対象外。

重複判断: jobsの要約保存・staleとは別。入力上限を低コストで守る。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T178"></a>[T178:90](../../crates/lattice-core/src/summarize.rs#L90) | formats_and_truncates | 要約応答を整形し、入力コンテキストの長さを制限する | 維持 / 成功 |

## crates/lattice-core/src/url_norm.rs（1件）

本番の接続先: [crates/lattice-core/src/url_norm.rs](../../crates/lattice-core/src/url_norm.rs)。

境界: 実URL正規化を入力例で検証。ネットワークは不要。

重複判断: navigationの許可schemeと異なり、重複判定用のcanonical URLを守る。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T179"></a>[T179:36](../../crates/lattice-core/src/url_norm.rs#L36) | strips_tracking_and_fragment | URLから追跡queryとfragmentを除く | 維持 / 成功 |

## crates/lattice-core/src/vocab.rs（10件）

本番の接続先: [crates/lattice-core/src/vocab.rs](../../crates/lattice-core/src/vocab.rs)。

境界: 実capture検証・語義解析・SQLite/card/CSV。生成応答・時刻は制御。

重複判断: src/vocabは選択/mark、e2eは操作。lemma統合・job競合・カード履歴はbackend固有。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T180"></a>[T180:616](../../crates/lattice-core/src/vocab.rs#L616) | captures_are_bounded_english_and_inside_their_sentence | 単語captureを短い英語・文内の選択範囲へ制限する | 維持 / 成功 |
| <a id="T181"></a>[T181:630](../../crates/lattice-core/src/vocab.rs#L630) | parse_keeps_usable_senses_by_number | 語義生成応答から番号に対応する有効な語義を残す | 維持 / 成功 |
| <a id="T182"></a>[T182:648](../../crates/lattice-core/src/vocab.rs#L648) | parse_needs_the_definition_and_a_new_example | 語義には定義と新しい例文を必須とする | 維持 / 成功 |
| <a id="T183"></a>[T183:664](../../crates/lattice-core/src/vocab.rs#L664) | the_job_merges_forms_of_one_lemma_into_one_entry | 同じlemmaの語形を一つの単語項目へ統合する | 維持 / 成功 |
| <a id="T184"></a>[T184:703](../../crates/lattice-core/src/vocab.rs#L703) | a_capture_while_the_job_runs_is_queued_again_when_it_finishes | 語義ジョブ実行中の追加captureを完了後に再投入する | 維持 / 成功 |
| <a id="T185"></a>[T185:716](../../crates/lattice-core/src/vocab.rs#L716) | editing_suspending_and_deleting | 単語の編集・停止・削除をDBへ反映する | 維持 / 成功 |
| <a id="T186"></a>[T186:744](../../crates/lattice-core/src/vocab.rs#L744) | words_join_todays_review_as_one_card_within_the_shared_limits | 単語を共通上限内の一枚の復習カードとして扱う | 維持 / 成功 |
| <a id="T187"></a>[T187:775](../../crates/lattice-core/src/vocab.rs#L775) | regenerating_redoes_the_sense_and_keeps_the_card | 語義再生成でカードを維持して語義だけを更新する | 維持 / 成功 |
| <a id="T188"></a>[T188:808](../../crates/lattice-core/src/vocab.rs#L808) | contexts_link_to_the_article_and_survive_its_deletion | 出典記事への紐づけと記事削除後の文脈保持を守る | 維持 / 成功 |
| <a id="T189"></a>[T189:834](../../crates/lattice-core/src/vocab.rs#L834) | csv_is_escaped_for_anki_and_backs_like_the_card | Anki向けCSVのescapeとカード裏面相当の内容を守る | 維持 / 成功 |

## e2e/chat.spec.ts（3件）

本番の接続先: [src/chat/ChatPane.tsx](../../src/chat/ChatPane.tsx)、[src/settings/ChatSettings.tsx](../../src/settings/ChatSettings.tsx)、[src/app/useChatBridge.ts](../../src/app/useChatBridge.ts)、[src/api.ts](../../src/api.ts)。

境界: 実React UI → mockIPC。対話応答・設定はメモリfixture。DB再open/実LLMなし。

重複判断: vim unitは編集状態、core chatは資料/履歴、ここはDOM操作。T190のみF07。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T190"></a>[T190:11](../../e2e/chat.spec.ts#L11) | the chat budget is a setting under 要約・対話 and persists | 対話予算の設定送信と同じセッション内での再表示を守る | 範囲・名称修正 / [P3 F07](findings.md#F07) |
| <a id="T191"></a>[T191:24](../../e2e/chat.spec.ts#L24) | Vim keys in the chat input: off by default, modes, motions, edits, undo, Ctrl+Enter sends | 対話入力のVim有効化・モード・編集・undo・送信操作を守る | 維持 / 成功 |
| <a id="T192"></a>[T192:67](../../e2e/chat.spec.ts#L67) | the chat scope offers each open article and all of them, and follows the tabs | 開いている記事とタブ変更を対話scope候補へ反映する | 維持 / 成功 |

## e2e/commands.test.ts（1件）

本番の接続先: [src/api.ts](../../src/api.ts)、[e2e/mock.ts](../../e2e/mock.ts)。

境界: Nodeでソースのinvoke文字列とmock keyを比較。実Tauri handler登録・引数型・権限は照合しない。

重複判断: モックの更新漏れを安価に検出するため維持。完全なIPC契約とは呼ばない（R01）。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T193"></a>[T193:6](../../e2e/commands.test.ts#L6) | the e2e mock answers exactly the commands src/api.ts invokes | api.tsの文字列invoke名とモックhandler名の集合を一致させる | 維持 / 成功 |

## e2e/contextmenu.spec.ts（4件）

本番の接続先: [src/library/ListPane.tsx](../../src/library/ListPane.tsx)、[src/library/articleMenu.ts](../../src/library/articleMenu.ts)、[src/layout/TabStrip.tsx](../../src/layout/TabStrip.tsx)、[src/api.ts](../../src/api.ts)。

境界: 実React UI → mockIPC。操作要求・モック一覧変化。native clipboard/DB削除連鎖は対象外。

重複判断: articleMenu unitはaction集合。delete specはEsc取消もあり重複削除しない。T197はtab固有入口。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T194"></a>[T194:10](../../e2e/contextmenu.spec.ts#L10) | right-click on a row: favorite, read state, a new tab, and delete with confirmation | 行メニューのお気に入り・既読・新規タブ・削除確認を操作する | 維持 / 成功 |
| <a id="T195"></a>[T195:39](../../e2e/contextmenu.spec.ts#L39) | the menu key and Shift+F10 open the cursor row's menu; Esc returns to the row | メニューキー/Shift+F10でカーソル行を開き、Escで戻す | 維持 / 成功 |
| <a id="T196"></a>[T196:54](../../e2e/contextmenu.spec.ts#L54) | with rows picked, the menu applies the bulk actions to all of them | 複数選択のメニュー操作を全対象へ送る | 維持 / 成功 |
| <a id="T197"></a>[T197:80](../../e2e/contextmenu.spec.ts#L80) | right-click on a tab: the article's menu; an unsaved page's tab offers what applies to its URL | 記事タブと未保存ページタブで適用可能なメニュー項目を分ける | 維持 / 成功 |

## e2e/css.spec.ts（2件）

本番の接続先: [src/theme.css](../../src/theme.css)、[src/ui/Popover.tsx](../../src/ui/Popover.tsx)、[src/api.ts](../../src/api.ts)。

境界: 実React UI → mockIPC。Chromium computed styleを観測。native OS cursor描画や全themeの目視ではない。

重複判断: 機能試験と違いcursor/selection/disabled affordanceを直接検証するため維持。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T198"></a>[T198:7](../../e2e/css.spec.ts#L7) | clickable controls show the hand; the nav and the list do not select as text, the Reader does | クリック可能要素のcursorと場所別text-selection CSSを守る | 維持 / 成功 |
| <a id="T199"></a>[T199:20](../../e2e/css.spec.ts#L20) | a disabled button shows not-allowed and keeps its tooltip | 無効ボタンのcursorとtooltipを保持する | 維持 / 成功 |

## e2e/cursor.spec.ts（2件）

本番の接続先: [src/app/useKeyboard.ts](../../src/app/useKeyboard.ts)、[src/library/ListPane.tsx](../../src/library/ListPane.tsx)、[src/app/useDocuments.ts](../../src/app/useDocuments.ts)、[src/api.ts](../../src/api.ts)。

境界: 実React UI → mockIPC。実keyboardイベントとUI遷移。native Pageは呼出し記録。

重複判断: keys unitはbinding決定だけ。tabs/menusと異なるcursor操作入口。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T200"></a>[T200:8](../../e2e/cursor.spec.ts#L8) | j / k move the cursor without opening; Enter opens it in the Reader | j/kで開かずに行移動し、EnterでReaderへ開く | 維持 / 成功 |
| <a id="T201"></a>[T201:25](../../e2e/cursor.spec.ts#L25) | Shift+Enter opens the cursor's article as a page | Shift+Enterでカーソル記事をPageへ開く | 維持 / 成功 |

## e2e/delete.spec.ts（1件）

本番の接続先: [src/library/ListPane.tsx](../../src/library/ListPane.tsx)、[src/ui/ConfirmDialog.tsx](../../src/ui/ConfirmDialog.tsx)、[src/app/useLibrary.ts](../../src/app/useLibrary.ts)、[src/api.ts](../../src/api.ts)。

境界: 実React UI → mockIPC。削除先はin-memory記事配列。DB cascadeはcore store。

重複判断: contextmenuの確定削除に対しEsc取消を追加で守るため維持。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T202"></a>[T202:4](../../e2e/delete.spec.ts#L4) | deleting an article asks first; Esc keeps it, 削除 removes it | 記事削除の確認・Esc取消・確定をUIから行う | 維持 / 成功 |

## e2e/english.spec.ts（5件）

本番の接続先: [src/i18n/index.ts](../../src/i18n/index.ts)、[src/settings/SettingsView.tsx](../../src/settings/SettingsView.tsx)、[src/app/App.tsx](../../src/app/App.tsx)、[src/api.ts](../../src/api.ts)。

境界: 実React UI → mockIPC。英語localeの実画面。backend error/設定はmock。

重複判断: カタログ単体はDOM配線を守らない。日本語specと異なるlocaleなので保持。T203はF07。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T203"></a>[T203:6](../../e2e/english.spec.ts#L6) | an English WebView starts in English and stores the choice | 英語localeで起動し、英語UIと設定コマンド送信を確認する | 範囲・名称修正 / [P3 F07](findings.md#F07) |
| <a id="T204"></a>[T204:16](../../e2e/english.spec.ts#L16) | the Reader, jobs, feeds and review screens read in English | Reader・ジョブ・feed・復習画面の主要英語表示を守る | 維持 / 成功 |
| <a id="T205"></a>[T205:36](../../e2e/english.spec.ts#L36) | every settings section has an English title, and a backend error is shown in English | 設定19カテゴリの英語見出しとcoded errorの英語表示を守る | 維持 / 成功 |
| <a id="T206"></a>[T206:72](../../e2e/english.spec.ts#L72) | the command palette matches English commands | パレットの英語コマンド検索を守る | 維持 / 成功 |
| <a id="T207"></a>[T207:80](../../e2e/english.spec.ts#L80) | Vocabulary reads in English | 単語帳の主要英語表示を守る | 維持 / 成功 |

## e2e/feedfilter.spec.ts（3件）

本番の接続先: [src/feeds/FeedFilterEditor.tsx](../../src/feeds/FeedFilterEditor.tsx)、[src/feeds/FeedsView.tsx](../../src/feeds/FeedsView.tsx)、[src/settings/SettingsView.tsx](../../src/settings/SettingsView.tsx)、[src/api.ts](../../src/api.ts)。

境界: 実React UI → mockIPC。採否結果・regex拒否はmock生成。実poll/LLMを通らない。

重複判断: core/feed_filterが規則意味論、ここは編集とエラー表示。相補。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T208"></a>[T208:12](../../e2e/feedfilter.spec.ts#L12) | a feed's rejected entries show why, and can be imported or let in by dropping the rule | feed拒否理由を表示し、手動取込・規則削除から許可する | 維持 / 成功 |
| <a id="T209"></a>[T209:39](../../e2e/feedfilter.spec.ts#L39) | rules are edited per feed, and a bad regex is refused with the reason | feed別規則を編集し、不正正規表現エラーを表示する | 維持 / 成功 |
| <a id="T210"></a>[T210:70](../../e2e/feedfilter.spec.ts#L70) | the global filter lives in Settings › 取り込みフィルタ | 設定画面からglobal feedフィルタを編集する | 維持 / 成功 |

## e2e/feedfolders.spec.ts（5件）

本番の接続先: [src/feeds/FeedFoldersCard.tsx](../../src/feeds/FeedFoldersCard.tsx)、[src/feeds/FeedsView.tsx](../../src/feeds/FeedsView.tsx)、[src/library/NavFolders.tsx](../../src/library/NavFolders.tsx)、[src/app/Palette.tsx](../../src/app/Palette.tsx)、[src/api.ts](../../src/api.ts)。

境界: 実React UI → mockIPC。OPML/購読はfixture応答。mockが本番folderTreeを再利用する。

重複判断: core/feed_foldersを独立oracleとして残す。UI scope・入力・メニューの配線は固有。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T211"></a>[T211:21](../../e2e/feedfolders.spec.ts#L21) | feeds move into a folder; the nav shows it as a scope over its feeds, with their unread summed | feedをフォルダへ移し、scopeと未読合計をUIへ反映する | 維持 / 成功 |
| <a id="T212"></a>[T212:60](../../e2e/feedfolders.spec.ts#L60) | several feed URLs, one per line, are subscribed into the chosen folder | 複数行URLを選択フォルダへ購読する | 維持 / 成功 |
| <a id="T213"></a>[T213:85](../../e2e/feedfolders.spec.ts#L85) | a nav folder's context menu renames it and deletes it, keeping its feeds | navのフォルダを改名・削除し、フィードを残すUIを守る | 維持 / 成功 |
| <a id="T214"></a>[T214:110](../../e2e/feedfolders.spec.ts#L110) | OPML outlines become folders on import; the palette finds folders | OPML取込後のフォルダ表示とパレット検索を守る | 維持 / 成功 |
| <a id="T215"></a>[T215:135](../../e2e/feedfolders.spec.ts#L135) | a failed Find shows its error under the field, and editing the field clears it | feed検索失敗をfield下へ出し、入力変更で消す | 維持 / 成功 |

## e2e/feedname.spec.ts（2件）

本番の接続先: [src/feeds/FeedsView.tsx](../../src/feeds/FeedsView.tsx)、[src/api.ts](../../src/api.ts)。

境界: 実React UI → mockIPC。rename_feedの引数まで検証。DB保存はcore。

重複判断: 通常名/カスタム名は異なる初期状態。空欄branchだけF09。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T216"></a>[T216:17](../../e2e/feedname.spec.ts#L17) | the name field starts with the feed's own name, to edit rather than retype | feed元名を編集欄へ入れ、未変更を保存不可にする | 維持 / 成功 |
| <a id="T217"></a>[T217:27](../../e2e/feedname.spec.ts#L27) | a custom name starts the field; the feed's own name or an empty field saves as no custom name | カスタム名からfeed元名へ戻すとname:nullを送る | 補強 / [P2 F09](findings.md#F09) |

## e2e/feedorder.spec.ts（2件）

本番の接続先: [src/library/NavFolders.tsx](../../src/library/NavFolders.tsx)、[src/feeds/feedFolders.ts](../../src/feeds/feedFolders.ts)、[src/api.ts](../../src/api.ts)。

境界: 実React UI → mockIPC。ドラッグ/keyboard入力は実DOM。mockもplaceFeedsを使いbackendの順序計算を代替。

重複判断: TS unitと共有実装部分があるがevent配線は独立。Rust順序試験を削らない。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T218"></a>[T218:41](../../e2e/feedorder.spec.ts#L41) | dragging feeds in the sidebar reorders them and moves them between folders, without opening them | feedドラッグで順序・所属を変え、記事を誤って開かない | 維持 / 成功 |
| <a id="T219"></a>[T219:82](../../e2e/feedorder.spec.ts#L82) | Alt+↑ / ↓ move the focused feed or folder, across folders; folders drag too | Alt上下とフォルダドラッグでfeed・フォルダ順を変える | 維持 / 成功 |

## e2e/groups.spec.ts（8件）

本番の接続先: [src/library/NavGroups.tsx](../../src/library/NavGroups.tsx)、[src/library/GroupPicker.tsx](../../src/library/GroupPicker.tsx)、[src/import/ImportView.tsx](../../src/import/ImportView.tsx)、[src/app/Palette.tsx](../../src/app/Palette.tsx)、[src/settings/ExportSection.tsx](../../src/settings/ExportSection.tsx)、[src/api.ts](../../src/api.ts)。

境界: 実React UI → mockIPC。グループCRUD/export/importはmockの状態・引数。

重複判断: core groups/exportは実DB、Node libraryは集合計算。各UI入口が違うので9件維持。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T220"></a>[T220:11](../../e2e/groups.spec.ts#L11) | a sidebar group is a scope; groups are created, renamed and deleted there (articles stay) | sidebarグループの作成・scope・改名・削除を操作する | 維持 / 成功 |
| <a id="T221"></a>[T221:47](../../e2e/groups.spec.ts#L47) | the Reader's group chips: pick a group, create one, remove one | Readerのグループ所属を選択・新規作成・解除する | 維持 / 成功 |
| <a id="T222"></a>[T222:72](../../e2e/groups.spec.ts#L72) | an empty scope shows no filters, sort or Select | 空scopeで不要なfilter/sort/select操作を出さない | 維持 / 成功 |
| <a id="T223"></a>[T223:78](../../e2e/groups.spec.ts#L78) | list rows picked with 選択 and Shift+click go into a group together | 行選択とShift範囲選択を一括グループ追加へつなぐ | 維持 / 成功 |
| <a id="T224"></a>[T224:103](../../e2e/groups.spec.ts#L103) | a group is a facet, a search scope and a chat scope (このグループ) | グループをfacet・検索scope・対話scopeとして使う | 維持 / 成功 |
| <a id="T225"></a>[T225:131](../../e2e/groups.spec.ts#L131) | imports land in the chosen groups; the list's group is chosen first | 取り込み先グループを選択し、表示中グループを初期選択する | 維持 / 成功 |
| <a id="T226"></a>[T226:162](../../e2e/groups.spec.ts#L162) | the palette opens a group, adds the open article to one, and saves a URL into the list's group | パレットでグループを開き、記事・URLを所属へ追加する | 維持 / 成功 |
| <a id="T227"></a>[T227:184](../../e2e/groups.spec.ts#L184) | the JSON export can be limited to a group | グループ限定JSON exportのコマンド引数を送る | 維持 / 成功 |

## e2e/history.spec.ts（3件）

本番の接続先: [src/app/useHistory.ts](../../src/app/useHistory.ts)、[src/app/history.ts](../../src/app/history.ts)、[src/app/TitleBar.tsx](../../src/app/TitleBar.tsx)、[src/api.ts](../../src/api.ts)。

境界: 実React UI → mockIPC。ブラウザDOMでmouse/keyboardを送る。native webview内履歴ではない。

重複判断: history unitはstack不変条件、UIは訪問記録と操作配線。画面/設定/tabは異なる遷移。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T228"></a>[T228:17](../../e2e/history.spec.ts#L17) | screens and scopes: the side buttons, Alt+arrows and the title bar go back and forward | サイドボタン・Alt矢印・titlebarで画面/scope履歴を辿る | 維持 / 成功 |
| <a id="T229"></a>[T229:41](../../e2e/history.spec.ts#L41) | settings sections are places of their own | 設定カテゴリごとの移動履歴を守る | 維持 / 成功 |
| <a id="T230"></a>[T230:57](../../e2e/history.spec.ts#L57) | articles opened in the focused tab come back in order; a tab switch is undone by switching back | 記事遷移・タブ切替を戻る/進む履歴へ反映する | 維持 / 成功 |

## e2e/i18n.spec.ts（1件）

本番の接続先: [src/settings/LanguageSettings.tsx](../../src/settings/LanguageSettings.tsx)、[src/i18n/index.ts](../../src/i18n/index.ts)、[src/api.ts](../../src/api.ts)。

境界: 実React UI → mockIPC。言語はmock設定。実DB再起動の保持は見ない。

重複判断: English起動と異なりlive switchを守る。F07は名前の範囲修正であり削除ではない。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T231"></a>[T231:3](../../e2e/i18n.spec.ts#L3) | the display language switches live in Settings and is stored in the backend | 表示言語を即時切替し、backend設定コマンドを送る | 範囲・名称修正 / [P3 F07](findings.md#F07) |

## e2e/jobs.spec.ts（2件）

本番の接続先: [src/jobs/JobsView.tsx](../../src/jobs/JobsView.tsx)、[src/ui/InfoTip.tsx](../../src/ui/InfoTip.tsx)、[src/api.ts](../../src/api.ts)。

境界: 実React UI → mockIPC。固定job一覧とtooltip。実runner/retryの結果は含まない。

重複判断: backend job_statusとは別の説明・focus。T237の静的badgeを統合できる先。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T232"></a>[T232:6](../../e2e/jobs.spec.ts#L6) | job types show their names, with the ID on hover | ジョブ種別の表示名とhover時IDを守る | 維持 / 成功 |
| <a id="T233"></a>[T233:14](../../e2e/jobs.spec.ts#L14) | each job type's ⓘ explains it on hover and on keyboard focus, and describes the icon | ジョブ説明をhover/keyboard focusで出し、iconを説明付けする | 維持 / 成功 |

## e2e/library.spec.ts（4件）

本番の接続先: [src/library/ListPane.tsx](../../src/library/ListPane.tsx)、[src/library/FacetPopover.tsx](../../src/library/FacetPopover.tsx)、[src/library/Nav.tsx](../../src/library/Nav.tsx)、[src/app/useLibraryView.ts](../../src/app/useLibraryView.ts)、[src/api.ts](../../src/api.ts)。

境界: 実React UI → mockIPC。fixture一覧に対する実frontend filter/表示。SQL検索は未実行。

重複判断: library unitは集合境界、UIは選択・件数の配線。T237のみ単独起動を統合候補F14。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T234"></a>[T234:11](../../e2e/library.spec.ts#L11) | sidebar counts each scope, and a scope narrows the list | sidebar件数とscope選択後の一覧を合わせる | 維持 / 成功 |
| <a id="T235"></a>[T235:35](../../e2e/library.spec.ts#L35) | facets AND across dimensions, show counts in the set, and clear | facet次元間AND・候補件数・解除をUIで守る | 維持 / 成功 |
| <a id="T236"></a>[T236:60](../../e2e/library.spec.ts#L60) | an empty result offers to drop one condition | 該当なしから条件一つを解除して結果を回復する | 維持 / 成功 |
| <a id="T237"></a>[T237:78](../../e2e/library.spec.ts#L78) | the failed-jobs badge reflects the job overview | fixtureの失敗ジョブ件数2をnavに表示する | 統合候補 / [P3 F14](findings.md#F14) |

## e2e/menus.spec.ts（6件）

本番の接続先: [src/ui/Popover.tsx](../../src/ui/Popover.tsx)、[src/browser/BrowserView.tsx](../../src/browser/BrowserView.tsx)、[src/library/GroupPicker.tsx](../../src/library/GroupPicker.tsx)、[src/library/NavGroups.tsx](../../src/library/NavGroups.tsx)、[src/api.ts](../../src/api.ts)。

境界: 実React UI → mockIPC。browser_hide遅延やfocusはmock/event注入。native webview重なり自体は見ない。

重複判断: shell H8はsnapshot/font、こちらは表示順・外クリック・Esc/座標。T240の範囲だけF12。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T238"></a>[T238:17](../../e2e/menus.spec.ts#L17) | a menu over the page webview stays invisible until the webview is hidden, then shows whole (H22) | webview非表示完了までメニューを不可視にし、その後表示する | 維持 / 成功 |
| <a id="T239"></a>[T239:48](../../e2e/menus.spec.ts#L48) | a menu over no webview is drawn in the frame it first appears (H22) | webviewがなければメニューを初回frameから表示する | 維持 / 成功 |
| <a id="T240"></a>[T240:67](../../e2e/menus.spec.ts#L67) | a press outside closes the group picker and a menu; so does a click in a page webview (H23) | DOM内の外側クリックでgroup pickerとメニューを閉じる | 範囲・名称修正 / [P3 F12](findings.md#F12) |
| <a id="T241"></a>[T241:90](../../e2e/menus.spec.ts#L90) | a click in a page in another pane closes a popover; the focus a page gets when a menu hides it does not (H23) | browser-focusイベントの由来に応じてpopoverを閉じる/保つ | 維持 / 成功 |
| <a id="T242"></a>[T242:114](../../e2e/menus.spec.ts#L114) | Esc closes a popover without also clearing the filters (H23) | Escでpopoverだけを閉じ、filterは残す | 維持 / 成功 |
| <a id="T243"></a>[T243:129](../../e2e/menus.spec.ts#L129) | a nav group's ⋯ menu opens beside its trigger, not at the window's left edge (H24) | navグループメニューをtriggerの横へ配置する | 維持 / 成功 |

## e2e/pageview.spec.ts（1件）

本番の接続先: [src/browser/BrowserView.tsx](../../src/browser/BrowserView.tsx)、[src/app/App.tsx](../../src/app/App.tsx)、[src/api.ts](../../src/api.ts)。

境界: 実React UI → mockIPC。browser_show/hideのmock呼出し順を観測。native画面はない。

重複判断: tabsはtab切替、ここはlibrary離脱復帰のhide raceで独立。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T244"></a>[T244:12](../../e2e/pageview.spec.ts#L12) | leaving the library hides the page, and coming back shows it with no hide sent after the show | library離脱でPageを隠し、復帰後に古いhideを送らない | 維持 / 成功 |

## e2e/palette.spec.ts（4件）

本番の接続先: [src/app/Palette.tsx](../../src/app/Palette.tsx)、[src/app/useDocuments.ts](../../src/app/useDocuments.ts)、[src/api.ts](../../src/api.ts)。

境界: 実React UI → mockIPC。URL保存/検索結果はmock。Ctrl+EnterのUI配線を観測。

重複判断: tabsのEnterでPageを開く経路と相補。T247は名前だけF11。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T245"></a>[T245:6](../../e2e/palette.spec.ts#L6) | Ctrl+K toggles the palette; > lists commands only | Ctrl+K開閉とコマンド専用パレットを守る | 維持 / 成功 |
| <a id="T246"></a>[T246:25](../../e2e/palette.spec.ts#L25) | Tab stacks a tag as a facet and keeps the palette open | Tabでタグfacetを積み、パレットを開いたままにする | 維持 / 成功 |
| <a id="T247"></a>[T247:36](../../e2e/palette.spec.ts#L36) | a pasted URL opens as a page, or Ctrl+Enter saves it to the Index | 貼り付けURLをCtrl+EnterでIndexへ保存する | 範囲・名称修正 / [P3 F11](findings.md#F11) |
| <a id="T248"></a>[T248:46](../../e2e/palette.spec.ts#L46) | a pasted URL of a saved article offers its Reader view first | 保存済みURLのパレット候補ではReaderを優先する | 維持 / 成功 |

## e2e/panes.spec.ts（2件）

本番の接続先: [src/layout/Splitter.tsx](../../src/layout/Splitter.tsx)、[src/app/App.tsx](../../src/app/App.tsx)、[src/api.ts](../../src/api.ts)。

境界: 実React UI → mockIPC。実geometry・localStorage reload。OSwindow位置とは別。

重複判断: layout unitの比率計算と別のpointer/keyboard/永続UI配線。2件とも維持。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T249"></a>[T249:3](../../e2e/panes.spec.ts#L3) | a pane keeps the width it was dragged to across a reload | ペイン幅のドラッグ結果をlocalStorage経由でreload後も保つ | 維持 / 成功 |
| <a id="T250"></a>[T250:19](../../e2e/panes.spec.ts#L19) | the keyboard resizes within limits, and a double-click restores the default | keyboardリサイズの上下限とダブルクリック初期化を守る | 維持 / 成功 |

## e2e/pdf.spec.ts（1件）

本番の接続先: [src/import/ImportView.tsx](../../src/import/ImportView.tsx)、[src/reader/Reader.tsx](../../src/reader/Reader.tsx)、[src/api.ts](../../src/api.ts)。

境界: 実React UI → mockIPC。mock import_pdf_fileはprepared articleを返す。PDF bytes/dialog/parserを通らない。

重複判断: core/pdfとingest/pdfの実bytes試験を残す。UIのPage非表示はここ固有。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T251"></a>[T251:3](../../e2e/pdf.spec.ts#L3) | a PDF picked on the import screen opens in the Reader, without Page or rendering | PDF取込コマンドの結果をReaderへ開き、Page/描画を出さない | 維持 / 成功 |

## e2e/popout.spec.ts（8件）

本番の接続先: [src/app/useWindows.ts](../../src/app/useWindows.ts)、[src/app/useChatBridge.ts](../../src/app/useChatBridge.ts)、[src/app/usePageLang.ts](../../src/app/usePageLang.ts)、[src/app/host.ts](../../src/app/host.ts)、[src/api.ts](../../src/api.ts)。

境界: 実React UI → mockIPC。queryで窓labelを模倣。emit_toは記録されるだけで実他窓へ届かない。

重複判断: native popoutとwindow unitは別境界。main/chat/documentの配線差を維持。T255/256はF10。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T252"></a>[T252:25](../../e2e/popout.spec.ts#L25) | 別ウィンドウで開く moves the tab to a new document window whose layout waits in storage | タブ別窓化でlayoutを保存し、新しいdocument windowを要求する | 維持 / 成功 |
| <a id="T253"></a>[T253:38](../../e2e/popout.spec.ts#L38) | a document window shows only its tabs, hands one back to the main window, and closes when empty | document windowの限定layoutとmainへの返却・空窓closeを守る | 維持 / 成功 |
| <a id="T254"></a>[T254:76](../../e2e/popout.spec.ts#L76) | the main window restores pop-outs at startup, keeps the chat in its window, and opens what comes back | main起動で保存済み別窓を復元し、返却記事を開く | 維持 / 成功 |
| <a id="T255"></a>[T255:97](../../e2e/popout.spec.ts#L97) | the chat dock pops out from its header; the chat window docks back through the main window | 対話ヘッダから別窓要求を送り、dockを閉じて状態保存する | 範囲・名称修正 / [P3 F10](findings.md#F10) |
| <a id="T256"></a>[T256:105](../../e2e/popout.spec.ts#L105) | the chat window is the pane alone; its citations and its close go to the main window | chat専用画面のscope同期とdock復帰要求・closeを守る | 範囲・名称修正 / [P3 F10](findings.md#F10) |
| <a id="T257"></a>[T257:129](../../e2e/popout.spec.ts#L129) | closing the chat window only closes it: main does not dock it, and 対話 then opens the dock | chat窓closeだけではdockを開かず、後の対話操作で開く | 維持 / 成功 |
| <a id="T258"></a>[T258:147](../../e2e/popout.spec.ts#L147) | only the main window sends the Page language to the pages; a pop-out takes main's choice instead of resetting it | mainだけがPage言語を送信し、別窓はmainの値を受け取る | 維持 / 成功 |
| <a id="T259"></a>[T259:170](../../e2e/popout.spec.ts#L170) | the main window sends the Page language to the pages, and a choice made in a pop-out | 別窓で選んだPage言語もmain経由で配信する | 維持 / 成功 |

## e2e/quiz.spec.ts（6件）

本番の接続先: [src/quiz/QuizPanel.tsx](../../src/quiz/QuizPanel.tsx)、[src/quiz/QuizReview.tsx](../../src/quiz/QuizReview.tsx)、[src/settings/QuizSettings.tsx](../../src/settings/QuizSettings.tsx)、[src/api.ts](../../src/api.ts)。

境界: 実React UI → mockIPC。生成は即時mock、gradeはdueをfalseにするだけ。SRS時計/queue/失敗はcore側。

重複判断: core quiz/srsが採点意味論、ここは回答UI・出典・state継続。モック統合として保持。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T260"></a>[T260:12](../../e2e/quiz.spec.ts#L12) | 理解度チェック: answer, see the source, then add the answers to review | quiz回答・解説/出典・復習への追加をUIでつなぐ | 維持 / 成功 |
| <a id="T261"></a>[T261:63](../../e2e/quiz.spec.ts#L63) | 理解度チェック stays open with its progress across another screen and another tab | 画面・タブ変更をまたいでquiz進捗を保持する | 維持 / 成功 |
| <a id="T262"></a>[T262:99](../../e2e/quiz.spec.ts#L99) | an article without a quiz offers to make one | quiz未生成状態から生成コマンドと即時モック結果を表示する | 維持 / 成功 |
| <a id="T263"></a>[T263:109](../../e2e/quiz.spec.ts#L109) | 今日の復習: due cards one by one with their next intervals, then a summary | dueカードの採点・次間隔表示・完了集計をUIで進める | 維持 / 成功 |
| <a id="T264"></a>[T264:141](../../e2e/quiz.spec.ts#L141) | a card's source opens the Reader at the passage | 復習カード出典をReaderの対象箇所へ開く | 維持 / 成功 |
| <a id="T265"></a>[T265:152](../../e2e/quiz.spec.ts#L152) | Settings › 復習 sets the minimum interval with a unit | 復習の最小間隔を単位付きで設定する | 維持 / 成功 |

## e2e/reader.spec.ts（5件）

本番の接続先: [src/reader/Reader.tsx](../../src/reader/Reader.tsx)、[src/reader/mixed.ts](../../src/reader/mixed.ts)、[src/app/useDocuments.ts](../../src/app/useDocuments.ts)、[src/api.ts](../../src/api.ts)。

境界: 実React UI → mockIPC。翻訳要求とmock進捗。実翻訳job/LLMは通らない。

重複判断: mixed unitは表示判定、Rust jobsは生成/cache。自動翻訳offやPage適用可否はUI固有。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T266"></a>[T266:17](../../e2e/reader.spec.ts#L17) | the language segment switches every block; a block flips on its own | Reader全体とブロック単位の原文/訳文切替を守る | 維持 / 成功 |
| <a id="T267"></a>[T267:42](../../e2e/reader.spec.ts#L42) | the summary expands, and imported Markdown has no Page view | 要約の展開とMarkdown記事のPage非表示を守る | 維持 / 成功 |
| <a id="T268"></a>[T268:55](../../e2e/reader.spec.ts#L55) | picking 訳文 on an untranslated article starts its translation and shows the progress | 未翻訳記事の訳文選択から翻訳要求と進捗表示へつなぐ | 維持 / 成功 |
| <a id="T269"></a>[T269:71](../../e2e/reader.spec.ts#L71) | with 表示を切り替えたら自動で翻訳 off, switching the view translates nothing | 自動翻訳設定オフでは表示切替だけで翻訳要求を送らない | 維持 / 成功 |
| <a id="T270"></a>[T270:93](../../e2e/reader.spec.ts#L93) | 訳し直す is in the ⋯ menu, with what it does, as soon as an article has a translation | 翻訳済み記事の再翻訳メニューと説明を表示する | 維持 / 成功 |

## e2e/relevance.spec.ts（3件）

本番の接続先: [src/library/ListPane.tsx](../../src/library/ListPane.tsx)、[src/reader/Reader.tsx](../../src/reader/Reader.tsx)、[src/settings/RelevanceSettings.tsx](../../src/settings/RelevanceSettings.tsx)、[src/api.ts](../../src/api.ts)。

境界: 実React UI → mockIPC。score/profileはfixture。再評価の実LLM/DB更新は通らない。

重複判断: core relevanceとNode libraryを表示・操作へつなぐため維持。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T271"></a>[T271:19](../../e2e/relevance.spec.ts#L19) | 重要 lists the important articles, which carry a mark with the reason | 重要scopeの記事と重要度理由のmarkを表示する | 維持 / 成功 |
| <a id="T272"></a>[T272:31](../../e2e/relevance.spec.ts#L31) | sorting and filtering by importance; the Reader shows the reason | 重要度sort/filterとReaderの理由表示を守る | 維持 / 成功 |
| <a id="T273"></a>[T273:58](../../e2e/relevance.spec.ts#L58) | without a profile nothing is rated and settings say why; with one, scores can be redone | プロフィール未設定の案内と設定後の再評価要求を守る | 維持 / 成功 |

## e2e/search.spec.ts（3件）

本番の接続先: [src/search/SearchPane.tsx](../../src/search/SearchPane.tsx)、[src/app/useSearch.ts](../../src/app/useSearch.ts)、[src/api.ts](../../src/api.ts)。

境界: 実React UI → mockIPC。検索はfixture hit。SQL FTS・embedding推論・ランキング品質は対象外。

重複判断: core searchは融合、TS searchはexcerpt/filter。UI keyboard/scope配線は別。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T274"></a>[T274:9](../../e2e/search.spec.ts#L9) | search groups hits by article, filters by match type, and Esc leaves it | 検索結果を記事別に束ね、方式filterとEsc退出を守る | 維持 / 成功 |
| <a id="T275"></a>[T275:34](../../e2e/search.spec.ts#L34) | the arrows move through the hits and Enter opens the Reader at the hit block | 検索hitを矢印で選び、Enterで対象ブロックへ開く | 維持 / 成功 |
| <a id="T276"></a>[T276:49](../../e2e/search.spec.ts#L49) | the search scope picker shows the list's scope, with the chat's groups but no tags | 検索scopeに一覧scopeとグループを出し、タグを出さない | 維持 / 成功 |

## e2e/settings.spec.ts（2件）

本番の接続先: [src/settings/SettingsView.tsx](../../src/settings/SettingsView.tsx)、[src/settings/ModelSettings.tsx](../../src/settings/ModelSettings.tsx)、[src/api.ts](../../src/api.ts)。

境界: 実React UI → mockIPC。各sectionは本物だが値と保存はmock。native設定効果は見ない。

重複判断: 英語smokeとlocaleが違う。カテゴリ列挙の漏れF08、狭幅layoutは独立。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T277"></a>[T277:23](../../e2e/settings.spec.ts#L23) | every settings section renders, and Esc goes back to the library | 固定17設定カテゴリの見出し・保存先・段数とEsc復帰を守る | 補強 / [P3 F08](findings.md#F08) |
| <a id="T278"></a>[T278:42](../../e2e/settings.spec.ts#L42) | in a narrow window the provider chain wraps instead of squeezing its selects to nothing | 狭幅でもプロバイダselectの最小幅を保つ | 維持 / 成功 |

## e2e/shell.spec.ts（13件）

本番の接続先: [src/app/TitleBar.tsx](../../src/app/TitleBar.tsx)、[src/layout/TabStrip.tsx](../../src/layout/TabStrip.tsx)、[src/browser/BrowserView.tsx](../../src/browser/BrowserView.tsx)、[src/reader/Reader.tsx](../../src/reader/Reader.tsx)、[src/theme.css](../../src/theme.css)、[src/api.ts](../../src/api.ts)。

境界: 実React UI → mockIPC。ChromiumのDOM/座標とIPC要求。実native titlebar/clipboard/webview描画は通らない。

重複判断: Reader/Page、main/document/chatは別hostのため両方必要。font F01/copy F03のみ検証不足。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T279"></a>[T279:19](../../e2e/shell.spec.ts#L19) | the ⋯ menu draws its text in the frame it first appears (H8) | 初回メニューframeで旧フォント名のcheckがtrueかを見る | 補強 / [P1 F01](findings.md#F01) |
| <a id="T280"></a>[T280:42](../../e2e/shell.spec.ts#L42) | on Page, a still captured when the pointer reaches ⋯ lets the menu hide the webview without a new capture (H8) | Page静止画の先行取得をメニュー表示時に再利用する | 維持 / 成功 |
| <a id="T281"></a>[T281:56](../../e2e/shell.spec.ts#L56) | the search and command box sits in the title bar, not in the nav (H9) | 検索/コマンドboxをtitlebarに一つだけ配置する | 維持 / 成功 |
| <a id="T282"></a>[T282:72](../../e2e/shell.spec.ts#L72) | the chat window has no command center (H9) | chat専用窓にはコマンドセンターを出さない | 維持 / 成功 |
| <a id="T283"></a>[T283:78](../../e2e/shell.spec.ts#L78) | the nav's top holds only its close button; what the ＋ opened is in the palette (H10) | nav上部のcloseボタンとパレットへの操作集約を守る | 維持 / 成功 |
| <a id="T284"></a>[T284:88](../../e2e/shell.spec.ts#L88) | the closed list is one button that opens it again; j / k still move the cursor (H11) | 閉じた一覧の再展開ボタンとj/k移動を守る | 維持 / 成功 |
| <a id="T285"></a>[T285:100](../../e2e/shell.spec.ts#L100) | the tab strip's ＋ opens the search engine's start page in a new tab (H12) | タブ＋で検索エンジンの開始ページを新規タブへ開く | 維持 / 成功 |
| <a id="T286"></a>[T286:108](../../e2e/shell.spec.ts#L108) | a saved article's summary shows in a strip above its page; it can be generated there (H13) | 保存記事のPage上に要約stripを出し、生成操作を送る | 維持 / 成功 |
| <a id="T287"></a>[T287:128](../../e2e/shell.spec.ts#L128) | an unsaved page has no summary (H13) | 未保存Pageには要約stripを出さない | 維持 / 成功 |
| <a id="T288"></a>[T288:145](../../e2e/shell.spec.ts#L145) | the Reader and the Page toolbars carry the same article actions in the same order (H14) | Reader/Pageの共通action順と差分、quiz隣接配置を守る | 維持 / 成功 |
| <a id="T289"></a>[T289:166](../../e2e/shell.spec.ts#L166) | an unsaved page's ⋯ copies its URL (H14) | 未保存Pageメニューの項目がURLコピーだけであることを見る | 補強 / [P2 F03](findings.md#F03) |
| <a id="T290"></a>[T290:172](../../e2e/shell.spec.ts#L172) | a document window's tab strips are its title bar: they drag it, and the top-right one holds the window controls (H19) | document窓上段stripのdrag領域と右上window controlsを守る | 維持 / 成功 |
| <a id="T291"></a>[T291:211](../../e2e/shell.spec.ts#L211) | the main window keeps its title bar and its strips do not drag the window (H19) | mainは独立titlebarを持ち、stripを窓drag領域にしない | 維持 / 成功 |

## e2e/shortcuts.spec.ts（2件）

本番の接続先: [src/settings/ShortcutSettings.tsx](../../src/settings/ShortcutSettings.tsx)、[src/app/useKeyboard.ts](../../src/app/useKeyboard.ts)、[src/api.ts](../../src/api.ts)。

境界: 実React UI → mockIPC。実記録入力・localStorage reload・action。native Page key転送は別。

重複判断: keys unitのmap/競合にUI永続化を加える。2件のpositive/cancelは別。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T292"></a>[T292:12](../../e2e/shortcuts.spec.ts#L12) | a recorded key runs the action, survives a reload, and can be removed | 記録shortcutの実行・reload後保持・削除を守る | 維持 / 成功 |
| <a id="T293"></a>[T293:36](../../e2e/shortcuts.spec.ts#L36) | a key bound to two actions is flagged, and Esc cancels recording | shortcut衝突の警告とEsc記録取消を守る | 維持 / 成功 |

## e2e/tabdrag.spec.ts（12件）

本番の接続先: [src/layout/tabDrag.ts](../../src/layout/tabDrag.ts)、[src/layout/TabStrip.tsx](../../src/layout/TabStrip.tsx)、[src/layout/DocArea.tsx](../../src/layout/DocArea.tsx)、[src/app/useWindows.ts](../../src/app/useWindows.ts)、[src/api.ts](../../src/api.ts)。

境界: 実React UI → mockIPC。backend drag結果をevent注入。native cursor polling/実他窓配送は通らない。

重複判断: Rust状態機械・Node tree変更と三層で補完。main/documentを両方残す。T305のみF14。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T294"></a>[T294:34](../../e2e/tabdrag.spec.ts#L34) | a drag starts in the backend with the tab, its slot and this window's strips, and ends when the backend says so | tab drag開始のbackend引数と終了eventによるUI終了を守る | 維持 / 成功 |
| <a id="T295"></a>[T295:55](../../e2e/tabdrag.spec.ts#L55) | a window draws the slot it is told: a marker for its own tab, the tab itself for another window's | 自窓/他窓由来のtab dragでmarkerと仮タブを描き分ける | 維持 / 成功 |
| <a id="T296"></a>[T296:74](../../e2e/tabdrag.spec.ts#L74) | every window reports its strips while any window drags, and again when its tabs change | drag中に各窓のstripを報告し、タブ変更時にも更新する | 維持 / 成功 |
| <a id="T297"></a>[T297:90](../../e2e/tabdrag.spec.ts#L90) | torn off, the tab leaves for a new document window that the backend creates and places | tear-off指示で元タブを除き、backendへ別窓作成を委ねる | 維持 / 成功 |
| <a id="T298"></a>[T298:105](../../e2e/tabdrag.spec.ts#L105) | the window holding the tab when the drag ends moves it in its own strips or sends it to the slot in another window | drop通知を受けて自窓内移動または他窓への送信を行う | 維持 / 成功 |
| <a id="T299"></a>[T299:120](../../e2e/tabdrag.spec.ts#L120) | split into panes, a tab dropped on the other pane's strip moves there, and an empty strip marks the slot | 分割pane間のstrip dropと空stripのmarkerを守る | 維持 / 成功 |
| <a id="T300"></a>[T300:153](../../e2e/tabdrag.spec.ts#L153) | split into panes, the window reports each pane's body under its strip, and draws the zone a drag is over | 各pane本文領域を報告し、drag中のdrop zoneを表示する | 維持 / 成功 |
| <a id="T301"></a>[T301:184](../../e2e/tabdrag.spec.ts#L184) | dropped on another pane's center the tab joins that pane; on an edge it splits that pane and takes the new one | 中央dropで既存paneへ、端dropで新paneへtabを移す | 維持 / 成功 |
| <a id="T302"></a>[T302:209](../../e2e/tabdrag.spec.ts#L209) | a pop-out split into panes moves a tab between them the same way | document別窓でも分割pane間のtab移動を行う | 維持 / 成功 |
| <a id="T303"></a>[T303:249](../../e2e/tabdrag.spec.ts#L249) | a window opens what is dropped on it at that slot | 他窓からのopen要求で指定slotへtabを入れる | 維持 / 成功 |
| <a id="T304"></a>[T304:256](../../e2e/tabdrag.spec.ts#L256) | a document window dragged by its only tab follows the cursor itself; a torn-off window drops its only tab | 単一tab窓のdrag・tear-off後返却・空窓closeを連携する | 維持 / 成功 |
| <a id="T305"></a>[T305:287](../../e2e/tabdrag.spec.ts#L287) | the main window is shown by its configuration: it does not report ready | main起動時にwindow_readyを呼ばない | 統合候補 / [P3 F14](findings.md#F14) |

## e2e/tabs.spec.ts（6件）

本番の接続先: [src/layout/DocArea.tsx](../../src/layout/DocArea.tsx)、[src/layout/TabStrip.tsx](../../src/layout/TabStrip.tsx)、[src/app/useDocuments.ts](../../src/app/useDocuments.ts)、[src/api.ts](../../src/api.ts)。

境界: 実React UI → mockIPC。実tab/layout/localStorage。PageはmockIPC。

重複判断: layout unitは状態操作、e2eは入力配線。T310の題名event不足F11。それ以外維持。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T306"></a>[T306:10](../../e2e/tabs.spec.ts#L10) | Ctrl-click opens a second tab; Ctrl+Tab cycles; Ctrl+W closes back to one | Ctrl-click新規tab・Ctrl+Tab循環・Ctrl+W closeを守る | 維持 / 成功 |
| <a id="T307"></a>[T307:29](../../e2e/tabs.spec.ts#L29) | a tab reorders by drag; middle-click closes it | tabドラッグ並べ替えとmiddle-click closeを守る | 維持 / 成功 |
| <a id="T308"></a>[T308:46](../../e2e/tabs.spec.ts#L46) | split right makes a focused empty pane; the next click opens there; closing it merges back | 右分割した空paneへ次の記事を開き、closeで統合する | 維持 / 成功 |
| <a id="T309"></a>[T309:79](../../e2e/tabs.spec.ts#L79) | the layout with its tabs survives a reload | tab付きlayoutをlocalStorage経由でreload後も復元する | 維持 / 成功 |
| <a id="T310"></a>[T310:91](../../e2e/tabs.spec.ts#L91) | a Page tab gets its own webview, titled by its host until the page names itself | Pageのhost仮題とbrowser_open/hide/closeの要求を守る | 範囲・名称修正 / [P3 F11](findings.md#F11) |
| <a id="T311"></a>[T311:117](../../e2e/tabs.spec.ts#L117) | a chat citation and a palette article open in a new tab on Ctrl / middle click | 対話引用・パレット記事のCtrl/middle-clickで新規tabを開く | 維持 / 成功 |

## e2e/tags.spec.ts（3件）

本番の接続先: [src/library/FacetPopover.tsx](../../src/library/FacetPopover.tsx)、[src/app/useLibraryView.ts](../../src/app/useLibraryView.ts)、[src/api.ts](../../src/api.ts)。

境界: 実React UI → mockIPC。fixtureタグへの実DOM選択・focus。backend tag保存は対象外。

重複判断: library facetsと異なるpopover keyboard/復帰focus。3件を保持。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T312"></a>[T312:10](../../e2e/tags.spec.ts#L10) | tag popover: search, AND / any, Backspace drops the last tag | タグ検索・AND/any切替・Backspace解除を守る | 維持 / 成功 |
| <a id="T313"></a>[T313:41](../../e2e/tags.spec.ts#L41) | tag popover keyboard: arrows move, Space toggles, Ctrl+Enter applies | タグpopoverの矢印・Space・Ctrl+Enter操作を守る | 維持 / 成功 |
| <a id="T314"></a>[T314:59](../../e2e/tags.spec.ts#L59) | closing a facet popover returns focus to its chip, also after the first pick replaced the chip | facet選択でchipが置換されてもclose時にfocusを戻す | 維持 / 成功 |

## e2e/vocab.spec.ts（6件）

本番の接続先: [src/vocab/VocabView.tsx](../../src/vocab/VocabView.tsx)、[src/vocab/VocabCard.tsx](../../src/vocab/VocabCard.tsx)、[src/reader/Reader.tsx](../../src/reader/Reader.tsx)、[src/app/useVocab.ts](../../src/app/useVocab.ts)、[src/vocab/speech.ts](../../src/vocab/speech.ts)、[src/api.ts](../../src/api.ts)。

境界: 実React UI → mockIPC。vocab_addは即ready、speechSynthesisはstub。job待機/実音声/OSvoiceは含まない。

重複判断: core vocabはDB/card、Node vocabは文字選択。UI各操作/音声設定branchは固有。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T315"></a>[T315:38](../../e2e/vocab.spec.ts#L38) | 単語を登録: select a word in the Reader, save it with its sentence, and see it marked | Reader選択語と文脈を登録し、保存語markを表示する | 維持 / 成功 |
| <a id="T316"></a>[T316:75](../../e2e/vocab.spec.ts#L75) | 単語帳: search, edit a meaning, suspend, export and delete | 単語帳検索・語義編集・停止・export・削除をUIで操作する | 維持 / 成功 |
| <a id="T317"></a>[T317:173](../../e2e/vocab.spec.ts#L173) | 今日の復習: a saved word is a word → meaning card, said aloud | 単語復習の表裏・採点とモック音声への読み上げ要求を守る | 維持 / 成功 |
| <a id="T318"></a>[T318:209](../../e2e/vocab.spec.ts#L209) | without an offline English voice the card is silent and has no audio buttons | offline英語音声なしでは自動読み上げと音声ボタンを出さない | 維持 / 成功 |
| <a id="T319"></a>[T319:224](../../e2e/vocab.spec.ts#L224) | auto-play can be turned off in Settings › 復習; the buttons still speak | 自動再生offでも明示ボタンによる読み上げを許す | 維持 / 成功 |
| <a id="T320"></a>[T320:239](../../e2e/vocab.spec.ts#L239) | a word's card opens the passage it came from | 単語カードの出典を元の記事箇所へ開く | 維持 / 成功 |

## scripts/licenses.test.mjs（2件）

本番の接続先: [scripts/licenses.mjs](../../scripts/licenses.mjs)。

境界: 実node_modulesのlicense収集結果とfixture重複化。配布binary自体は起動しない。

重複判断: license存在と同文統合は異なる契約。短いassertionでも実依存を走査するため維持。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T321"></a>[T321:6](../../scripts/licenses.test.mjs#L6) | every bundled npm package has a license text, and dev tools are left out | 同梱npm依存にlicense本文を揃え、開発用依存を除く | 維持 / 成功 |
| <a id="T322"></a>[T322:14](../../scripts/licenses.test.mjs#L14) | packages with the same text share one copy of it | 同じlicense本文を一つにまとめる | 維持 / 成功 |

## scripts/version.test.mjs（4件）

本番の接続先: [scripts/version.mjs](../../scripts/version.mjs)、[src-tauri/tauri.conf.json](../../src-tauri/tauri.conf.json)、[Cargo.toml](../../Cargo.toml)。

境界: 実repo版数の照合と一時コピー更新。不正入力も確認。

重複判断: Tauri updateの有効化とは別。version一致/参照元/更新/失敗の4契約を保持。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T323"></a>[T323:20](../../scripts/version.test.mjs#L20) | every version file in the repository agrees | repoのversion定義が一致することを守る | 維持 / 成功 |
| <a id="T324"></a>[T324:24](../../scripts/version.test.mjs#L24) | tauri.conf.json takes its version from Cargo.toml | Tauri設定がCargoのversionを参照することを守る | 維持 / 成功 |
| <a id="T325"></a>[T325:28](../../scripts/version.test.mjs#L28) | setVersion rewrites every source and leaves dependencies alone | version更新を対象定義へ反映し、依存指定を維持する | 維持 / 成功 |
| <a id="T326"></a>[T326:40](../../scripts/version.test.mjs#L40) | drift and bad input are reported | versionの不一致と不正入力を報告する | 維持 / 成功 |

## src-tauri/src/badge.rs（2件）

本番の接続先: [src-tauri/src/badge.rs](../../src-tauri/src/badge.rs)、[src-tauri/src/lib.rs](../../src-tauri/src/lib.rs)。

境界: 実label/pixel生成。Windows taskbarへの表示API自体は未実行。

重複判断: UI失敗件数badgeとは別物。Windows taskbar用の表記・pixelを守る。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T327"></a>[T327:141](../../src-tauri/src/badge.rs#L141) | labels_cap_at_99_plus | badge件数表記を99+で打ち止めにする | 維持 / 成功 |
| <a id="T328"></a>[T328:146](../../src-tauri/src/badge.rs#L146) | draws_white_digits_on_an_accent_disc | badge画像のaccent円と白い数字のpixelを検証する | 維持 / 成功 |

## src-tauri/src/browser.rs（6件）

本番の接続先: [src-tauri/src/browser.rs](../../src-tauri/src/browser.rs)、[src-tauri/src/lib.rs](../../src-tauri/src/lib.rs)。

境界: 実検証・payload・退避候補選択。WebView2の作成・focus・snapshot取得自体は未実行。

重複判断: Node overlayのkey/DOM、e2e Pageの呼出し列と補完。native hostのlabel/nonce/capture境界を残す。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T329"></a>[T329:737](../../src-tauri/src/browser.rs#L737) | labels_name_their_tab_and_nothing_else_passes | browserラベルをtab識別子として厳密に検証する | 維持 / 成功 |
| <a id="T330"></a>[T330:750](../../src-tauri/src/browser.rs#L750) | snapshot_nonces_are_per_label_and_single_use | snapshot nonceをラベル別・一回限りにする | 維持 / 成功 |
| <a id="T331"></a>[T331:764](../../src-tauri/src/browser.rs#L764) | page_keys_keep_the_overlay_shape | Page用key設定のシリアライズ形状をoverlayに合わせる | 維持 / 成功 |
| <a id="T332"></a>[T332:775](../../src-tauri/src/browser.rs#L775) | tab_events_carry_the_tab_beside_the_body | browser event payloadへtab識別子を付ける | 維持 / 成功 |
| <a id="T333"></a>[T333:786](../../src-tauri/src/browser.rs#L786) | a_page_captures_words_only_on_screen_and_not_in_bursts | 画面上での単語captureと連続要求制限を守る | 維持 / 成功 |
| <a id="T334"></a>[T334:799](../../src-tauri/src/browser.rs#L799) | eviction_takes_the_longest_hidden_webviews_beyond_the_cap_and_never_a_shown_one | 非表示webviewのうち長く隠れたものから上限超過分を退避する | 維持 / 成功 |

## src-tauri/src/location.rs（3件）

本番の接続先: [src-tauri/src/location.rs](../../src-tauri/src/location.rs)、[src-tauri/src/lib.rs](../../src-tauri/src/lib.rs)。

境界: 識別子/移動先検証と一時フォルダcopy。OS移動UI・再起動は対象外。

重複判断: coreは保存先決定、ここはTauri識別子とcopy。別の失敗条件。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T335"></a>[T335:63](../../src-tauri/src/location.rs#L63) | the_cli_finds_the_folder_this_identifier_names | CLIとTauriのアプリ識別子由来保存先を合わせる | 維持 / 成功 |
| <a id="T336"></a>[T336:69](../../src-tauri/src/location.rs#L69) | targets_inside_the_current_folder_are_refused | 現保存フォルダ自身/内部への移動先指定を拒否する | 維持 / 成功 |
| <a id="T337"></a>[T337:78](../../src-tauri/src/location.rs#L78) | copy_data_copies_the_database_and_folders_and_keeps_the_source | DB・関連フォルダをコピーし、元データを残す | 維持 / 成功 |

## src-tauri/src/popout.rs（2件）

本番の接続先: [src-tauri/src/popout.rs](../../src-tauri/src/popout.rs)、[src-tauri/src/lib.rs](../../src-tauri/src/lib.rs)。

境界: ラベルとmonitor位置判定。native窓作成/placementの実機確認はない。

重複判断: src/app/windowsはUI側label/storage、e2eは窓要求。monitor消失はここ固有。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T338"></a>[T338:209](../../src-tauri/src/popout.rs#L209) | only_document_and_chat_labels_are_pop_outs | document/chatだけをpop-outラベルとして扱う | 維持 / 成功 |
| <a id="T339"></a>[T339:217](../../src-tauri/src/popout.rs#L217) | a_saved_position_is_kept_only_while_its_monitor_is_there | 保存window位置のmonitorが消えたら位置を破棄する | 維持 / 成功 |

## src-tauri/src/tabdrag.rs（12件）

本番の接続先: [src-tauri/src/tabdrag.rs](../../src-tauri/src/tabdrag.rs)、[src-tauri/src/lib.rs](../../src-tauri/src/lib.rs)。

境界: 実geometry/state machine/payloadの純粋試験。OS cursor polling・実窓z-order・mixed DPIを実機で動かさない。

重複判断: src/layoutはtree mutation、e2e/tabdragはUI/event接続。ここは座標と状態機械なので12件を維持。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T340"></a>[T340:644](../../src-tauri/src/tabdrag.rs#L644) | the_slot_is_the_number_of_tab_centers_left_of_the_pointer | pointer左側のtab中心数から挿入slotを決める | 維持 / 成功 |
| <a id="T341"></a>[T341:652](../../src-tauri/src/tabdrag.rs#L652) | a_strip_is_found_in_its_own_windows_scale_and_the_source_is_on_top | windowのscaleとsource優先順で対象stripを探す | 維持 / 成功 |
| <a id="T342"></a>[T342:669](../../src-tauri/src/tabdrag.rs#L669) | a_tab_stays_in_its_strip_until_it_is_pulled_detach_px_above_or_below_it | detach閾値を超えるまで元strip内dragとして扱う | 維持 / 成功 |
| <a id="T343"></a>[T343:681](../../src-tauri/src/tabdrag.rs#L681) | a_tab_torn_off_follows_the_cursor_in_its_window_hides_over_a_strip_and_comes_back | tear-off窓追従・strip上で非表示・離脱時再表示の状態遷移を守る | 維持 / 成功 |
| <a id="T344"></a>[T344:709](../../src-tauri/src/tabdrag.rs#L709) | a_body_is_its_center_and_an_edge_quarter_on_each_side | 本文drop位置を中央と端四分の一へ分ける | 維持 / 成功 |
| <a id="T345"></a>[T345:724](../../src-tauri/src/tabdrag.rs#L724) | in_a_window_split_into_panes_the_tab_moves_between_them_and_comes_out_only_outside_it | 分割窓内ではpane間移動し、窓外で初めてtear-offする | 維持 / 成功 |
| <a id="T346"></a>[T346:749](../../src-tauri/src/tabdrag.rs#L749) | released_over_another_panes_strip_in_its_own_window_the_tab_moves_there | 同窓の別pane strip上で離すとそのpaneへ移す | 維持 / 成功 |
| <a id="T347"></a>[T347:757](../../src-tauri/src/tabdrag.rs#L757) | released_over_a_strip_the_window_holding_the_tab_sends_it_there | strip上dropをtab保持windowに処理させる | 維持 / 成功 |
| <a id="T348"></a>[T348:774](../../src-tauri/src/tabdrag.rs#L774) | escape_puts_the_tab_back_where_it_started | Escapeでdrag開始前の位置へ戻す | 維持 / 成功 |
| <a id="T349"></a>[T349:785](../../src-tauri/src/tabdrag.rs#L785) | a_release_before_the_torn_off_window_loads_waits_for_it | tear-off窓load前のreleaseは窓準備を待つ | 維持 / 成功 |
| <a id="T350"></a>[T350:801](../../src-tauri/src/tabdrag.rs#L801) | a_window_dragged_by_its_only_tab_follows_the_cursor_and_escape_puts_it_back | 単一tab窓そのものを追従させ、Escapeで元位置へ戻す | 維持 / 成功 |
| <a id="T351"></a>[T351:821](../../src-tauri/src/tabdrag.rs#L821) | the_ui_reports_plain_numbers | drag座標等を通常の数値としてUI payloadへ出す | 維持 / 成功 |

## src-tauri/src/update.rs（1件）

本番の接続先: [src-tauri/src/update.rs](../../src-tauri/src/update.rs)、[src-tauri/src/lib.rs](../../src-tauri/src/lib.rs)。

境界: 実public keyの有効化判定。更新配信・署名検証・インストールの実行は含まない。

重複判断: version scriptの定義整合性とは別の有効化条件。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T352"></a>[T352:94](../../src-tauri/src/update.rs#L94) | only_a_real_key_turns_the_updater_on | 未設定・空白・placeholderの更新鍵ではupdaterを有効化しない | 維持 / 成功 |

## src/app/history.test.ts（5件）

本番の接続先: [src/app/history.ts](../../src/app/history.ts)。

境界: 実履歴helperへの状態入力。React hookの接続はe2e。

重複判断: e2e/historyと補完。stack端・上限・到着更新・Page区別は異なるbranch。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T353"></a>[T353:8](../../src/app/history.test.ts#L8) | visits stack up; the same place twice is one entry | 同じ場所への連続visitを履歴へ重複追加しない | 維持 / 成功 |
| <a id="T354"></a>[T354:19](../../src/app/history.test.ts#L19) | back and forward move the cursor and stop at the ends; a new visit drops what was ahead | 戻る/進むの端停止と途中からの新visitで先の履歴を捨てる | 維持 / 成功 |
| <a id="T355"></a>[T355:36](../../src/app/history.test.ts#L36) | the stack is bounded: the oldest entries go | 履歴数上限で古いentryを落とす | 維持 / 成功 |
| <a id="T356"></a>[T356:46](../../src/app/history.test.ts#L46) | where a step arrived replaces its entry instead of cutting the forward ones | 遷移到着先で現entryを更新し、進む履歴を切らない | 維持 / 成功 |
| <a id="T357"></a>[T357:58](../../src/app/history.test.ts#L58) | a page's document is its explicit navigation, not where the page moved on its own | Page内部遷移と明示document navigationを区別する | 維持 / 成功 |

## src/app/windows.test.ts（3件）

本番の接続先: [src/app/windows.ts](../../src/app/windows.ts)。

境界: 実label/storage key/言語判定helper。native窓は作らない。

重複判断: Rust popoutとUI起動試験はruntime/呼出し側が違う。維持。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T358"></a>[T358:5](../../src/app/windows.test.ts#L5) | a window's label says what it shows; anything unexpected is the main shell | window labelから用途を解釈し、未知labelはmain扱いにする | 維持 / 成功 |
| <a id="T359"></a>[T359:13](../../src/app/windows.test.ts#L13) | open pop-outs are the window keys in storage; the next document window takes the lowest free number | storageのpop-outキー一覧と最小空きdocument番号を求める | 維持 / 成功 |
| <a id="T360"></a>[T360:20](../../src/app/windows.test.ts#L20) | only the main window sends the shared overlay config; a document window takes main's Page language | mainだけのoverlay設定送信と別窓Page言語継承を判定する | 維持 / 成功 |

## src/browser/engines.test.ts（3件）

本番の接続先: [src/browser/engines.ts](../../src/browser/engines.ts)。

境界: 実URL/検索engine変換。navigator・ネットワークは使わない。

重複判断: Rust url_normは重複用正規化なので別。危険schemeとcustom engine境界を維持。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T361"></a>[T361:7](../../src/browser/engines.test.ts#L7) | toNavigation: URLs as typed, hosts get https://, everything else is searched | 入力をURL・host補完・検索文字列へ分ける | 維持 / 成功 |
| <a id="T362"></a>[T362:21](../../src/browser/engines.test.ts#L21) | toNavigation never leaves http(s) | navigation先をhttp(s)に限定する | 維持 / 成功 |
| <a id="T363"></a>[T363:28](../../src/browser/engines.test.ts#L28) | engines: built-in and custom search and home pages | 組み込み/独自engineの検索URLとhomeを生成する | 維持 / 成功 |

## src/chat/chat.test.ts（2件）

本番の接続先: [src/chat/chat.ts](../../src/chat/chat.ts)。

境界: 実引用chip解析とopen article集合。LLM/Storeは使わない。

重複判断: core/chatの資料・引用検証と表示変換が異なる。e2eはDOM配線。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T364"></a>[T364:5](../../src/chat/chat.test.ts#L5) | only validated citation numbers become chips | 検証済み引用番号だけを対話chipに変換する | 維持 / 成功 |
| <a id="T365"></a>[T365:10](../../src/chat/chat.test.ts#L10) | the open articles: saved ones once each, in tab order; unsaved pages and unknown articles left out | 保存済みの開いた記事だけをtab順・重複なしで抽出する | 維持 / 成功 |

## src/chat/vim.test.ts（6件）

本番の接続先: [src/chat/vim.ts](../../src/chat/vim.ts)。

境界: 実Vim状態機械へkey入力。DOM入力そのものはe2e。

重複判断: e2e一連操作では覆えないmotion/edit/undo境界を保持。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T366"></a>[T366:21](../../src/chat/vim.test.ts#L21) | motions: h l stay on the line, j k keep the column, w b e by word class | Vimの行内・縦・単語移動の境界を守る | 維持 / 成功 |
| <a id="T367"></a>[T367:37](../../src/chat/vim.test.ts#L37) | motions: 0 $ gg G | Vimの行頭末尾・文書先頭末尾移動を守る | 維持 / 成功 |
| <a id="T368"></a>[T368:44](../../src/chat/vim.test.ts#L44) | entering insert: i a I A o O; Esc steps back one like Vim | Vim挿入開始位置・改行挿入・Esc時位置を守る | 維持 / 成功 |
| <a id="T369"></a>[T369:54](../../src/chat/vim.test.ts#L54) | edits: x dd dw cw yy p | Vim削除・変更・yank/pasteを守る | 維持 / 成功 |
| <a id="T370"></a>[T370:68](../../src/chat/vim.test.ts#L68) | u undoes one change at a time; an insert that typed nothing is not a change | Vimのundo単位と空挿入を履歴へ積まないことを守る | 維持 / 成功 |
| <a id="T371"></a>[T371:76](../../src/chat/vim.test.ts#L76) | normal mode swallows other printable keys; Esc, arrows and Tab are left to the page | normal時の文字key抑止とページへ委ねるkeyを分ける | 維持 / 成功 |

## src/feeds/feedFilter.test.ts（2件）

本番の接続先: [src/feeds/feedFilter.ts](../../src/feeds/feedFilter.ts)。

境界: 実理由整形/規則削除helper。規則評価はRust。

重複判断: 両言語で全理由を表示する契約、first-only削除は独立。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T372"></a>[T372:10](../../src/feeds/feedFilter.test.ts#L10) | every rejection reason reads as a sentence in both languages | feed拒否理由の各種を日英の文章へ整形する | 維持 / 成功 |
| <a id="T373"></a>[T373:23](../../src/feeds/feedFilter.test.ts#L23) | removing a rule takes out only the first equal one | 同一規則が複数ある場合は最初の一つだけ除去する | 維持 / 成功 |

## src/feeds/feedFolders.test.ts（8件）

本番の接続先: [src/feeds/feedFolders.ts](../../src/feeds/feedFolders.ts)。

境界: 実frontend tree/順序計算。mockも一部を共有。

重複判断: e2eとの実装共有は独立oracleではない。ただし固定期待順があり、Rust store試験とも補完する。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T374"></a>[T374:8](../../src/feeds/feedFolders.test.ts#L8) | folders hold their feeds with summed counts; the rest stay loose | フォルダ別feedと未読合計、未所属feedを組み立てる | 維持 / 成功 |
| <a id="T375"></a>[T375:39](../../src/feeds/feedFolders.test.ts#L39) | moving a folder swaps it with its neighbour, never past the ends | フォルダ順を隣と交換し、端を越えない | 維持 / 成功 |
| <a id="T376"></a>[T376:45](../../src/feeds/feedFolders.test.ts#L45) | pasted feed URLs: one per line, blanks and repeats dropped | 複数行feed URLから空行・重複を除く | 維持 / 成功 |
| <a id="T377"></a>[T377:64](../../src/feeds/feedFolders.test.ts#L64) | feed groups: the folders' feeds in order, then the feeds in none | フォルダ順内feedを先に、未所属を後ろに並べる | 維持 / 成功 |
| <a id="T378"></a>[T378:72](../../src/feeds/feedFolders.test.ts#L72) | Alt+arrows step a feed one place, across into the neighbouring folder at either end | Alt移動で隣folder境界を越えてfeedを一つ動かす | 維持 / 成功 |
| <a id="T379"></a>[T379:82](../../src/feeds/feedFolders.test.ts#L82) | dropping a feed: onto a feed it takes that slot, onto a folder it goes last there | feed上dropはそのslot、folder上dropは末尾へ配置する | 維持 / 成功 |
| <a id="T380"></a>[T380:99](../../src/feeds/feedFolders.test.ts#L99) | dropping a folder reorders the folders; its feeds follow it | folder dropでfolderと所属feedをまとめて並べ替える | 維持 / 成功 |
| <a id="T381"></a>[T381:106](../../src/feeds/feedFolders.test.ts#L106) | placing feeds shows a move before the backend answers | backend応答前のfeed移動を楽観的な一覧へ反映する | 維持 / 成功 |

## src/i18n/backend.test.ts（3件）

本番の接続先: [src/i18n/index.ts](../../src/i18n/index.ts)、[src/i18n/ja.ts](../../src/i18n/ja.ts)、[crates/lattice-core/src/msg.rs](../../crates/lattice-core/src/msg.rs)。

境界: Rustソース走査+実translator。Rustを起動した翻訳結合ではない。

重複判断: カタログ相互照合とは別のbackend message境界。使用中判定だけF04。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T382"></a>[T382:70](../../src/i18n/backend.test.ts#L70) | every backend message code has a catalog entry with the same params | Rustの文字列msg!呼び出しに日訳keyと同じparamがあるか調べる | 維持 / 成功 |
| <a id="T383"></a>[T383:80](../../src/i18n/backend.test.ts#L80) | every be.* catalog entry is a code the backend uses | be.* keyのcode文字列がRustソース内に存在するか調べる | 補強 / [P2 F04](findings.md#F04) |
| <a id="T384"></a>[T384:88](../../src/i18n/backend.test.ts#L88) | t.msg translates coded messages, nested codes in params too, and passes plain text through | coded errorと入れ子codeを訳し、未知/旧/plain errorを保持する | 維持 / 成功 |

## src/i18n/i18n.test.ts（4件）

本番の接続先: [src/i18n/index.ts](../../src/i18n/index.ts)、[src/i18n/ja.ts](../../src/i18n/ja.ts)、[src/i18n/en.ts](../../src/i18n/en.ts)。

境界: 実カタログとtranslator。画面に適用されるかはe2e。

重複判断: key/params・空白・残存日本語・整形は別故障。英語e2eでは全keyを覆わない。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T385"></a>[T385:10](../../src/i18n/i18n.test.ts#L10) | en has every key of ja, with the same params | 日英カタログのkeyとparam集合を一致させる | 維持 / 成功 |
| <a id="T386"></a>[T386:26](../../src/i18n/i18n.test.ts#L26) | en keeps ja's leading and trailing spaces (text placed next to markup; English may add its own) | markup隣接文字列の先頭末尾spaceを翻訳で失わない | 維持 / 成功 |
| <a id="T387"></a>[T387:34](../../src/i18n/i18n.test.ts#L34) | English text has no Japanese in it | 英語カタログに日本語文字が残っていないか調べる | 維持 / 成功 |
| <a id="T388"></a>[T388:43](../../src/i18n/i18n.test.ts#L43) | t fills params, formats numbers per language and pluralizes English | param埋込・locale数値整形・英語複数形を守る | 維持 / 成功 |

## src/i18n/literals.test.ts（1件）

本番の接続先: [src/i18n/ja.ts](../../src/i18n/ja.ts)、[src/i18n/en.ts](../../src/i18n/en.ts)。

境界: UIソースの文字列走査による方針チェック。自然言語の翻訳品質は判定しない。

重複判断: key整合や英語DOM試験と異なる、カタログ外の増加を阻止する静的gate。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T389"></a>[T389:8](../../src/i18n/literals.test.ts#L8) | UI code has no Japanese text outside the catalogs (src/i18n) | UIの日本語literalをカタログ外へ増やさない | 維持 / 成功 |

## src/layout/chrome.test.ts（3件）

本番の接続先: [src/layout/chrome.ts](../../src/layout/chrome.ts)。

境界: 実layout treeの最上段strip選択。OStitlebarは対象外。

重複判断: shellはDOMのdrag属性/controls、ここはtree形状の組合せ。維持。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T390"></a>[T390:19](../../src/layout/chrome.test.ts#L19) | topStrips: a single pane is the whole title bar | 単一paneのstripをtitlebar全幅として扱う | 維持 / 成功 |
| <a id="T391"></a>[T391:23](../../src/layout/chrome.test.ts#L23) | topStrips: side by side, every pane's strip is on top and the rightmost holds the controls | 横分割paneの上段strip群と右端controls位置を求める | 維持 / 成功 |
| <a id="T392"></a>[T392:27](../../src/layout/chrome.test.ts#L27) | topStrips: stacked, only the upper pane reaches the top; nested splits follow the same rule | 縦/入れ子分割で最上段に接するstripだけを選ぶ | 維持 / 成功 |

## src/layout/layout.test.ts（13件）

本番の接続先: [src/layout/layout.ts](../../src/layout/layout.ts)。

境界: 実layout状態操作/serialization。React/event/native windowは使わない。

重複判断: e2e tabdrag/tabsとRust geometryは異なる層。重なるopen/closeも空pane・key・tree不変条件が固有。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T393"></a>[T393:36](../../src/layout/layout.test.ts#L36) | open: fills the empty pane, then replaces the active tab; a new tab goes right after it | 空paneを埋め、通常openは置換、新tabはactiveの右へ置く | 維持 / 成功 |
| <a id="T394"></a>[T394:54](../../src/layout/layout.test.ts#L54) | open: a page in its own tab keeps the webview (same id) and bumps seq; the same URL is a no-op | Page同一tab更新でwebview IDを維持し、同一URLは無変更にする | 維持 / 成功 |
| <a id="T395"></a>[T395:67](../../src/layout/layout.test.ts#L67) | close: the neighbour becomes active; the last tab removes the pane, except the root | tab close後の隣active化と最後のpaneの扱いを守る | 維持 / 成功 |
| <a id="T396"></a>[T396:79](../../src/layout/layout.test.ts#L79) | split and merge: the new pane is empty and focused; same-direction splits become siblings | split/mergeのfocusと同方向splitのtree平坦化を守る | 維持 / 成功 |
| <a id="T397"></a>[T397:107](../../src/layout/layout.test.ts#L107) | close of the last tab in a split pane merges the pane away and refocuses | 分割pane最後のtab closeでpaneを統合しfocusを移す | 維持 / 成功 |
| <a id="T398"></a>[T398:117](../../src/layout/layout.test.ts#L117) | move: within a pane reorders around the gap; across panes shows it there and drops an emptied pane | 同pane並べ替え・別pane移動・空pane削除を守る | 維持 / 成功 |
| <a id="T399"></a>[T399:134](../../src/layout/layout.test.ts#L134) | dropOn: a body's center takes the tab at the end, an edge splits that pane on its side and puts the tab there | 中央dropで末尾追加、端dropで指定側splitを行う | 維持 / 成功 |
| <a id="T400"></a>[T400:161](../../src/layout/layout.test.ts#L161) | cycle wraps; focus ignores unknown panes | tab循環と未知pane focusの無視を守る | 維持 / 成功 |
| <a id="T401"></a>[T401:171](../../src/layout/layout.test.ts#L171) | resize sets a child's fraction, its neighbour takes the rest, and both stop at MIN_SIZE | resize時に隣と比率を分け合い、両者の最小幅を守る | 維持 / 成功 |
| <a id="T402"></a>[T402:185](../../src/layout/layout.test.ts#L185) | navigated keeps the title on the same URL and clears it on another; a Reader tab ignores page events | 同一URLの題名保持・別URLの題名resetとReaderへのevent無視を守る | 維持 / 成功 |
| <a id="T403"></a>[T403:196](../../src/layout/layout.test.ts#L196) | closeWhere drops every tab of a deleted article | 記事削除でその記事の全tabを閉じる | 維持 / 成功 |
| <a id="T404"></a>[T404:204](../../src/layout/layout.test.ts#L204) | serialize round-trips the tree, drops runtime page state, and rejects other shapes | layout保存/復元で実行時状態を捨て、不正shapeを拒否する | 維持 / 成功 |
| <a id="T405"></a>[T405:232](../../src/layout/layout.test.ts#L232) | a page keeps its webview key when replaced in place, and docOf carries it to another pane or window | 置換・pane/窓間移動でもPageのwebview keyを維持する | 維持 / 成功 |

## src/layout/panes.test.ts（3件）

本番の接続先: [src/layout/panes.ts](../../src/layout/panes.ts)。

境界: 実幾何近傍選択とnav index計算。DOM計測は入力fixture。

重複判断: layout状態更新やe2e keyboard配線と異なる幾何境界。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T406"></a>[T406:29](../../src/layout/panes.test.ts#L29) | paneAfter: neighbours by geometry stop at the edges, up / down reach stacked panes, o cycles | 幾何学的隣pane選択・端停止・循環を守る | 維持 / 成功 |
| <a id="T407"></a>[T407:44](../../src/layout/panes.test.ts#L44) | neighbor skips panes that only touch at a corner and panes behind the start | 角だけ接するpaneと進行方向外のpaneを除外する | 維持 / 成功 |
| <a id="T408"></a>[T408:55](../../src/layout/panes.test.ts#L55) | stepNav: skips disabled items and stops at both ends | nav移動でdisabledを飛ばし両端で止まる | 維持 / 成功 |

## src/lib/keys.test.ts（6件）

本番の接続先: [src/lib/keys.ts](../../src/lib/keys.ts)。

境界: 実key正規化/action map/override変換。OSkey配送は含まない。

重複判断: e2e shortcutは記録とUI、overlayは転送条件。各boundaryを残す。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T409"></a>[T409:15](../../src/lib/keys.test.ts#L15) | keyOf: canonical keys; Shift only where the key does not print it | keyを正規化し、印字文字に含まれるShiftを重ねない | 維持 / 成功 |
| <a id="T410"></a>[T410:27](../../src/lib/keys.test.ts#L27) | keyLabel: display form | shortcutの表示ラベルを整形する | 維持 / 成功 |
| <a id="T411"></a>[T411:31](../../src/lib/keys.test.ts#L31) | actionFor: defaults, several keys per action, overrides replace an action's keys | 既定/複数key/上書きからactionを解決する | 維持 / 成功 |
| <a id="T412"></a>[T412:42](../../src/lib/keys.test.ts#L42) | conflicts: a key bound to two actions, first in registry order wins | key衝突を検出し、registry順の先頭を採用する | 維持 / 成功 |
| <a id="T413"></a>[T413:49](../../src/lib/keys.test.ts#L49) | pageKeys: Ctrl keys of in-field actions go from page fields too; named keys stay the page's | 入力欄内でも送るCtrl keyとPageに残すnamed keyを分ける | 維持 / 成功 |
| <a id="T414"></a>[T414:61](../../src/lib/keys.test.ts#L61) | custom keys: setting an action's defaults back clears its override; reset restores one action or all | shortcutを既定へ戻すとoverrideを消し、個別/全体resetする | 維持 / 成功 |

## src/lib/runs.test.ts（1件）

本番の接続先: [src/lib/runs.ts](../../src/lib/runs.ts)。

境界: 実累積offset helper。DOMは使わない。

重複判断: 単文の試験だが文字列分割の開始位置という独立不変条件。削除根拠なし。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T415"></a>[T415:5](../../src/lib/runs.test.ts#L5) | withStarts: each run starts where the ones before it end | 連続runの開始offsetを累積長から求める | 維持 / 成功 |

## src/lib/time.test.ts（1件）

本番の接続先: [src/lib/time.ts](../../src/lib/time.ts)。

境界: 実相対時間整形に固定時刻を与える。timezone全網羅ではない。

重複判断: e2e固定clockとは別の単位/不正入力境界。低コストで維持。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T416"></a>[T416:8](../../src/lib/time.test.ts#L8) | relTime: past and future in the largest whole unit, null and garbage as — | 相対日時を最大の整数単位で表示し、不正値をダッシュにする | 維持 / 成功 |

## src/lib/urlLines.test.ts（1件）

本番の接続先: [src/lib/urlLines.ts](../../src/lib/urlLines.ts)。

境界: 実貼り付けURLの分類。通信はしない。

重複判断: feedFoldersの空行/重複除去と異なる理由分類。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T417"></a>[T417:6](../../src/lib/urlLines.test.ts#L6) | pasted lines without an http(s) URL are counted by why | http(s)でない貼り付け行を理由別に数える | 維持 / 成功 |

## src/library/articleMenu.test.ts（3件）

本番の接続先: [src/library/articleMenu.ts](../../src/library/articleMenu.ts)。

境界: 実menu modelの項目・一部callback引数。多くのactionはnoopでDOM/clipboardなし。

重複判断: contextmenu/shellが操作接続を補完。項目集合・bulk flip・import/popout除外は異なる入力。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T418"></a>[T418:15](../../src/library/articleMenu.test.ts#L15) | one article gets every action; picked ones only those that apply to all at once | 単一記事と複数選択で適用可能なaction集合を選ぶ | 維持 / 成功 |
| <a id="T419"></a>[T419:36](../../src/library/articleMenu.test.ts#L36) | favorite and read flip only when every article already has them | 全件が既に設定済みの場合だけfavorite/readを一括解除する | 維持 / 成功 |
| <a id="T420"></a>[T420:46](../../src/library/articleMenu.test.ts#L46) | an imported file has no page and no URL to copy; a pop-out has no new window to offer | importファイル/別窓では不適切なPage/copy/new-window actionを除く | 維持 / 成功 |

## src/library/groups.test.ts（3件）

本番の接続先: [src/library/groups.ts](../../src/library/groups.ts)。

境界: 実一覧グループ化。SQL所属変更とは無関係。

重複判断: core groupsはユーザーcollection、ここは見た目のgenre/feed群で責務が違う。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T421"></a>[T421:11](../../src/library/groups.test.ts#L11) | genre mode: by name, unclassified last, order kept within | genre別一覧を名前順にし、未分類を最後・群内順を維持する | 維持 / 成功 |
| <a id="T422"></a>[T422:23](../../src/library/groups.test.ts#L23) | feed mode: manual first, then feeds, each split by genre | feed別一覧を手動追加→feed→genreの順でグループ化する | 維持 / 成功 |
| <a id="T423"></a>[T423:43](../../src/library/groups.test.ts#L43) | feed mode follows the user's feed order; a feed not in it goes last | feed群をユーザー順にし、未知feedを最後へ置く | 維持 / 成功 |

## src/library/library.test.ts（9件）

本番の接続先: [src/library/library.ts](../../src/library/library.ts)。

境界: 実scope/facet集合計算とbackend filter生成。SQLは動かさない。

重複判断: e2eがDOM、Rust store/searchがDB側を担当。9件は時間・集合・count・緩和等の別契約。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T424"></a>[T424:73](../../src/library/library.test.ts#L73) | scopes: recent is the last 7 days; genre/feed null are 未分類/手動追加 | recentの7日境界と未分類/手動追加scopeを判定する | 維持 / 成功 |
| <a id="T425"></a>[T425:82](../../src/library/library.test.ts#L82) | groups: a scope by id and a facet dimension (OR within, AND with the others), labelled by name | グループscopeとfacetのOR/AND・名前表示を守る | 維持 / 成功 |
| <a id="T426"></a>[T426:106](../../src/library/library.test.ts#L106) | importance: 重要 keeps scores at or above its minimum, the facet has 未判定, and both reach the backend as is | 重要閾値・未判定facetとbackend filter変換を守る | 維持 / 成功 |
| <a id="T427"></a>[T427:116](../../src/library/library.test.ts#L116) | facets: AND across dimensions, OR within, tags by tagMode | facet次元間AND・次元内OR・タグmodeを適用する | 維持 / 成功 |
| <a id="T428"></a>[T428:126](../../src/library/library.test.ts#L126) | popover counts: own dimension removed, except tags in all mode | facet件数計算から自分の次元を外し、タグallだけ例外にする | 維持 / 成功 |
| <a id="T429"></a>[T429:148](../../src/library/library.test.ts#L148) | relaxations: one per active facet, plus the scope unless all | 現条件から一つずつ緩和する候補を組み立てる | 維持 / 成功 |
| <a id="T430"></a>[T430:166](../../src/library/library.test.ts#L166) | labels and backend filters | scope/facetの表示labelとbackend filterを組み立てる | 維持 / 成功 |
| <a id="T431"></a>[T431:178](../../src/library/library.test.ts#L178) | kept: an article read while listed stays in that view only | 表示中に既読にした記事はそのview内だけ保持する | 維持 / 成功 |
| <a id="T432"></a>[T432:194](../../src/library/library.test.ts#L194) | a feed folder scope holds its feeds' articles and is named after the folder | フォルダscopeを所属feedの記事とフォルダ名へ解決する | 維持 / 成功 |

## src/library/scopes.test.ts（2件）

本番の接続先: [src/library/scopes.ts](../../src/library/scopes.ts)。

境界: 実filter候補/キー変換。DOMoptionは作らない。

重複判断: e2e search/chat scopeが接続を補完。フォルダの候補構造は独立。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T433"></a>[T433:7](../../src/library/scopes.test.ts#L7) | filter groups: empty genres dropped, 未分類/手動追加 always offered, keys round-trip | 空genre除外・特殊候補常設・filter key往復を守る | 維持 / 成功 |
| <a id="T434"></a>[T434:64](../../src/library/scopes.test.ts#L64) | feed folders are offered as scopes beside their feeds | フィードと並べてフォルダscopeを候補に出す | 維持 / 成功 |

## src/library/selection.test.ts（1件）

本番の接続先: [src/library/selection.ts](../../src/library/selection.ts)。

境界: 実行選択状態の更新。pointer/focusはe2e。

重複判断: groups/contextmenuはbulk操作への接続。双方向spanの境界を残す。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T435"></a>[T435:7](../../src/library/selection.test.ts#L7) | a click toggles one row; Shift+click adds the span from the last clicked row, either way | clickの選択toggleと両方向Shift範囲追加を守る | 維持 / 成功 |

## src/overlay/overlay.test.ts（9件）

本番の接続先: [src/overlay/dom.ts](../../src/overlay/dom.ts)、[src/overlay/logic.ts](../../src/overlay/logic.ts)、[src/overlay/index.ts](../../src/overlay/index.ts)。

境界: JSDOMに実DOM/logic関数を読込。実サイト/隔離world/native bridgeはない。settleのみ実timer。

重複判断: sanitizeの二件は基本攻撃とscheme難読化で別。言語判定はRust/Readerと別runtime。T436だけF06。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T436"></a>[T436:20](../../src/overlay/overlay.test.ts#L20) | settle waits for DOM mutations to stop, up to a cap | DOM更新の静穏待機とcapを実時間の幅で確認する | 補強 / [P2 F06](findings.md#F06) |
| <a id="T437"></a>[T437:36](../../src/overlay/overlay.test.ts#L36) | Japanese pages translate into English, others into Japanese | Page言語属性/本文判定から翻訳先と翻訳要否を選ぶ | 維持 / 成功 |
| <a id="T438"></a>[T438:50](../../src/overlay/overlay.test.ts#L50) | splitByLineBreaks splits on blank lines and after sentence ends only | 空行と文末の改行だけで翻訳単位を分ける | 維持 / 成功 |
| <a id="T439"></a>[T439:55](../../src/overlay/overlay.test.ts#L55) | assignTranslated is exact by count and deterministic | 翻訳表示割合を個数どおり決定的に割り当てる | 維持 / 成功 |
| <a id="T440"></a>[T440:63](../../src/overlay/overlay.test.ts#L63) | sanitize drops scripts, handlers and unsafe URLs | script・event属性・危険URLをsanitizeする | 維持 / 成功 |
| <a id="T441"></a>[T441:68](../../src/overlay/overlay.test.ts#L68) | sanitize keeps http(s) links and image data URLs only, however the scheme is disguised | scheme難読化でも危険URLを落とし、許可URLを残す | 維持 / 成功 |
| <a id="T442"></a>[T442:83](../../src/overlay/overlay.test.ts#L83) | snippetHtml strips attributes, keeps links and numbers atoms | snippet属性を削ぎ、linkとatom番号を保持する | 維持 / 成功 |
| <a id="T443"></a>[T443:89](../../src/overlay/overlay.test.ts#L89) | sentences are wrapped in place and swapped without losing page elements | 実DOMの文をwrap/原文復元/訳文表示して既存要素を失わない | 維持 / 成功 |
| <a id="T444"></a>[T444:125](../../src/overlay/overlay.test.ts#L125) | routeKey: which keys pressed in the page go to the app, and when | Page内のkeyを入力状況に応じてアプリへ転送するか選ぶ | 維持 / 成功 |

## src/quiz/quiz.test.ts（2件）

本番の接続先: [src/quiz/quiz.ts](../../src/quiz/quiz.ts)。

境界: 実interval表示/採点候補helper。SRS更新はRust。

重複判断: core srsの日時とUI上の丸め表示は別。e2eでは全単位境界を網羅しない。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T445"></a>[T445:9](../../src/quiz/quiz.test.ts#L9) | formatInterval: minutes, hours, days, then months and years to a tenth | 復習間隔を分・時・日・月・年へ丸めて表示する | 維持 / 成功 |
| <a id="T446"></a>[T446:23](../../src/quiz/quiz.test.ts#L23) | a multiple-choice answer suggests 正解 or もう一度; recall has no suggestion | 選択問題の正誤から採点候補を選び、想起問題では強制しない | 維持 / 成功 |

## src/reader/mixed.test.ts（7件）

本番の接続先: [src/reader/mixed.ts](../../src/reader/mixed.ts)。

境界: 実表示block選択・言語判定・集計。Rust job/一覧componentは呼ばない。

重複判断: overlayはPageのDOM、coreは翻訳処理。T451/452は名称の射程だけF13、値のassertionは残す。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T447"></a>[T447:8](../../src/reader/mixed.test.ts#L8) | modes | 原文/訳文モードで翻訳を表示するblockを選ぶ | 維持 / 成功 |
| <a id="T448"></a>[T448:13](../../src/reader/mixed.test.ts#L13) | mixed ratio is exact by count and evenly spread | 混在割合の正確な個数・分散配置と未翻訳除外を守る | 維持 / 成功 |
| <a id="T449"></a>[T449:22](../../src/reader/mixed.test.ts#L22) | splitBackticks | backtickをコード部分と通常文字列へ分割する | 維持 / 成功 |
| <a id="T450"></a>[T450:30](../../src/reader/mixed.test.ts#L30) | picking 混在 or 訳文 starts a translation only when prose is untranslated and no job is on it | 表示mode・翻訳済み状態・job状態から自動翻訳要否を決める | 維持 / 成功 |
| <a id="T451"></a>[T451:48](../../src/reader/mixed.test.ts#L48) | the Reader counts only blocks the job would translate | needsTranslationの言語・翻訳済み・code除外条件を守る | 範囲・名称修正 / [P3 F13](findings.md#F13) |
| <a id="T452"></a>[T452:56](../../src/reader/mixed.test.ts#L56) | the list and the Reader count the same blocks left to translate | translationProgressのdone/total集計とcodeのみのゼロ件を守る | 範囲・名称修正 / [P3 F13](findings.md#F13) |
| <a id="T453"></a>[T453:69](../../src/reader/mixed.test.ts#L69) | an article with nothing to translate says why | 翻訳不要理由を本文なし/対象言語済み等から選ぶ | 維持 / 成功 |

## src/search/search.test.ts（3件）

本番の接続先: [src/search/search.ts](../../src/search/search.ts)。

境界: 実強調・抜粋・結果filter/group helper。検索engineはfixture。

重複判断: core検索とe2e操作は別。T455の弱いoracleのみF02。他2件は固定期待値が独立。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T454"></a>[T454:5](../../src/search/search.test.ts#L5) | highlight is case-insensitive and regex-safe | 正規表現記号を含む検索語を大小文字無視で安全に強調する | 維持 / 成功 |
| <a id="T455"></a>[T455:16](../../src/search/search.test.ts#L16) | excerpt centers on the first hit | 検索語を含む抜粋の省略記号・短文保持・非hit先頭を確認する | 補強 / [P1 F02](findings.md#F02) |
| <a id="T456"></a>[T456:24](../../src/search/search.test.ts#L24) | hits: method filters by match source, scope by article; grouped by article in rank order | 検索方式・記事scopeでhitを絞り、順位順に記事別へ束ねる | 維持 / 成功 |

## src/vocab/speech.test.ts（1件）

本番の接続先: [src/vocab/speech.ts](../../src/vocab/speech.ts)。

境界: voiceリストを入力して選択する実helper。音声deviceは使わない。

重複判断: e2eはUIからspeech stubへの接続。offline/locale優先順はここで維持。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T457"></a>[T457:7](../../src/vocab/speech.test.ts#L7) | englishVoice takes an offline en-US voice first, then other English, never a cloud one | offline en-USを優先し、他の英語は許すがcloud音声は使わない | 維持 / 成功 |

## src/vocab/vocab.test.ts（6件）

本番の接続先: [src/vocab/vocab.ts](../../src/vocab/vocab.ts)。

境界: 実選択文字/文/語形mark/filter helper。ブラウザSelection APIの接続はe2e。

重複判断: Rust captureは非信頼入力の検証。文字境界・複数出現・最長matchはfrontend固有。

| ID / 宣言位置 | テスト名 | 実際に守るもの | 判定 / 対応 |
| --- | --- | --- | --- |
| <a id="T458"></a>[T458:6](../../src/vocab/vocab.test.ts#L6) | isWord: short English selections on one line | 単語選択を短い単一行の英語へ制限する | 維持 / 成功 |
| <a id="T459"></a>[T459:14](../../src/vocab/vocab.test.ts#L14) | sentenceAt: the sentence around the word, across closing quotes and line breaks | quoteや改行をまたぐ選択語の所属文を取り出す | 維持 / 成功 |
| <a id="T460"></a>[T460:26](../../src/vocab/vocab.test.ts#L26) | captureIn picks the occurrence the selection is at | 同語が複数回ある文から選択位置に対応する出現を取る | 維持 / 成功 |
| <a id="T461"></a>[T461:33](../../src/vocab/vocab.test.ts#L33) | findWord finds the form used, as a whole word, case-insensitively | 語形を大小文字無視・単語境界付きで検索する | 維持 / 成功 |
| <a id="T462"></a>[T462:59](../../src/vocab/vocab.test.ts#L59) | wordMarks marks every saved form, longest first, with its meaning | 保存語形を最長優先でmarkし、意味を付ける | 維持 / 成功 |
| <a id="T463"></a>[T463:79](../../src/vocab/vocab.test.ts#L79) | shownEntries searches every form and sorts by added or due | 全語形検索と登録順/due順の単語一覧を作る | 維持 / 成功 |
