/**
 * Env — composable environment resource.
 *
 * The env layer declares what shared infrastructure exists via `provides`.
 * Only the resources you opt into get created. Components discover them
 * via Env.ref() which reads SSM parameters.
 *
 * Creation (env infra):
 *   const env = new Env("env", { stage, envName, provides: { apiGateway: {}, ecs: {} } });
 *
 * Reference (component infra):
 *   const env = Env.ref(stage, envName);
 *   new AsService("case-api", { ..., connections: [env.gateway()] });
 */

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import type { Connection, HasRoutes } from "./connections.js";

// ---------------------------------------------------------------------------
// Provides config — each key opts into a shared resource
// ---------------------------------------------------------------------------

export interface ApiGatewayConfig {
  cors?: {
    allowOrigins?: string[];
    allowMethods?: string[];
    allowHeaders?: string[];
    maxAge?: number;
  };
  logRetentionDays?: number;
}

export interface EcsConfig {
  containerInsights?: boolean;
}

export interface ProvidesConfig {
  apiGateway?: ApiGatewayConfig;
  ecs?: EcsConfig;
}

// ---------------------------------------------------------------------------
// Env args
// ---------------------------------------------------------------------------

export interface EnvArgs {
  stage: pulumi.Input<string>;
  envName: pulumi.Input<string>;
  provides?: ProvidesConfig;
  tags?: pulumi.Input<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Shared context for internal resource creation
// ---------------------------------------------------------------------------

interface EnvContext {
  name: string;
  stage: pulumi.Output<string>;
  envName: pulumi.Output<string>;
  namePrefix: pulumi.Output<string>;
  ssmPrefix: pulumi.Output<string>;
  tags: pulumi.Output<Record<string, string>>;
  parent: pulumi.Resource;
  foundation: FoundationParams;
}

interface FoundationParams {
  vpcId: pulumi.Output<string>;
  privateSubnetIds: pulumi.Output<string[]>;
  hostedZoneId: pulumi.Output<string>;
  domain: pulumi.Output<string>;
  certificateArn: pulumi.Output<string>;
}

// ---------------------------------------------------------------------------
// Env — creation side
// ---------------------------------------------------------------------------

export class Env extends pulumi.ComponentResource {
  public readonly domain: pulumi.Output<string>;

  constructor(name: string, args: EnvArgs, opts?: pulumi.ComponentResourceOptions) {
    super("as:environment:Env", name, {}, opts);

    const stage = pulumi.output(args.stage);
    const envName = pulumi.output(args.envName);
    const namePrefix = pulumi.interpolate`${stage}-${envName}`;
    const ssmPrefix = pulumi.interpolate`/${stage}/${envName}`;
    const provides = args.provides ?? {};

    const tags = pulumi.all([stage, envName, pulumi.output(args.tags ?? {})]).apply(([s, e, extra]): Record<string, string> => ({
      environment: s,
      env_name: e,
      "managed-by": "pulumi",
      ...extra,
    }));

    const foundation = readFoundation(stage);

    this.domain = pulumi.interpolate`${envName}.${foundation.domain}`;

    const ctx: EnvContext = {
      name,
      stage,
      envName,
      namePrefix,
      ssmPrefix,
      tags,
      parent: this,
      foundation,
    };

    if (provides.apiGateway !== undefined) {
      createApiGateway(ctx, provides.apiGateway);
    }

    if (provides.ecs !== undefined) {
      createEcsCluster(ctx, provides.ecs);
    }

    this.registerOutputs({ domain: this.domain });
  }

  static ref(stage: pulumi.Input<string>, envName: pulumi.Input<string>): EnvRef {
    return new EnvRef(stage, envName);
  }
}

// ---------------------------------------------------------------------------
// EnvRef — component side (reads SSM, no resources created)
// ---------------------------------------------------------------------------

export class EnvRef {
  private readonly ssmPrefix: pulumi.Output<string>;

