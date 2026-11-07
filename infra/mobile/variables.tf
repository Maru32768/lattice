variable "account_id" {
  description = "Cloudflare account ID(dashboardの右側に表示される32桁の16進数)"
  type        = string
}

variable "bucket_name" {
  description = "スマホ用スナップショットのR2 bucketの名前。バックアップ用とは分ける"
  type        = string
  default     = "lattice-mobile"
}

variable "location" {
  description = "R2のlocation hint(apac / eeur / enam / weur / wnam / oc)"
  type        = string
  default     = "apac"
}

variable "worker_name" {
  description = "Workerの名前。アドレスは<名前>.<サブドメイン>.workers.devになる"
  type        = string
  default     = "lattice-mobile"
}
