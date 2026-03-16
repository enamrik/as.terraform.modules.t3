output "service_url" {
  description = "Service URL (API Gateway endpoint if gateway=true, otherwise empty)"
  value       = var.gateway ? data.aws_ssm_parameter.api_gateway_endpoint[0].value : ""
}

output "role_arn" {
  description = "ARN of the service's IAM role (Lambda execution role or ECS task role)"
  value       = local.is_lambda ? module.lambda[0].lambda_role_arn : aws_iam_role.ecs_task[0].arn
}

output "role_name" {
  description = "Name of the service's IAM role"
  value       = local.is_lambda ? module.lambda[0].lambda_role_name : aws_iam_role.ecs_task[0].name
}

# Lambda-specific outputs
output "function_arn" {
  description = "ARN of the Lambda function (empty when runtime = ecs)"
  value       = local.is_lambda ? module.lambda[0].lambda_function_arn : ""
}

output "function_name" {
  description = "Name of the Lambda function (empty when runtime = ecs)"
  value       = local.is_lambda ? module.lambda[0].lambda_function_name : ""
}

output "alias_name" {
  description = "Name of the Lambda live alias (empty when runtime = ecs)"
  value       = local.is_lambda ? aws_lambda_alias.live[0].name : ""
}

output "codedeploy_app_name" {
  description = "CodeDeploy application name (empty when runtime = ecs)"
  value       = local.is_lambda ? aws_codedeploy_app.this[0].name : ""
}

output "codedeploy_deployment_group_name" {
  description = "CodeDeploy deployment group name (empty when runtime = ecs)"
  value       = local.is_lambda ? aws_codedeploy_deployment_group.this[0].deployment_group_name : ""
}

# ECS-specific outputs
output "ecs_service_name" {
  description = "Name of the ECS service (empty when runtime = lambda)"
  value       = local.is_ecs ? aws_ecs_service.this[0].name : ""
}

output "task_definition_arn" {
  description = "ARN of the ECS task definition (empty when runtime = lambda)"
  value       = local.is_ecs ? aws_ecs_task_definition.this[0].arn : ""
}
