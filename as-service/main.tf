################################################################################
# AS Service — Tier 3 Module
#
# Unified service module that deploys to Lambda or ECS Fargate based on
# the `runtime` variable. Components declare what they are (a service),
# not how they run.
#
# This module is purely declarative — it receives pre-built artifacts
# (S3 URI for Zip, ECR image URI for Image/ECS) and creates infrastructure.
# Building and publishing artifacts is handled by the @as-platform/cli.
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

# =============================================================================
# SSM Lookups — foundation and environment context
# =============================================================================

data "aws_ssm_parameter" "vpc_id" {
  name = "/${var.stage}/foundation/vpc-id"
}

data "aws_ssm_parameter" "private_subnet_ids" {
  name = "/${var.stage}/foundation/private-subnet-ids"
}

data "aws_ssm_parameter" "lambda_sg_id" {
  count = local.is_lambda ? 1 : 0
  name  = "/${var.stage}/foundation/lambda-sg-id"
}

data "aws_ssm_parameter" "artifact_bucket" {
  count = local.is_zip ? 1 : 0
  name  = "/${var.stage}/foundation/artifact-bucket"
}

data "aws_ssm_parameter" "api_gateway_id" {
  count = var.gateway ? 1 : 0
  name  = "/${var.stage}/${var.env_name}/api-gateway-id"
}

data "aws_ssm_parameter" "api_gateway_endpoint" {
  count = var.gateway ? 1 : 0
  name  = "/${var.stage}/${var.env_name}/api-gateway-endpoint"
}

data "aws_ssm_parameter" "ecs_cluster_arn" {
  count = local.is_ecs ? 1 : 0
  name  = "/${var.stage}/${var.env_name}/ecs-cluster-arn"
}

data "aws_ssm_parameter" "vpc_link_id" {
  count = local.is_ecs && var.gateway ? 1 : 0
  name  = "/${var.stage}/${var.env_name}/vpc-link-id"
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

# =============================================================================
# Locals — shared across runtimes
# =============================================================================

locals {
  is_lambda = var.runtime == "lambda"
  is_ecs    = var.runtime == "ecs"

  name_prefix        = "${var.stage}-${var.env_name}-${var.name}"
  private_subnet_ids = jsondecode(data.aws_ssm_parameter.private_subnet_ids.value)
  vpc_id             = data.aws_ssm_parameter.vpc_id.value

  # Lambda-specific locals
  is_zip   = local.is_lambda && var.package_type == "Zip"
  is_image = (local.is_lambda && var.package_type == "Image") || local.is_ecs

  artifact_bucket = local.is_zip ? data.aws_ssm_parameter.artifact_bucket[0].value : ""
  lambda_sg_id    = local.is_lambda ? try(data.aws_ssm_parameter.lambda_sg_id[0].value, "") : ""
  needs_vpc       = length(var.needs.mongo) > 0

  # Gateway locals
  api_gateway_id = var.gateway ? data.aws_ssm_parameter.api_gateway_id[0].value : ""

  # ECS-specific locals
  ecs_cluster_arn = local.is_ecs ? data.aws_ssm_parameter.ecs_cluster_arn[0].value : ""
  vpc_link_id     = local.is_ecs && var.gateway ? data.aws_ssm_parameter.vpc_link_id[0].value : ""

  default_tags = merge(var.tags, {
    environment = var.stage
    env_name    = var.env_name
    service     = var.name
    runtime     = var.runtime
    project     = "as-platform"
    managed-by  = "terraform"
  })

  mongo_env_vars = { for name, config in var.needs.mongo :
    "MONGO_URI_${upper(replace(name, "-", "_"))}" => config.connection_string_ssm
  }

  queue_publish_env_vars = { for url, config in var.needs.queue_publish :
    "QUEUE_URL_${upper(replace(url, "-", "_"))}" => url
  }

  all_env_vars = merge(
    {
      STAGE    = var.stage
      ENV_NAME = var.env_name
    },
    local.mongo_env_vars,
    local.queue_publish_env_vars,
    var.environment_variables,
  )
}

# =============================================================================
# Lambda Runtime
# =============================================================================

module "lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 7.0"
  count   = local.is_lambda ? 1 : 0

  function_name = local.name_prefix
  description   = "${var.name} service for ${var.env_name}"
  memory_size   = var.memory
  timeout       = var.timeout
  architectures = var.architectures
  publish       = true

  handler = local.is_zip ? var.handler : null
  runtime = local.is_zip ? var.lambda_runtime : null

  package_type   = var.package_type
  create_package = false

  s3_existing_package = local.is_zip ? {
    bucket = local.artifact_bucket
    key    = var.artifact_key != null ? var.artifact_key : "${var.name}/latest.zip"
  } : null

  image_uri = local.is_image ? var.image_uri : null

  environment_variables = local.all_env_vars

  vpc_subnet_ids         = local.needs_vpc ? local.private_subnet_ids : null
  vpc_security_group_ids = local.needs_vpc ? [local.lambda_sg_id] : null
  attach_network_policy  = local.needs_vpc

  cloudwatch_logs_retention_in_days = 30

  tags = local.default_tags
}

