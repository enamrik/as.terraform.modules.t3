output "env" {
  description = "Environment context object consumed by as-service, as-queue, and other T3 modules"
  value = {
    stage                = var.stage
    env_name             = var.env_name
    vpc_id               = data.aws_ssm_parameter.vpc_id.value
    private_subnet_ids   = jsondecode(data.aws_ssm_parameter.private_subnet_ids.value)
    public_subnet_ids    = jsondecode(data.aws_ssm_parameter.public_subnet_ids.value)
    lambda_sg_id         = data.aws_ssm_parameter.lambda_sg_id.value
    api_gateway_id       = aws_apigatewayv2_api.main.id
    api_gateway_endpoint = aws_apigatewayv2_api.main.api_endpoint
    domain               = local.env_domain
    artifact_bucket      = data.aws_ssm_parameter.artifact_bucket.value
    ecs_cluster_arn      = aws_ecs_cluster.main.arn
    vpc_link_id          = aws_apigatewayv2_vpc_link.main.id
  }
}
