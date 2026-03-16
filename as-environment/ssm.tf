################################################################################
# SSM Parameters — Environment-level outputs
#
# Published at /{stage}/{env_name}/* so downstream modules and CI/CD
# pipelines can discover environment resources by convention.
################################################################################

resource "aws_ssm_parameter" "api_gateway_id" {
  name  = "/${var.stage}/${var.env_name}/api-gateway-id"
  type  = "String"
  value = aws_apigatewayv2_api.main.id

  tags = local.default_tags
}

resource "aws_ssm_parameter" "api_gateway_endpoint" {
  name  = "/${var.stage}/${var.env_name}/api-gateway-endpoint"
  type  = "String"
  value = aws_apigatewayv2_api.main.api_endpoint

  tags = local.default_tags
}

resource "aws_ssm_parameter" "ecs_cluster_arn" {
  name  = "/${var.stage}/${var.env_name}/ecs-cluster-arn"
  type  = "String"
  value = aws_ecs_cluster.main.arn

  tags = local.default_tags
}

resource "aws_ssm_parameter" "vpc_link_id" {
  name  = "/${var.stage}/${var.env_name}/vpc-link-id"
  type  = "String"
  value = aws_apigatewayv2_vpc_link.main.id

  tags = local.default_tags
}

