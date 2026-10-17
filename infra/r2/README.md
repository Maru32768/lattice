# R2 バックアップ用 bucket（Terraform）

Lattice の自動バックアップ先となる Cloudflare R2 bucket と、その lifecycle rule を管理する。

| ファイル | 内容 |
|---|---|
| `versions.tf` | Cloudflare provider v5 |
| `main.tf` | `cloudflare_r2_bucket`、`cloudflare_r2_bucket_lifecycle`（`lattice/` 以下で途中で止まった multipart upload を 7 日で破棄） |
| `variables.tf` | `account_id`（必須）、`bucket_name`（既定 `lattice-backup`）、`location`（既定 `apac`） |
| `outputs.tf` | `bucket`、`s3_endpoint` |

**保持は世代数で行う。** 古いバックアップはアプリが消す。アップロードに成功するたびに、その端末の `lattice/<端末名>/` 以下を一覧し、新しいものから「残す世代数」（設定画面、既定 30）だけ残して残りを削除する。R2 の lifecycle rule は経過日数でしか消せないので使わない（しばらくアプリを動かさなかっただけでバックアップが全部消える、ということが起きない）。以前の版で作った bucket には日数で消す rule（`expire-old-backups`）が残っているので、`terraform apply` し直して外す。

state と `*.tfvars` は git に入れない（`.gitignore` 済み）。backend は未設定なので state はローカルの `terraform.tfstate` になる。state には秘密情報は入らない（アプリ用のアクセスキーは Terraform では作らない）。

## 1. bucket を作る

1. Cloudflare dashboard → **My Profile → API Tokens → Create Token → Custom token** で、Terraform 用のトークンを作る。
   - Permissions: **Account / Workers R2 Storage / Edit**
   - Account Resources: 対象のアカウントだけ
2. 変数ファイルを用意する。

   ```sh
   cd infra/r2
   cp terraform.tfvars.example terraform.tfvars   # account_id を書き換える
   export CLOUDFLARE_API_TOKEN=<1 のトークン>
   terraform init
   terraform plan
   terraform apply
   ```

3. `terraform output` で `bucket` と `s3_endpoint` を確認する。

## 2. アプリ用のアクセスキー（S3 互換 API）を作る

アプリが使うのは R2 の S3 互換 API 用のキー（Access Key ID と Secret Access Key）。Secret を Terraform の state に残さないため、dashboard で作る。

1. Cloudflare dashboard → **R2 Object Storage → Manage API tokens（API トークンの管理）→ Create API token**。
2. 次のように設定する。
   - Permissions: **Object Read & Write**（古い世代の一覧と削除にも使う）
   - Specify bucket(s): **Apply to specific buckets only** → `lattice-backup`（`bucket_name` の値）
   - TTL: 任意（期限を付けた場合は切れる前に作り直す）
3. 作成後に表示される **Access Key ID** と **Secret Access Key** を控える。Secret はこの画面でしか表示されない。
4. Lattice の 設定 → 「Cloudflare R2 への自動バックアップ」に、Account ID・Bucket・Access Key ID・Secret Access Key を入力し、「自動バックアップ」にチェックを入れて保存する。「今すぐ R2 にバックアップ」で動作を確認する。

Account ID・Bucket・Access Key ID・Secret Access Key・間隔・残す世代数は、あとからも設定画面で変更できる。Secret はローカル DB の `settings` テーブル（`secret.r2_secret_access_key`）にだけ保存され、バックアップのコピーからは削除される。設定画面には「設定済みかどうか」しか表示しない。Secret の横の「削除」で消せる（消すと自動バックアップも無効になる）。

## 3. 復元

オブジェクトは `lattice/<端末名>/lattice-<UTC 時刻>.db.gz`（例: `lattice/my-pc/lattice-20261017T030000Z.db.gz`）。

1. バックアップをダウンロードする。dashboard の bucket 画面から、または S3 互換 CLI で:

   ```sh
   aws s3 cp s3://lattice-backup/lattice/my-pc/lattice-20261017T030000Z.db.gz . \
     --endpoint-url https://<account_id>.r2.cloudflarestorage.com
   ```

2. 展開する: `gzip -d lattice-20261017T030000Z.db.gz`（Windows では 7-Zip でも可）。
3. **Lattice を終了する。**
4. 設定画面に表示されている DB のパス（`…/lattice.db`）のフォルダで、今の `lattice.db` を別名に退避し、`lattice.db-wal` と `lattice.db-shm` があれば一緒に退避する。
5. 展開したファイルを `lattice.db` という名前で置く。
6. Lattice を起動し、R2 の Secret Access Key など、バックアップに含まれない秘密情報（`secret.*`）を入力し直す。
