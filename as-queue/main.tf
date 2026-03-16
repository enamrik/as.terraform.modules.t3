################################################################################
# AS Queue — Tier 3 Module
#
# Creates an SQS queue with a dead-letter queue and redrive policy.
# Uses the env context object for consistent naming and tagging.
################################################################################

terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

locals {
  name_prefix = "${var.stage}-${var.env_name}-${var.name}"

  default_tags = merge(var.tags, {
    environment = var.stage
    env_name    = var.env_name
    project     = "as-platform"
    managed-by  = "terraform"
  })
}

# -----------------------------------------------------------------------------
# Dead-letter queue
# -----------------------------------------------------------------------------

resource "aws_sqs_queue" "dlq" {
  name                       = "${local.name_prefix}-dlq"
  message_retention_seconds  = var.retention_days * 86400
  visibility_timeout_seconds = var.visibility_timeout

  tags = merge(local.default_tags, {
    Name = "${local.name_prefix}-dlq"
  })
}

# -----------------------------------------------------------------------------
# Main queue
# -----------------------------------------------------------------------------

resource "aws_sqs_queue" "main" {
  name                       = local.name_prefix
  visibility_timeout_seconds = var.visibility_timeout
  message_retention_seconds  = var.retention_days * 86400

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = var.max_receive_count
  })

  tags = merge(local.default_tags, {
    Name = local.name_prefix
  })
}