  constructor(stage: pulumi.Input<string>, envName: pulumi.Input<string>) {
    const s = pulumi.output(stage);
    const e = pulumi.output(envName);
    this.ssmPrefix = pulumi.interpolate`/${s}/${e}`;
  }

  gateway(opts?: { routes?: string[] }): Connection<HasRoutes> {
    const apiGatewayId = this.ssm("api-gateway-id");
    const vpcLinkId = this.ssm("vpc-link-id");
    const routes = opts?.routes;
    return {
      bind(target) {
        target.addRoute({ apiGatewayId, vpcLinkId, routes });
      },
    };
  }

  ecs(): { clusterArn: pulumi.Output<string> } {
    return { clusterArn: this.ssm("ecs-cluster-arn") };
  }

  private ssm(key: string): pulumi.Output<string> {
    return this.ssmPrefix
      .apply((p) => aws.ssm.getParameter({ name: `${p}/${key}` }))
      .apply((r) => r.value);
  }
}

// ---------------------------------------------------------------------------
// API Gateway creation
// ---------------------------------------------------------------------------

function createApiGateway(ctx: EnvContext, config: ApiGatewayConfig): void {
  const cors = config.cors ?? {};

  const apiGateway = new aws.apigatewayv2.Api(
    `${ctx.name}-api`,
    {
      name: ctx.namePrefix,
      protocolType: "HTTP",
      corsConfiguration: {
        allowOrigins: cors.allowOrigins ?? ["*"],
        allowMethods: cors.allowMethods ?? ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowHeaders: cors.allowHeaders ?? ["Content-Type", "Authorization"],
        maxAge: cors.maxAge ?? 3600,
      },
      tags: ctx.tags,
    },
    { parent: ctx.parent },
  );

  const logGroup = new aws.cloudwatch.LogGroup(
    `${ctx.name}-api-logs`,
    {
      name: pulumi.interpolate`/aws/apigateway/${ctx.namePrefix}`,
      retentionInDays: config.logRetentionDays ?? 30,
      tags: ctx.tags,
    },
    { parent: ctx.parent },
  );

  new aws.apigatewayv2.Stage(
    `${ctx.name}-default-stage`,
    {
      apiId: apiGateway.id,
      name: "$default",
      autoDeploy: true,
      accessLogSettings: {
        destinationArn: logGroup.arn,
        format: JSON.stringify({
          requestId: "$context.requestId",
          ip: "$context.identity.sourceIp",
          requestTime: "$context.requestTime",
          httpMethod: "$context.httpMethod",
          routeKey: "$context.routeKey",
          status: "$context.status",
          protocol: "$context.protocol",
          responseLength: "$context.responseLength",
          errorMessage: "$context.error.message",
        }),
      },
      tags: ctx.tags,
    },
    { parent: ctx.parent },
  );

  // VPC Link — bridges API Gateway into private subnets
  const vpcLinkSg = new aws.ec2.SecurityGroup(
    `${ctx.name}-vpc-link-sg`,
    {
      name: pulumi.interpolate`${ctx.namePrefix}-vpc-link`,
      description: "Security group for API Gateway VPC Link",
      vpcId: ctx.foundation.vpcId,
      egress: [{ fromPort: 0, toPort: 0, protocol: "-1", cidrBlocks: ["0.0.0.0/0"] }],
      tags: ctx.tags,
    },
    { parent: ctx.parent },
  );

  const vpcLink = new aws.apigatewayv2.VpcLink(
    `${ctx.name}-vpc-link`,
    {
      name: ctx.namePrefix,
      securityGroupIds: [vpcLinkSg.id],
      subnetIds: ctx.foundation.privateSubnetIds,
      tags: ctx.tags,
    },
    { parent: ctx.parent },
  );

  // Custom domain — {envName}.{foundationDomain}
  const envDomain = pulumi.interpolate`${ctx.envName}.${ctx.foundation.domain}`;

  const domainName = new aws.apigatewayv2.DomainName(
    `${ctx.name}-domain`,
    {
      domainName: envDomain,
      domainNameConfiguration: {
        certificateArn: ctx.foundation.certificateArn,
        endpointType: "REGIONAL",
        securityPolicy: "TLS_1_2",
      },
      tags: ctx.tags,
    },
    { parent: ctx.parent },
  );

  new aws.apigatewayv2.ApiMapping(
    `${ctx.name}-api-mapping`,
    {
      apiId: apiGateway.id,
      domainName: domainName.id,
      stage: "$default",
    },
    { parent: ctx.parent },
  );

  new aws.route53.Record(
    `${ctx.name}-dns`,
    {
      zoneId: ctx.foundation.hostedZoneId,
      name: envDomain,
      type: "A",
      aliases: [{
        name: domainName.domainNameConfiguration.apply((c) => c.targetDomainName),
        zoneId: domainName.domainNameConfiguration.apply((c) => c.hostedZoneId),
        evaluateTargetHealth: false,
      }],
    },
    { parent: ctx.parent },
  );

  // SSM — publish for components to discover
  new aws.ssm.Parameter(
    `${ctx.name}-ssm-api-gw-id`,
    { name: pulumi.interpolate`${ctx.ssmPrefix}/api-gateway-id`, type: "String", value: apiGateway.id, tags: ctx.tags },
    { parent: ctx.parent },
  );

  new aws.ssm.Parameter(
    `${ctx.name}-ssm-api-gw-endpoint`,
    { name: pulumi.interpolate`${ctx.ssmPrefix}/api-gateway-endpoint`, type: "String", value: apiGateway.apiEndpoint, tags: ctx.tags },
    { parent: ctx.parent },
  );

  new aws.ssm.Parameter(
    `${ctx.name}-ssm-vpc-link`,
    { name: pulumi.interpolate`${ctx.ssmPrefix}/vpc-link-id`, type: "String", value: vpcLink.id, tags: ctx.tags },
    { parent: ctx.parent },
  );
}

// ---------------------------------------------------------------------------
// ECS Cluster creation
// ---------------------------------------------------------------------------

function createEcsCluster(ctx: EnvContext, config: EcsConfig): void {
  const cluster = new aws.ecs.Cluster(
    `${ctx.name}-ecs`,
    {
      name: ctx.namePrefix,
      settings: [{ name: "containerInsights", value: config.containerInsights !== false ? "enabled" : "disabled" }],
      tags: ctx.tags,
    },
    { parent: ctx.parent },
  );

  new aws.ssm.Parameter(
    `${ctx.name}-ssm-ecs-cluster`,
    { name: pulumi.interpolate`${ctx.ssmPrefix}/ecs-cluster-arn`, type: "String", value: cluster.arn, tags: ctx.tags },
    { parent: ctx.parent },
  );
}

// ---------------------------------------------------------------------------
// Foundation SSM reads
// ---------------------------------------------------------------------------

function readFoundation(stage: pulumi.Output<string>): FoundationParams {
  return {
    vpcId: stage
      .apply((s) => aws.ssm.getParameter({ name: `/${s}/foundation/vpc-id` }))
      .apply((p) => p.value),
    privateSubnetIds: stage
      .apply((s) => aws.ssm.getParameter({ name: `/${s}/foundation/private-subnet-ids` }))
      .apply((p) => JSON.parse(p.value) as string[]),
    hostedZoneId: stage
      .apply((s) => aws.ssm.getParameter({ name: `/${s}/foundation/hosted-zone-id` }))
      .apply((p) => p.value),
    domain: stage
      .apply((s) => aws.ssm.getParameter({ name: `/${s}/foundation/domain` }))
      .apply((p) => p.value),
    certificateArn: stage
      .apply((s) => aws.ssm.getParameter({ name: `/${s}/foundation/certificate-arn` }))
      .apply((p) => p.value),
  };
}
