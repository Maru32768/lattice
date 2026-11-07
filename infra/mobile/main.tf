# Credentials come from the CLOUDFLARE_API_TOKEN environment variable, never from files here.
provider "cloudflare" {}

# Apart from the backup bucket: the Worker's binding covers a whole bucket, and it must not reach the backups.
resource "cloudflare_r2_bucket" "snapshot" {
  account_id = var.account_id
  name       = var.bucket_name
  location   = var.location
}

resource "cloudflare_workers_script" "mobile" {
  account_id         = var.account_id
  script_name        = var.worker_name
  content            = file("${path.module}/worker.js")
  main_module        = "worker.js"
  compatibility_date = "2026-01-01"

  bindings = [{
    type        = "r2_bucket"
    name        = "BUCKET"
    bucket_name = cloudflare_r2_bucket.snapshot.name
  }]
}

# Gives the Worker its <worker>.<subdomain>.workers.dev address.
resource "cloudflare_workers_script_subdomain" "mobile" {
  account_id  = var.account_id
  script_name = cloudflare_workers_script.mobile.script_name
  enabled     = true
}
