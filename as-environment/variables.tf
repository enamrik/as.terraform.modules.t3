variable "env_name" {
  description = "Environment name within the stage (e.g. platform-dev, platform-staging)"
  type        = string
}

variable "stage" {
  description = "Stage/account name (e.g. as-dev, as-staging, as-prod)"
  type        = string
}

variable "tags" {
  description = "Additional tags to apply to all resources"
  type        = map(string)
  default     = {}
}
