# R2バックアップ用bucket(Terraform)

Latticeの自動バックアップ先となるCloudflare R2 bucketと、そのlifecycle ruleを管理する。

| ファイル | 内容 |
|---|---|
| `versions.tf` | Cloudflare provider v5 |
| `main.tf` | `cloudflare_r2_bucket`、`cloudflare_r2_bucket_lifecycle`(`lattice/`以下で途中で止まったmultipart uploadを7日で破棄) |
| `variables.tf` | `account_id`(必須)、`bucket_name`(既定`lattice-backup`)、`location`(既定`apac`) |
| `outputs.tf` | `bucket`、`s3_endpoint` |

**保持は世代数で行う。** 古いバックアップはアプリが消す。アップロードに成功するたびに、その端末の`lattice/<端末名>/`以下を一覧し、新しいものから「残す世代数」(設定画面、既定30)だけ残して残りを削除する。R2のlifecycle ruleは経過日数でしか消せないので使わない(しばらくアプリを動かさなかっただけでバックアップが全部消える、ということが起きない)。以前の版で作ったbucketには日数で消すrule(`expire-old-backups`)が残っているので、`terraform apply`し直して外す。

stateと`*.tfvars`はgitに入れない(`.gitignore`済み)。backendは未設定なのでstateはローカルの`terraform.tfstate`になる。stateには秘密情報は入らない(アプリ用のアクセスキーはTerraformでは作らない)。

## 1. bucketを作る

1. Cloudflare dashboard → **My Profile → API Tokens → Create Token → Custom token**で、Terraform用のトークンを作る。
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

3. `terraform output`で`bucket`と`s3_endpoint`を確認する。

## 2. アプリ用のアクセスキー(S3互換API)を作る

アプリが使うのはR2のS3互換API用のキー(Access Key IDとSecret Access Key)。SecretをTerraformのstateに残さないため、dashboardで作る。

1. Cloudflare dashboard → **R2 Object Storage → Manage API tokens(APIトークンの管理)→ Create API token**。
2. 次のように設定する。
   - Permissions: **Object Read & Write**(古い世代の一覧と削除にも使う)
   - Specify bucket(s): **Apply to specific buckets only** → `lattice-backup`(`bucket_name`の値)
   - TTL: 任意(期限を付けた場合は切れる前に作り直す)
3. 作成後に表示される**Access Key ID**と**Secret Access Key**を控える。Secretはこの画面でしか表示されない。
4. Latticeの 設定 → 「Cloudflare R2への自動バックアップ」に、Account ID・Bucket・Access Key ID・Secret Access Keyを入力し、「自動バックアップ」にチェックを入れて保存する。「今すぐR2にバックアップ」で動作を確認する。

Account ID・Bucket・Access Key ID・Secret Access Key・間隔・残す世代数は、あとからも設定画面で変更できる。SecretはローカルDBの`settings`テーブル(`secret.r2_secret_access_key`)にだけ保存され、バックアップのコピーからは削除される。設定画面には「設定済みかどうか」しか表示しない。Secretの横の「削除」で消せる(消すと自動バックアップも無効になる)。

## 3. 復元

オブジェクトは`lattice/<端末名>/lattice-<UTC 時刻>.db.gz`(例: `lattice/my-pc/lattice-20261017T030000Z.db.gz`)。

1. バックアップをダウンロードする。dashboardのbucket画面から、またはS3互換CLIで:

   ```sh
   aws s3 cp s3://lattice-backup/lattice/my-pc/lattice-20261017T030000Z.db.gz . \
     --endpoint-url https://<account_id>.r2.cloudflarestorage.com
   ```

2. 展開する: `gzip -d lattice-20261017T030000Z.db.gz`(Windowsでは7-Zipでも可)。
3. **Latticeを終了する。**
4. 設定画面に表示されているDBのパス(`…/lattice.db`)のフォルダで、今の`lattice.db`を別名に退避し、`lattice.db-wal`と`lattice.db-shm`があれば一緒に退避する。
5. 展開したファイルを`lattice.db`という名前で置く。
6. Latticeを起動し、R2のSecret Access Keyなど、バックアップに含まれない秘密情報(`secret.*`)を入力し直す。