# =============================================================================
# Lambda Alias + CodeDeploy
# =============================================================================

resource "aws_lambda_alias" "live" {
  count = local.is_lambda ? 1 : 0

  name             = "live"
  function_name    = module.lambda[0].lambda_function_name
  function_version = module.lambda[0].lambda_function_version

  lifecycle {
    ignore_changes = [function_version, routing_config]
  }
}

resource "aws_codedeploy_app" "this" {
  count = local.is_lambda ? 1 : 0

  compute_platform = "Lambda"
  name             = local.name_prefix
  tags             = local.default_tags
}

resource "aws_iam_role" "codedeploy" {
  count = local.is_lambda ? 1 : 0

  name = "${local.name_prefix}-codedeploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "codedeploy.amazonaws.com" }
    }]
  })
  tags = local.default_tags
}

resource "aws_iam_role_policy_attachment" "codedeploy" {
  count = local.is_lambda ? 1 : 0

  role       = aws_iam_role.codedeploy[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSCodeDeployRoleForLambda"
}

resource "aws_codedeploy_deployment_group" "this" {
  count = local.is_lambda ? 1 : 0

  app_name               = aws_codedeploy_app.this[0].name
  deployment_group_name  = local.name_prefix
  deployment_config_name = var.deployment_config
  service_role_arn       = aws_iam_role.codedeploy[0].arn

  deployment_style {
    deployment_type   = "BLUE_GREEN"
    deployment_option = "WITH_TRAFFIC_CONTROL"
  }
}

# Lambda → API Gateway permission (on alias)
resource "aws_lambda_permission" "api_gateway" {
  count = local.is_lambda && var.gateway ? 1 : 0

  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = module.lambda[0].lambda_function_name
  qualifier     = aws_lambda_alias.live[0].name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${data.aws_apigatewayv2_api.gateway[0].execution_arn}/*/*"
}

data "aws_apigatewayv2_api" "gateway" {
  count  = local.is_lambda && var.gateway ? 1 : 0
  api_id = local.api_gateway_id
}

# Lambda needs DSL — SQS publish
resource "aws_iam_role_policy" "sqs_publish" {
  count = local.is_lambda && length(var.needs.queue_publish) > 0 ? 1 : 0

  name = "${local.name_prefix}-sqs-publish"
  role = module.lambda[0].lambda_role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:SendMessage", "sqs:GetQueueAttributes"]
      Resource = [for url, config in var.needs.queue_publish : config.queue_arn]
    }]
  })
}

# Lambda needs DSL — SQS consume
resource "aws_lambda_event_source_mapping" "sqs_consume" {
  for_each = local.is_lambda ? var.needs.queue_consume : {}

  event_source_arn = each.value.queue_arn
  function_name    = module.lambda[0].lambda_function_arn
  batch_size       = each.value.batch_size
  enabled          = true
}

resource "aws_iam_role_policy" "sqs_consume" {
  count = local.is_lambda && length(var.needs.queue_consume) > 0 ? 1 : 0

  name = "${local.name_prefix}-sqs-consume"
  role = module.lambda[0].lambda_role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
      Resource = [for url, config in var.needs.queue_consume : config.queue_arn]
    }]
  })
}

# Lambda needs DSL — invoke
resource "aws_iam_role_policy" "lambda_invoke" {
  count = local.is_lambda && length(var.needs.invoke) > 0 ? 1 : 0

  name = "${local.name_prefix}-lambda-invoke"
  role = module.lambda[0].lambda_role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = [for name, config in var.needs.invoke : config.function_arn]
    }]
  })
}

# =============================================================================
# ECS Runtime
# =============================================================================

# IAM
data "aws_iam_policy_document" "ecs_assume" {
  count = local.is_ecs ? 1 : 0

  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecs_execution" {
  count = local.is_ecs ? 1 : 0

  name               = "${local.name_prefix}-ecs-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume[0].json
  tags               = local.default_tags
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  count = local.is_ecs ? 1 : 0

  role       = aws_iam_role.ecs_execution[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "ecs_task" {
  count = local.is_ecs ? 1 : 0

  name               = "${local.name_prefix}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume[0].json
  tags               = local.default_tags
}

# CloudWatch Logs (ECS)
resource "aws_cloudwatch_log_group" "ecs" {
  count = local.is_ecs ? 1 : 0

  name              = "/ecs/${local.name_prefix}"
  retention_in_days = 30
  tags              = local.default_tags
}

# Task Definition
resource "aws_ecs_task_definition" "this" {
  count = local.is_ecs ? 1 : 0

  family                   = local.name_prefix
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.ecs_execution[0].arn
  task_role_arn            = aws_iam_role.ecs_task[0].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = upper(var.architectures[0]) == "ARM64" ? "ARM64" : "X86_64"
  }

  container_definitions = jsonencode([{
    name      = var.name
    image     = var.image_uri
    essential = true

    portMappings = [{
      containerPort = var.port
      protocol      = "tcp"
    }]

    environment = [for k, v in local.all_env_vars : { name = k, value = v }]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.ecs[0].name
        "awslogs-region"        = data.aws_region.current.name
        "awslogs-stream-prefix" = var.name
      }
    }
  }])

  tags = local.default_tags
}

# Security Groups (ECS)
resource "aws_security_group" "ecs_task" {
  count = local.is_ecs ? 1 : 0

  name        = "${local.name_prefix}-ecs-task"
  description = "ECS task security group for ${var.name}"
  vpc_id      = local.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.default_tags, { Name = "${local.name_prefix}-ecs-task" })
}

resource "aws_security_group" "ecs_alb" {
  count = local.is_ecs && var.gateway ? 1 : 0

  name        = "${local.name_prefix}-alb"
  description = "ALB security group for ${var.name}"
  vpc_id      = local.vpc_id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "HTTP from VPC Link"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.default_tags, { Name = "${local.name_prefix}-alb" })
}

resource "aws_security_group_rule" "ecs_task_from_alb" {
  count = local.is_ecs && var.gateway ? 1 : 0

  type                     = "ingress"
  from_port                = var.port
  to_port                  = var.port
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.ecs_alb[0].id
  security_group_id        = aws_security_group.ecs_task[0].id
  description              = "From ALB"
}

# ALB (ECS + gateway)
resource "aws_lb" "ecs" {
  count = local.is_ecs && var.gateway ? 1 : 0

  name               = substr(local.name_prefix, 0, 32)
  internal           = true
  load_balancer_type = "application"
  security_groups    = [aws_security_group.ecs_alb[0].id]
  subnets            = local.private_subnet_ids

  tags = local.default_tags
}

resource "aws_lb_target_group" "ecs" {
  count = local.is_ecs && var.gateway ? 1 : 0

  name        = substr(local.name_prefix, 0, 32)
  port        = var.port
  protocol    = "HTTP"
  vpc_id      = local.vpc_id
  target_type = "ip"

  health_check {
    path                = var.health_check_path
    protocol            = "HTTP"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
  }

  tags = local.default_tags
}

resource "aws_lb_listener" "ecs" {
  count = local.is_ecs && var.gateway ? 1 : 0

  load_balancer_arn = aws_lb.ecs[0].arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.ecs[0].arn
  }
}

# ECS Service
resource "aws_ecs_service" "this" {
  count = local.is_ecs ? 1 : 0

  name            = local.name_prefix
  cluster         = local.ecs_cluster_arn
  task_definition = aws_ecs_task_definition.this[0].arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = local.private_subnet_ids
    security_groups = [aws_security_group.ecs_task[0].id]
  }

  dynamic "load_balancer" {
    for_each = var.gateway ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.ecs[0].arn
      container_name   = var.name
      container_port   = var.port
    }
  }

  depends_on = [aws_lb_listener.ecs]
}

# =============================================================================
# API Gateway integration (shared — both runtimes)
# =============================================================================

resource "aws_apigatewayv2_integration" "lambda" {
  count = local.is_lambda && var.gateway ? 1 : 0

  api_id                 = local.api_gateway_id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_alias.live[0].arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "ecs" {
  count = local.is_ecs && var.gateway ? 1 : 0

  api_id             = local.api_gateway_id
  integration_type   = "HTTP_PROXY"
  integration_uri    = aws_lb_listener.ecs[0].arn
  integration_method = "ANY"
  connection_type    = "VPC_LINK"
  connection_id      = local.vpc_link_id
}

locals {
  integration_id = var.gateway ? (
    local.is_lambda ? aws_apigatewayv2_integration.lambda[0].id : aws_apigatewayv2_integration.ecs[0].id
  ) : ""
}

resource "aws_apigatewayv2_route" "default" {
  count = var.gateway && length(var.gateway_routes) == 0 ? 1 : 0

  api_id    = local.api_gateway_id
  route_key = "$default"
  target    = "integrations/${local.integration_id}"
}

resource "aws_apigatewayv2_route" "custom" {
  for_each = var.gateway ? var.gateway_routes : {}

  api_id    = local.api_gateway_id
  route_key = each.key
  target    = "integrations/${local.integration_id}"
}
