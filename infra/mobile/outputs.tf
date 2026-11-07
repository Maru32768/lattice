output "bucket" {
  value = cloudflare_r2_bucket.snapshot.name
}

output "worker_name" {
  value = cloudflare_workers_script.mobile.script_name
}
