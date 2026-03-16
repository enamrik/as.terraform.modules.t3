variable "stage" {
  description = "Stage name (e.g. dev, staging, prod)"
  type        = string
}

variable "env_name" {
  description = "Environment name (e.g. integration, pr-42)"
  type        = string
}

variable "max_receive_count" {
  description = "Maximum number of receives before a message is sent to the DLQ"
  type        = number
  default     = 3
}

variable "name" {
  description = "Queue name (used in resource naming)"
  type        = string
}

variable "retention_days" {
  description = "Message retention period in days"
  type        = number
  default     = 14
}

variable "tags" {
  description = "Additional tags to apply to all resources"
  type        = map(string)
  default     = {}
}

variable "visibility_timeout" {
  description = "Visibility timeout in seconds"
  type        = number
  default     = 300
}
