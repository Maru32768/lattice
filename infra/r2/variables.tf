variable "account_id" {
  description = "Cloudflare account ID (dashboard の右側に表示される 32 桁の hex)"
  type        = string
}

variable "bucket_name" {
  description = "バックアップ用 R2 bucket の名前"
  type        = string
  default     = "lattice-backup"
}

variable "location" {
  description = "R2 の location hint (apac / eeur / enam / weur / wnam / oc)"
  type        = string
  default     = "apac"
}
