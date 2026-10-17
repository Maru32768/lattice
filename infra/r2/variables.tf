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

variable "retention_days" {
  description = "この日数より古いバックアップを自動削除する"
  type        = number
  default     = 60

  validation {
    condition     = var.retention_days >= 1
    error_message = "retention_days must be at least 1."
  }
}
