################################################################################
# AS Environment — Tier 3 Module
#
# Creates an environment within a stage account. Reads foundation-level
# infrastructure from SSM parameters (/{stage}/foundation/*) and creates
# environment-level resources (API Gateway, Lambda authorizer, S3 bucket).
#
# The outputs form a flat "env" context object consumed by as-service, as-queue,
# and other T3 modules.
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
  name_prefix = "${var.stage}-${var.env_name}"

  default_tags = merge(var.tags, {
    environment = var.stage
    env_name    = var.env_name
    project     = "as-platform"
    managed-by  = "terraform"
  })
}

# -----------------------------------------------------------------------------
# Read foundation SSM parameters
# -----------------------------------------------------------------------------

data "aws_ssm_parameter" "vpc_id" {
  name = "/${var.stage}/foundation/vpc-id"
}

data "aws_ssm_parameter" "private_subnet_ids" {
  name = "/${var.stage}/foundation/private-subnet-ids"
}

data "aws_ssm_parameter" "public_subnet_ids" {
  name = "/${var.stage}/foundation/public-subnet-ids"
}

data "aws_ssm_parameter" "lambda_sg_id" {
  name = "/${var.stage}/foundation/lambda-sg-id"
}

data "aws_ssm_parameter" "artifact_bucket" {
  name = "/${var.stage}/foundation/artifact-bucket"
}

data "aws_ssm_parameter" "hosted_zone_id" {
  name = "/${var.stage}/foundation/hosted-zone-id"
}

data "aws_ssm_parameter" "domain" {
  name = "/${var.stage}/foundation/domain"
}

data "aws_ssm_parameter" "certificate_arn" {
  name = "/${var.stage}/foundation/certificate-arn"
}

# -----------------------------------------------------------------------------
# API Gateway HTTP API v2
# -----------------------------------------------------------------------------

resource "aws_apigatewayv2_api" "main" {
  name          = local.name_prefix
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    allow_headers = ["Content-Type", "Authorization", "AS-Platform-Version"]
    max_age       = 3600
  }

  tags = merge(local.default_tags, {
    Name = local.name_prefix
  })
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_gateway.arn
    format = jsonencode({
      requestId      = "$context.requestId"
      ip             = "$context.identity.sourceIp"
      requestTime    = "$context.requestTime"
      httpMethod     = "$context.httpMethod"
      routeKey       = "$context.routeKey"
      status         = "$context.status"
      protocol       = "$context.protocol"
      responseLength = "$context.responseLength"
      errorMessage   = "$context.error.message"
    })
  }

  tags = local.default_tags
}

resource "aws_cloudwatch_log_group" "api_gateway" {
  name              = "/aws/apigateway/${local.name_prefix}"
  retention_in_days = 30

  tags = local.default_tags
}

# -----------------------------------------------------------------------------
# ECS Fargate Cluster
# -----------------------------------------------------------------------------

resource "aws_ecs_cluster" "main" {
  name = local.name_prefix

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = local.default_tags
}

# -----------------------------------------------------------------------------
# VPC Link (API Gateway → private subnets for ECS services)
# -----------------------------------------------------------------------------

resource "aws_security_group" "vpc_link" {
  name        = "${local.name_prefix}-vpc-link"
  description = "Security group for API Gateway VPC Link"
  vpc_id      = data.aws_ssm_parameter.vpc_id.value

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.default_tags, { Name = "${local.name_prefix}-vpc-link" })
}

resource "aws_apigatewayv2_vpc_link" "main" {
  name               = local.name_prefix
  security_group_ids = [aws_security_group.vpc_link.id]
  subnet_ids         = jsondecode(data.aws_ssm_parameter.private_subnet_ids.value)

  tags = local.default_tags
}

# -----------------------------------------------------------------------------
# Custom Domain — {env_name}.{domain}
# -----------------------------------------------------------------------------

locals {
  env_domain = "${var.env_name}.${data.aws_ssm_parameter.domain.value}"
}

resource "aws_apigatewayv2_domain_name" "main" {
  domain_name = local.env_domain

  domain_name_configuration {
    certificate_arn = data.aws_ssm_parameter.certificate_arn.value
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }

  tags = local.default_tags
}

resource "aws_apigatewayv2_api_mapping" "main" {
  api_id      = aws_apigatewayv2_api.main.id
  domain_name = aws_apigatewayv2_domain_name.main.id
  stage       = aws_apigatewayv2_stage.default.id
}

resource "aws_route53_record" "main" {
  zone_id = data.aws_ssm_parameter.hosted_zone_id.value
  name    = local.env_domain
  type    = "A"

  alias {
    name                   = aws_apigatewayv2_domain_name.main.domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.main.domain_name_configuration[0].hosted_zone_id
    evaluate_target_health = false
  }
}

