# スマホ用スナップショットのbucketとWorker(Terraform)

PCが止まっていてもスマホで読めるように、LatticeはR2 bucketに記事を置き、スマホはWorker経由で読む。設計はdesign-review §32。

| ファイル | 内容 |
|---|---|
| `worker.js` | Worker本体。トークンを確かめて文書を返し、スマホの操作を`inbox/`に置く(テスト`scripts/mobile-worker.test.ts`) |
| `main.tf` | `cloudflare_r2_bucket`、`cloudflare_workers_script`、`cloudflare_workers_script_subdomain` |
| `variables.tf` | `account_id`(必須)、`bucket_name`(既定`lattice-mobile`)、`location`(既定`apac`)、`worker_name`(既定`lattice-mobile`) |
| `outputs.tf` | `bucket`、`worker_name` |

**バックアップとはbucketを分ける。** Workerのbindingはbucket全体に効くので、同じbucketだとWorkerからバックアップ(DB全体)に届いてしまう。

**ページはWorkerに含めない。** ページのファイルはアプリがbucketの`page/`に上げるので、アプリを更新するとページも更新される。ページの変更ではWorkerのデプロイはやり直さなくてよい。`worker.js`が変わったとき(APIやCSPが増えたとき)は、デプロイし直す。トークンもアプリが`auth.json`に上げるので、作り直しにデプロイは要らない。

stateと`*.tfvars`はgitに入れない(`.gitignore`済み)。stateには秘密情報は入らない(アプリ用のアクセスキーはTerraformでは作らない)。

## 1. bucketとWorkerを作る

1. Cloudflare dashboard → **My Profile → API Tokens → Create Token → Custom token**で、Terraform用のトークンを作る。
   - Permissions: **Account / Workers R2 Storage / Edit**、**Account / Workers Scripts / Edit**
   - Account Resources: 対象のアカウントだけ
2. 変数ファイルを用意して適用する。

   ```sh
   cd infra/mobile
   cp terraform.tfvars.example terraform.tfvars   # account_idを書き換える
   export CLOUDFLARE_API_TOKEN=<1のトークン>
   terraform init
   terraform plan
   terraform apply
   ```

3. Workerのアドレスを確認する。dashboardの **Workers & Pages → lattice-mobile** に`https://lattice-mobile.<サブドメイン>.workers.dev`の形で出る。

## 2. アプリ用のアクセスキー(S3互換API)を作る

SecretをTerraformのstateに残さないため、dashboardで作る。

1. Cloudflare dashboard → **R2 Object Storage → Manage API tokens → Create API token**。
2. 次のように設定する。
   - Permissions: **Object Read & Write**(`inbox/`の一覧と削除にも使う)
   - Specify bucket(s): **Apply to specific buckets only** → `lattice-mobile`(`bucket_name`の値)
3. 作成後に表示される**Access Key ID**と**Secret Access Key**を控える。Secretはこの画面でしか表示されない。

## 3. アプリに設定する

Latticeの「設定 › スマホで読む」の「PCが止まっていても読む」に、Account ID・Bucket・Access Key ID・Secret Access Key・Workerのアドレスを入れて、「スナップショットを公開」をオンにして保存する。最初の公開が終わると、QRコードで開けるようになる。

## bucketの中身

| キー | 内容 |
|---|---|
| `auth.json` | トークンのSHA-256 |
| `index.json` | 記事一覧(gzip) |
| `icons.json` | サイトのアイコン(gzip) |
| `articles/<id>.json` | 記事ごとの本文と訳文(gzip) |
| `page/*` | スマホのページ(画像以外はgzip) |
| `inbox/<到着時刻>-<id>.json` | スマホの操作。PCが適用したら消す |

公開のたびにアプリがbucketを一覧して、足りないものを上げ、要らなくなった記事を消す。lifecycle ruleは使わない。`articles/`と`page/`の外は消さない。

**止めるとき。** 「スナップショットを公開」をオフにすると、アプリは`auth.json`からトークンを消すので、Workerはどのトークンも受け付けなくなる。中身まで消すならbucketを空にする。
