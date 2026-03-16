################################################################################
# Shared variables (all runtimes)
################################################################################

variable "stage" {
  description = "Stage name (e.g. dev, staging, prod)"
  type        = string
}

variable "env_name" {
  description = "Environment name (e.g. integration, pr-42)"
  type        = string
}

variable "name" {
  description = "Service name (used in resource naming)"
  type        = string
}

variable "runtime" {
  description = "Where the service runs: lambda or ecs"
  type        = string
  default     = "lambda"

  validation {
    condition     = contains(["lambda", "ecs"], var.runtime)
    error_message = "runtime must be lambda or ecs"
  }
}

variable "image_uri" {
  description = "Pre-built Docker image URI (ECR). Required for runtime=ecs and package_type=Image."
  type        = string
  default     = null
}

variable "artifact_key" {
  description = "S3 key for pre-built Lambda Zip artifact. Defaults to {name}/latest.zip."
  type        = string
  default     = null
}

variable "memory" {
  description = "Memory in MB (Lambda: function memory, ECS: task memory)"
  type        = number
  default     = 512
}

variable "gateway" {
  description = "Attach this service to the environment's API Gateway"
  type        = bool
  default     = false
}

variable "gateway_routes" {
  description = "Map of route key to config for API Gateway routes (e.g. { \"GET /health\" = {} }). Ignored when gateway = false."
  type        = map(object({}))
  default     = {}
}

variable "environment_variables" {
  description = "Environment variables to set on the service"
  type        = map(string)
  default     = {}
}

variable "needs" {
  description = "Declares infrastructure dependencies for this service"
  type = object({
    mongo = optional(map(object({
      connection_string_ssm = optional(string, "")
    })), {})
    queue_publish = optional(map(object({
      queue_arn = string
    })), {})
    queue_consume = optional(map(object({
      queue_arn  = string
      batch_size = optional(number, 10)
    })), {})
    invoke = optional(map(object({
      function_arn = string
    })), {})
  })
  default = {}
}

variable "deployment_config" {
  description = "CodeDeploy deployment configuration (e.g. CodeDeployDefault.LambdaAllAtOnce, CodeDeployDefault.LambdaCanary10Percent5Minutes)"
  type        = string
  default     = "CodeDeployDefault.LambdaAllAtOnce"
}

variable "architectures" {
  description = "CPU architecture (e.g. [\"arm64\"] or [\"x86_64\"])"
  type        = list(string)
  default     = ["arm64"]
}

variable "tags" {
  description = "Additional tags to apply to all resources"
  type        = map(string)
  default     = {}
}

################################################################################
# Lambda-specific variables (ignored when runtime = ecs)
################################################################################

variable "package_type" {
  description = "Lambda package type: Zip (S3 artifact) or Image (ECR image). Ignored when runtime = ecs."
  type        = string
  default     = "Zip"

  validation {
    condition     = contains(["Zip", "Image"], var.package_type)
    error_message = "package_type must be Zip or Image"
  }
}

variable "handler" {
  description = "Lambda handler path (e.g. handler.handler). Ignored for Image/ECS."
  type        = string
  default     = "handler.handler"
}

variable "lambda_runtime" {
  description = "Lambda runtime (e.g. nodejs20.x). Ignored for Image/ECS."
  type        = string
  default     = "nodejs20.x"
}

variable "timeout" {
  description = "Lambda timeout in seconds. Ignored when runtime = ecs."
  type        = number
  default     = 30
}

################################################################################
# ECS-specific variables (ignored when runtime = lambda)
################################################################################

variable "port" {
  description = "Container port the app listens on. Ignored when runtime = lambda."
  type        = number
  default     = 8080
}

variable "cpu" {
  description = "ECS task CPU units (256 = 0.25 vCPU). Ignored when runtime = lambda."
  type        = number
  default     = 256
}

variable "desired_count" {
  description = "Number of running ECS tasks. Ignored when runtime = lambda."
  type        = number
  default     = 1
}

variable "health_check_path" {
  description = "HTTP health check path for ECS target group. Ignored when runtime = lambda."
  type        = string
  default     = "/health"
}
