# 3. 概念モデルの照合（UI / docs と内部データモデル）

対象: Source / Feed / Folder / Genre / Tag / Collection / Scope / Facet / View Mode。guide.md（017bb2d で実装に合わせ済み）、roadmap.md、README.md、design-review.md、[当時の要件定義](https://github.com/Maru32768/lattice/blob/15c6d1090f022af5613e32bfb065a3dcad511e22/%E8%A6%81%E4%BB%B6%E5%AE%9A%E7%BE%A9.md) と、`crates/lattice-core/src`・`src-tauri/src`・`src`・`crates/lattice-cli/src` を突き合わせた。読み取りのみで、コードも docs も変えていない。

凡例: 重大度 **高** = ユーザーが期待した集合と違う集合を見る／データが黙って付け替わる、**中** = 同じものが場所によって違う名前・違う選択肢で出る、**低** = 内部値の漏れ・死んだ列・呼び名の揺れ。対処は **局所** = 仕様を決めずに直せる、**仕様判断** = どちらの意味にするか決めてから。

---

## 1. 概念ごとの対照表

| 概念 | UI / docs が言うこと | データモデル・API | ずれの要点 |
|---|---|---|---|
| **Source** | ナビの節「Source」（Feeds のツリー + **Added by hand**）、facet「Source」、並び替えメニューの「Group › Source」、パレット `@` =「Sources: feeds and folders」（guide.md:26, 275-281, 319; Nav.tsx:107-117; library.ts:35; ListPane.tsx:23; Palette.tsx:119-123） | 列は `articles.feed_id`（`REFERENCES feeds ON DELETE SET NULL`, store.rs:293）だけ。`ArticleFilter::Feed { id: Option<i64> }`、`None` = 手動追加（store.rs:679-682, 707-708）。facet 次元は `feeds: (number \| null)[]`（library.ts:23）。出所（手動・一括・Page・Markdown/PDF・CLI）を記録する列はない。要件定義 §11 の `source` は「メタデータ」としての出所（[旧要件定義の610〜621行](https://github.com/Maru32768/lattice/blob/15c6d1090f022af5613e32bfb065a3dcad511e22/%E8%A6%81%E4%BB%B6%E5%AE%9A%E7%BE%A9.md#L610-L621)） | 「Source」は出所ではなく「購読元 feed か、なし」。「Added by hand」= `feed_id IS NULL` の総称で、削除した feed の記事も、Markdown/PDF も、CLI の `save` もここ |
| **Feed** | 購読した RSS/Atom。「Deleting a feed keeps its articles under Added by hand」「View articles →」「unread and total counts」（guide.md:63） | `feeds`（store.rs:275-285, +custom_title/icon/filter/folder_id/position）、`feed_items (feed_id, normalized_url) PK`（store.rs:287-291、M:N）、`articles.feed_id`（1 記事 1 feed）。取り込み時に `feed_id IS NULL` の既存記事を feed に付け替える（feeds.rs:380-383）。`article_count` = `feed_id = feeds.id` の件数（feeds.rs:214） | feed_items は M:N を持つのに一覧・件数は 1:N の `feed_id` しか見ない。同じ URL を 2 つの feed が載せると 2 つ目の feed からは「無い」記事になる |
| **Folder** | feed をまとめる。feed は高々 1 つのフォルダ、入れ子なし。クリックで配下 feed の記事（guide.md:65-70）。「ファセットのソースはフォルダで絞らない」（roadmap.md:115） | `feed_folders`、`feeds.folder_id ON DELETE SET NULL`（store.rs:527-534）。`ArticleFilter::Folder { id }` = `feed_id IN (SELECT id FROM feeds WHERE folder_id = ?)`（store.rs:687-689, 711）。`ArticleRow.folder_id`（store.rs:650-651, 844） | 一覧 scope・対話 scope・CLI にはあるが、検索の scope select（SearchPane.tsx:40-42）と facet（library.ts:23）にはない。パレットの Tab は folder を feed id の列に展開する（Palette.tsx:199-200） |
| **Genre** | 記事に 1 つ、LLM が付け、手で変えると固定。設定 › Genres で改名・統合・削除（記事がないときだけ）（guide.md:238-246, 473-475）。ナビの「Genre」一覧、facet、検索・対話・CLI の scope | `genres(id, name UNIQUE NOCASE)`、`articles.genre_id` + `genre_source ('auto'\|'manual')`（store.rs:251-259）。`classifications.genre TEXT`（名前で履歴、store.rs:265）。API は全部**名前**キー: `ArticleFilter::Genre { name: Option<String> }`（store.rs:675-678）、`set_genre(id, name)`・`rename_genre(from, to)`・`delete_genre(name)`（classify.rs:106-142; lib.rs:263-274）、CLI `genre:NAME`（ops.rs:128） | id を持つのに外には名前しか出ない。改名・統合で保存済み scope（履歴・chat_messages.scope）が宙に浮く。`None`（未分類）は UI にはあるが CLI では書けない |
| **Tag** | 最大 3 つを LLM が付け、`+ Tag` / × で手で足し引き。「Automatic classification only adds tags. It never removes yours」（guide.md:238, 243）。facet、パレット `#`、対話・CLI の scope、`tags` コマンド | `tags(id, name UNIQUE NOCASE)` + `article_tags(article_id, tag_id)`（store.rs:193-202）。由来（auto/manual）の列はない。未使用タグは即削除（store.rs:1240, 1268）。分類は `INSERT OR IGNORE` で常に足す（classify.rs:286-288）。`ArticleFilter::Tag { name }`（store.rs:672-674） | genre/difficulty にある `*_source` の手動ピンがタグにはない。ユーザーが消した自動タグは「Auto-classify」で復活する。一覧 scope にはなく対話・CLI の scope にはある |
| **Collection** | 手で作る記事の集合。1 記事が複数に入る。削除しても記事は残る。一覧・facet・検索・対話・エクスポートの範囲（guide.md:256-265, 529） | `groups(id, name UNIQUE NOCASE, color, description)` + `group_articles`（store.rs:473-486）。`ArticleFilter::Group { id }`（store.rs:683-685）。`GroupRow { id, name, created_at, count }`（groups.rs:14-20; api.ts:199-204）。英語 UI だけ "Collection"（en.ts:273, 348）、日本語は「グループ」（ja.ts:269, 344）。CLI/MCP `group:ID`（ops.rs:130; mcp.rs:19）、export `"type": "group"`・ファイル名 `group<id>`（export.rs:67-79, 162） | 名前が UI（Collection / グループ）・コード（group）・CLI（group:ID）・export（group）で割れる。日本語では一覧の「グループ」（並び替え）と同じ語。`color`/`description` は UI にない（design-review.md §24） |
| **Scope（一覧）** | 「Lists」: Recently added / Unread / Favorites / All / Important / 各 collection / 各 genre / 各 folder / 各 feed / Added by hand。1 つ選ぶ（guide.md:273-275） | `Scope`（library.ts:7-14）= `ArticleFilter` + `recent`。`toFilter`: `recent → all`（library.ts:206-208）。backend の `ArticleFilter`（store.rs:668-694）に `recent` はなく、`Important { min }` は閾値を値として持つ | 「Recently added」は backend に存在しない（store.rs:665 コメント "Recently added is All"）。`important` の閾値は scope オブジェクトに焼き付く |
| **Scope（検索）** | 「Recently added, Unread, Favorites, a collection, a genre or a feed」+ filter chips（guide.md:306） | `ScopeSelect`: all / recent / unread / favorites / groups / genres / feeds+manual（SearchPane.tsx:28-42）。feed の選択肢は記事行の `feed_id` から作る（SearchPane.tsx:115-117）。backend は `search_blocks(query, filter)` 上限 30 件（lib.rs:782-784; search.rs:14, 53-59）。facets と `recent` は返ってきた 30 件をクライアントで削る（SearchPane.tsx:49; library.ts:107-111） | folder / important / tag を選べない。一覧が folder や important のとき select に一致する option がない。facet は「検索の範囲」ではなく「上位 30 件の事後フィルタ」 |
| **Scope（対話）** | This article / All open articles / 各 open article / All articles / the current list / collection / genre / feed / folder / tag（guide.md:334-338） | `chat::Scope = Article \| Articles \| Filter(ArticleFilter)`（chat.rs:72-87）。選択肢は `filterGroups`: group / genre(+未分類) / feed(+manual+folders) / tag（scopes.ts:15-36）。「現在の一覧」は scope だけで facets を含まず、scope が all/recent なら出ない（App.tsx:1288; ChatPane に facets prop はない） | 一覧で facet を重ねた集合を対話に渡せない。unread / favorites / important は「現在の一覧」経由でしか選べない |
| **Scope（CLI/MCP）** | `all / unread / favorites / tag:NAME / genre:NAME / feed:ID / folder:ID / group:ID / important[:MIN] / article:ID[,ID]`（guide.md:653-667） | `parse_scope`（ops.rs:122-148）→ `chat::Scope`。`feed:` の `None`（手動追加）と `genre:` の `None`（未分類）は到達不能（ops.rs:128-129、`id.parse::<i64>().is_ok()` ガードの後の `.ok()` は常に `Some`）。`important` は設定を読まず 4 固定（ops.rs:132 vs relevance.rs:23, 59） | 手動追加・未分類・最近追加が書けない。「重要」の既定がアプリ設定とずれうる |
| **Facet** | chips: Genre / Tag / Collection / Source / Difficulty / Importance / Status。次元内 OR、次元間 AND、タグは All/Any（guide.md:277） | `Facets`（library.ts:19-28）。完全にクライアント側（library.ts:1-2 コメント, 88-90）。backend に facet の概念はない | scope と同じ次元（genre / group / feed / unread / favorite / important）を facet も持つ |
| **View Mode（並び替え › Group）** | 「group the list by Source or Genre」（guide.md:281）。roadmap F7「feed ごと → その中でジャンルごと」と「ジャンルごと」（roadmap.md:17） | `Grouping = "none" \| "feed" \| "genre"`（ListPane.tsx:14, 23）。`groupArticles`: feed → genre の 2 段 vs genre の 1 段、見出しはラベルの文字列順、manual が先頭（groups.ts:33-46）。`useState` のみで永続化なし（App.tsx:148; design-review.md §8 未実装） | folder を知らない。feed の見出し順が H26 のユーザー順（guide.md:72「Every list of feeds in the app」）と違う。local 記事は Source =「Added by hand」、サイト列は "Local"（api.ts:90） |

---

## 2. 食い違いの一覧

### D1. 「Scope」の意味が一覧・検索・対話・CLI で違う — **高 / 仕様判断**

- 一覧: 集合 = scope ∧ facets、すべてクライアント側（library.ts:107-111）。
- 検索: backend には scope（`toFilter`）だけ渡す（App.tsx:470; lib.rs:782-784、上限 30 件）。facets と `recent` は返ってきた 30 件を削るだけ（SearchPane.tsx:49; library.ts:206）。
- 対話: scope だけ。「Current list」は `filterKey(toFilter(scope))` で、facets は捨てる。scope が all / recent のときは選択肢自体が出ない（App.tsx:1288; ChatPane.tsx の props に facets はない）。
- CLI/MCP: scope だけ（ops.rs:199, 247, 286）。
- **結果**: 「最近追加 + タグ postgres」の一覧から `/` で検索すると、全記事の上位 30 件のうち条件に合うものだけが残り、該当する記事があっても 0 件になりうる。同じ一覧を対話に渡す手段がない。design-review.md §11 の「未実装（意図的）」に「一覧で開いているグループを範囲にすること（1 つの `ArticleFilter` では表せない。複合条件が必要になったら filter を AND の列にする）」とあり、既知の制約。
- 対処: facets を backend の条件に下ろす（`ArticleFilter` を AND の列にするか、`ArticleQuery { scope, facets }` を 1 つ作る）。どこまでを「範囲」と呼ぶかの決定が先。

### D2. 「Source」の正体が `articles.feed_id` 1 本で、出所でも M:N でもない — **高 / 仕様判断**

1. **「Added by hand」は「feed に属さない」の総称**。手動保存・一括インポート・Page の「Add to Index」・Markdown/PDF（`local:` URL）・CLI `save`・削除済み feed の記事がすべて同じ箱（store.rs:292-293 コメント "fall back to manually added"; Nav.tsx:117; library.ts:163）。要件定義 §11 の `source` は出所のメタデータ（[旧要件定義の610〜621行](https://github.com/Maru32768/lattice/blob/15c6d1090f022af5613e32bfb065a3dcad511e22/%E8%A6%81%E4%BB%B6%E5%AE%9A%E7%BE%A9.md#L610-L621)）だが、出所を持つ列はない。
2. **記事は高々 1 つの feed**。`feed_items (feed_id, normalized_url)` は M:N（store.rs:287-291）だが、一覧・未読数・`article_count` は `articles.feed_id` だけを見る（store.rs:707; feeds.rs:214; Nav.tsx:113 の `counts.feedUnread`）。feed B が feed A と同じ URL を載せると、B の「View articles →」にも B の未読数にも出ない。H25 のフォルダ（TechFeed のチャンネル別 RSS）はまさに重複する使い方。
3. **手動保存した記事を feed が黙って引き取る**。取り込み時に `UPDATE articles SET feed_id = ?1 WHERE feed_id IS NULL AND normalized_url IN (...)`（feeds.rs:380-383）。初回取り込みの 20 件上限（`take`, feeds.rs:357）とは無関係に、feed が載せた全 URL（`unseen`, feeds.rs:375）が対象。ユーザーの「手動追加」一覧から記事が消え、feed 側に現れる。guide.md はこれを書いていない。
4. 逆に feed を削除すると記事は「Added by hand」へ（guide.md:63 は明記）。feed を登録し直すと `feed_items` は CASCADE で消えているので初回扱いになり、3. で再び引き取る。
- **結果**: UI の「Source」は「どこから来たか」に見えるが、モデルは「今どの feed が URL を載せているか（最初の 1 つ）」。
- 対処: (a) 出所を `articles.source_kind` で持つ、(b) feed 所属は `feed_items` の M:N を正にして `feed_id` を「最初に取り込んだ feed」に格下げする、(c) 3. の引き取りを仕様として guide に書く — のどれにするか。

### D3. Source / Feed / Folder の境界と名前が画面ごとに違う — **中 / 局所**

| 場所 | ラベル | 中身 |
|---|---|---|
| ナビ（Nav.tsx:107-117） | **Source** › **Feeds**（nav.feeds）＋ **Added by hand** | folder ツリー + feed + manual |
| facet（library.ts:35; en.ts:267） | **Source** | feed id ∪ null。folder なし（roadmap.md:115 で明示） |
| 並び替え › Group（ListPane.tsx:23） | **Source** | feed → genre。folder なし |
| 検索 scope（SearchPane.tsx:40-42） | optgroup **Source** | feed（記事を持つものだけ, SearchPane.tsx:115-117）+ manual。folder なし |
| 対話 scope（scopes.ts:26-33; en.ts:264） | optgroup **Feed** | manual + folder + feed |
| パレット（Palette.tsx:119-123, 197-210; en.ts:780-790） | **Sources** / `Source: X` / `Folder: X` | feed + folder + manual。folder の Tab は feed id の列に展開（Palette.tsx:199-200）→ 以後フォルダ構成を変えても facet は古い feed 集合のまま |
| CLI（ops.rs:129-131） | `feed:ID` / `folder:ID` | manual は書けない |

- 「Source」グルーピングの見出し順は `label.localeCompare`（groups.ts:33-36）で、guide.md:72「Every list of feeds in the app ... uses that order」（H26 のユーザー順）と食い違う。検索 scope の feed 順は `rank` で feed 順に合わせてある（SearchPane.tsx:113-115）ので、グルーピングだけが取り残されている。
- 対処: optgroup ラベルを `common.source` に統一、検索 select に folder を足す、グルーピングを `feeds` の順で並べる、folder facet を「folder 次元」として持つか明示的に「feed に展開」と出す。

### D4. 検索の scope select が一覧 scope を表せない — **中 / 局所**

一覧が `folder` / `important` のとき `runSearch` は正しい filter を送る（App.tsx:455-470; `toFilter`）が、`ScopeSelect` の `<select value={JSON.stringify(scope)}>` にその option がない（SearchPane.tsx:27-42）。tag も選べない（対話・CLI では選べる）。
対処: option を `filterGroups`（scopes.ts）と共用にする。

### D5. Tag に由来（auto / manual）がなく、Genre と非対称 — **中 / 仕様判断**

- genre・difficulty は `*_source = 'manual'` で手動ピンを守る（store.rs:258, 311; classify.rs:278-283）。`article_tags` に同じ列はない（store.rs:197-201）。
- 分類は `INSERT OR IGNORE` でタグを常に足す（classify.rs:286-288）。ユーザーが × で消した自動タグは、「Auto-classify」（`enqueue_manual`, classify.rs:53-58）や再分類で戻る。guide.md:243「It never removes yours」は真だが「消したものを戻さない」とは言っていない。
- タグは未使用になると即削除（store.rs:1240, 1268）。空のタグは存在できず、改名・統合・削除の画面もない（ジャンルにはある: guide.md:246, 473-475）。
- Tag は一覧 scope にない（library.ts:7-14）が対話・CLI の scope にはある（scopes.ts:34; ops.rs:127）。Genre は両方にある。
- 対処: `article_tags.source` を足して手動ピン／手動削除を記録するか、タグを「LLM の提案は提案欄、確定はユーザー」にするか。Genre と Tag の違い（1 対 N 以外）を guide に 1 行で書く。

### D6. Collection の内部名 `group` が外に漏れ、日本語では一覧の「グループ」と衝突 — **中 / 局所**

- CLI/MCP `group:ID`（ops.rs:130; mcp.rs:19）、guide.md:664「`group:ID` … Articles in this collection」、export `"type": "group"`・ヘッダ `group`・ファイル名 `group<id>`（export.rs:67-79, 91-92, 162）。英語 UI は "Collection"（en.ts:273, 348, 789; exportSection.group）。
- 日本語 UI: `common.group` = 「グループ」（ja.ts:269）と、並び替えメニューの `listPane.group` = 「グループ」・`listPane.sortGroup` = 「並び順とグループ」（ja.ts:381-383）が同じ語。design-review.md §24 は英語で "Collection" にした理由を「並び替えメニューの Group と紛れないため」と書くが、日本語には同じ対策がない。
- アイコン: Collection も Folder も `folder`（Palette.tsx:120-123; ListPane.tsx:224）。
- `groups.color` / `groups.description` は UI に出ないまま export に出る（store.rs:476-477; export.rs:77-79; design-review.md §24）。
- 対処: CLI に `collection:ID` を足して `group:` を alias に、export の type も同様。日本語の並び替えを「まとめ方」等に。アイコンを分ける。色・説明は列ごと使うか export から外す。

### D7. 「Important」の閾値が scope に焼き付く — **低 / 局所**

`{ kind: "important", min }`（library.ts:14; store.rs:690-693）を履歴（history.ts:19, 39）と `chat_messages.scope`（store.rs:240）に保存する。設定で閾値を変えても過去の履歴・対話の範囲は古い値。CLI の `important` は 4 固定（ops.rs:132）で、設定 `relevance_threshold`（relevance.rs:21, 59）を読まない。
対処: `Important { min: Option<i64> }` にして `None` は実行時に設定を読む。

### D8. Genre は名前キー、Feed / Collection / Folder は id キー — **低 / 局所**

`ArticleFilter::Genre { name }`、`set_genre(name)`、`rename_genre(from, to)`、`delete_genre(name)`（store.rs:675-678; classify.rs:106-142; lib.rs:263-274）、`classifications.genre TEXT`（store.rs:265）。改名・統合後、保存済みの scope（履歴・対話）や facet の名前は無効になる（design-review.md §15 未実装「改名で消えたジャンルを選んでいる絞り込みの自動解除」）。CLI は `genre:` 未分類・`feed:` 手動追加を書けない（ops.rs:128-129）。
対処: `Genre { id: Option<i64> }` に寄せる（NOCASE 照合は名前→id 解決に残す）。CLI に `genre:none` / `feed:none` を足す。

### D9. 内部 id と死んだ列の漏れ — **低 / 局所**

- facet の feed 名は記事行の `feed_title` から引く（library.ts:157-165）。feed を削除した直後に facet が残ると「Feed {id}」（en.ts:299）が見える。
- `GroupRow` に `color`/`description` がない（api.ts:199-204）のに schema と export にはある（D6）。

### D10. View Mode（Group by）の形が非対称で、Source 概念の半分しか知らない — **低 / 仕様判断**

- 「Source」は feed → genre の 2 段、「Genre」は 1 段（groups.ts:41-46; roadmap.md:17）。guide.md:281 は 2 段であることを言わない。
- folder を知らない（Groupable は `genre / feed_id / feed_title` だけ、groups.ts:4-8）。見出し順は文字列順（D3）。
- 永続化なし（App.tsx:148; design-review.md §8「表示モードと並び順の保存」未実装）。
- `local:` 記事は Page なし（App.tsx:496）、Source =「Added by hand」、サイト列 = "Local"（api.ts:90）。一覧行には「Source（feed）」と「Site（domain / Local）」という 2 つの出所が並ぶ。
- 対処: Grouping を「facet 次元を 1 つ選ぶ」に一般化すれば folder / collection / difficulty でも並べられ、ラベル順・件数は facet と共有できる。

### D11. 同じ選択の呼び名が 3 つ — **低 / 局所**

ナビの選択は Library では「Lists」+「Filters」（guide.md:273-277）、検索・対話では「Scope」（en.ts:655, 674）、README では "Filter the list by scope and stack facets"（README.md:9）、コードでは `Scope` / `Facets`。
対処: 用語を 1 組（Scope / Filter）に揃える。

### D12. Facet が scope と同じ次元を持つ — **低 / 仕様判断**

genres / groups / feeds / state(unread, favorite) / relevance は scope（genre / group / feed / folder / unread / favorites / important）と重なる（library.ts:7-28）。scope = genre X ∧ facet genre Y は常に空で、`relaxations`（library.ts:192-203）が救済している。
対処: scope を「ナビで選ぶ既定 facet」と定義し直せば 1 つのモデルで済む（§3）。

### D13. 「Recently added」が backend に存在しない — **低 / 局所**

`toFilter: recent → all`（library.ts:206-208; store.rs:665）。検索では all で検索して事後に削る（D1）、対話では「Current list」が出ない（App.tsx:1288）、CLI にはない。
対処: `ArticleFilter::SavedSince { days }` を足す。

---

## 3. 境界の再設計案（短く）

**(a) 出所と購読を分ける。** `articles.source_kind ∈ {manual, page, bulk, file, cli, feed}` を 1 列足し、「Source」facet／グルーピングはこれを見る。feed 所属は既にある `feed_items (feed_id, url)` を正（M:N）にして、`articles.feed_id` は「最初に取り込んだ feed」に格下げするか消す。feed・folder の一覧・未読数・`article_count` は `feed_items` を引く。これで「2 つの feed が同じ記事を載せる」「手動保存した記事を feed が後から載せる」が自然に表せ、D2 が消える。

**(b) ラベルは 3 種で、違いは「数」と「誰が付けるか」だけにする。**

| | 1 記事あたり | 付ける主体 | キー |
|---|---|---|---|
| Genre | 1 | LLM、手動でピン | id |
| Tag | N | LLM が足し、手動で足し引き（`article_tags.source` で手動削除も記憶） | id |
| Collection | N | 手動のみ | id |

全部 id キー（NOCASE の名前解決は入口だけ）。名前は UI / CLI / export で 1 つ（Collection → `collection:ID`, `"type": "collection"`; 日本語は並び替えの「グループ」を別語に）。管理画面（改名・統合・削除）は 3 種で同じ形にする。

**(c) 範囲は 1 つのクエリ型にする。** `ArticleQuery { scope: ArticleFilter, facets: Facets }` を backend が解釈し、一覧・検索・対話・CLI・export が同じものを受け取る（design-review §11 の「AND の列」）。`recent` と `important` は `SavedSince { days }` / `Important { min: Option }` として backend に持つ。scope は「ナビが選ぶ既定の facet の組」と定義し、facet と二重に持たない。検索は facet 込みで backend が絞ってから上位 N を返す。

**(d) View Mode は facet 次元の 1 つで並べる。** `Grouping = Dim | "none"`。見出しの順と件数は `facetBase` / `countBy` と共有し、feed は H26 の順、folder も選べる。並び順と一緒に保存する。

**(e) 名前を揃える。** Source（出所）／ Feed（購読）／ Folder（購読のまとめ）／ Scope（範囲）／ Filter（facet）の 5 語を guide・UI・CLI・export・コードで固定し、`@` は「Feeds and folders」と呼ぶ。
