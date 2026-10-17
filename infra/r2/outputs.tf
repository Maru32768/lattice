output "bucket" {
  value = cloudflare_r2_bucket.backup.name
}

output "s3_endpoint" {
  description = "S3 互換 API の endpoint (path-style: <endpoint>/<bucket>/<key>)"
  value       = "https://${var.account_id}.r2.cloudflarestorage.com"
}
