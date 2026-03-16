# AS Terraform Modules — Tier 3

Opinionated platform modules that encode AbsenceSoft's stage/environment conventions.
These modules sit above the community modules (Tier 2) and provide a consistent,
convention-driven interface for deploying platform services.

## Module Hierarchy

```
Tier 1: AWS Provider resources (aws_lambda_function, aws_sqs_queue, ...)
Tier 2: Community modules (terraform-aws-modules/lambda/aws, etc.)
Tier 3: AS platform modules (this repo) — opinionated wrappers with conventions
```

## CLI — `@as-platform/cli`

Platform CLI for build, publish, deploy, rollback, and environment lifecycle.
Delegates backend config and variable passing to Terragrunt.

```bash
npm install -g @as-platform/cli

# Build + publish (CLI only — Terragrunt can't do this)
as build case-api                                    # esbuild or docker build
as publish case-api --stage dev                      # upload to S3 or ECR

# Deploy + manifest (CLI orchestrates terragrunt + DynamoDB)
as deploy case-api --stage dev --env integration     # build + publish + terragrunt apply + manifest
as deploy case-api --stage dev --env integration --sha abc123f  # deploy a specific version
as rollback case-api --stage dev --env integration   # redeploy previous version from manifest

# Environment lifecycle (CLI orchestrates ordered create/destroy)
as env create --stage dev --env pr-42 -y             # terragrunt apply on system layer
as env destroy --stage dev --env pr-42 -y            # destroy components → system → cleanup manifest
as env status --stage dev --env integration           # read deployment manifest
as env history --stage dev --env integration          # deployment history

# For terraform plan/state/etc., use terragrunt directly:
TG_ENV_NAME=pr-42 TG_STAGE=dev terragrunt plan
```

## Modules

### as-environment

Creates an environment within a stage account. Provides the shared infrastructure
that all services within the environment consume.

**Creates:** API Gateway HTTP API v2, ECS Fargate cluster, VPC Link, SSM parameters.
**Reads:** Foundation SSM params at `/{stage}/foundation/*`.
**Outputs:** Flat `env` object passed to as-service, as-queue, etc.

```hcl
module "env" {
  source   = "../as.terraform.modules.t3/as-environment"
  stage    = "dev"
  env_name = "integration"
}
```

### as-service

Unified service module. Components declare **what** they are (a service) and
**where** they run (`runtime = "lambda"` or `runtime = "ecs"`). The module
handles all runtime-specific infrastructure.

Modules receive pre-built artifacts — building and publishing is handled by
the `@as-platform/cli` (or CI pipeline).

```hcl
# Lambda service (Zip — artifact in S3)
module "service" {
  source   = "../as.terraform.modules.t3/as-service"
  stage    = var.stage
  env_name = var.env_name
  name     = "case-api"
  runtime  = "lambda"
  memory   = 1024
  gateway  = true

  needs = {
    mongo = {
      cases = { connection_string_ssm = "/${var.stage}/${var.env_name}/mongo-uri" }
    }
  }
}

# Lambda service (Docker image from ECR)
module "service" {
  source       = "../as.terraform.modules.t3/as-service"
  stage        = var.stage
  env_name     = var.env_name
  name         = "api-docs"
  runtime      = "lambda"
  package_type = "Image"
  image_uri    = var.image_uri
  memory       = 256
  gateway      = true
}

# ECS Fargate service (Docker image from ECR)
module "service" {
  source    = "../as.terraform.modules.t3/as-service"
  stage     = var.stage
  env_name  = var.env_name
  name      = "aspnet-app"
  runtime   = "ecs"
  image_uri = var.image_uri
  port      = 8080
  cpu       = 256
  memory    = 512
  gateway   = true
}
```

### as-queue

Creates an SQS queue with a dead-letter queue and redrive policy.

```hcl
module "case_events" {
  source   = "../as.terraform.modules.t3/as-queue"
  stage    = var.stage
  env_name = var.env_name
  name     = "case-events"
}
```

## SSM Parameter Convention

Foundation params (read by as-environment):
```
/{stage}/foundation/vpc-id
/{stage}/foundation/private-subnet-ids    # JSON array
/{stage}/foundation/public-subnet-ids     # JSON array
/{stage}/foundation/lambda-sg-id
/{stage}/foundation/artifact-bucket
```

Environment params (published by as-environment):
```
/{stage}/{env_name}/api-gateway-id
/{stage}/{env_name}/api-gateway-endpoint
/{stage}/{env_name}/ecs-cluster-arn
/{stage}/{env_name}/vpc-link-id
```

## Deployment Model

```
component_version = build(sourcecode, sha)           → as build
artifact_uri      = publish(artifact, stage)          → as publish
env               = create_or_update_infra(stage, env)→ as env create
env               = deploy_component(env, artifact)   → as deploy
```

Deployment manifest tracked in DynamoDB (`as-deployments-{stage}`). Each deploy
is an atomic TransactWriteItems — updates the current component record and
appends to deployment history.

## Prerequisites

The as-foundation module must publish SSM parameters at `/{stage}/foundation/*`
before as-environment can be used. See the as-foundation module in the
`as.terraform` repository.
