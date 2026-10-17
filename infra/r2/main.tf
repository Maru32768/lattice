# Credentials come from the CLOUDFLARE_API_TOKEN environment variable, never from files here.
provider "cloudflare" {}

resource "cloudflare_r2_bucket" "backup" {
  account_id = var.account_id
  name       = var.bucket_name
  location   = var.location
}

resource "cloudflare_r2_bucket_lifecycle" "backup" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.backup.name

  rules = [{
    id         = "expire-old-backups"
    enabled    = true
    conditions = { prefix = "lattice/" }
    delete_objects_transition = {
      condition = { type = "Age", max_age = var.retention_days * 86400 }
    }
    # Uploads interrupted mid-way (app closed during a multipart upload) would otherwise be billed forever.
    abort_multipart_uploads_transition = {
      condition = { type = "Age", max_age = 7 * 86400 }
    }
  }]
}
