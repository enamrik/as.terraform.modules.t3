/**
 * AsEnvironment — creates an environment namespace within a stage.
 *
 * Reads foundation SSM parameters and creates:
 * - API Gateway HTTP API with CORS
 * - CloudWatch log group for API Gateway
 * - ECS Fargate cluster
 * - VPC Link (API Gateway → private subnets)
 * - Custom domain ({env_name}.{domain})
 * - Route53 alias record
 * - SSM parameters for components to discover
 */

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import type { Connection, HasRoutes } from "./connections.js";

export interface AsEnvironmentArgs {
  stage: pulumi.Input<string>;
  envName: pulumi.Input<string>;
  tags?: pulumi.Input<Record<string, string>>;
}

export class AsEnvironment extends pulumi.ComponentResource {
  public readonly apiGatewayId: pulumi.Output<string>;
  public readonly apiGatewayEndpoint: pulumi.Output<string>;
  public readonly ecsClusterArn: pulumi.Output<string>;
  public readonly vpcLinkId: pulumi.Output<string>;
  public readonly domain: pulumi.Output<string>;

  constructor(name: string, args: AsEnvironmentArgs, opts?: pulumi.ComponentResourceOptions) {
    super("as:environment:AsEnvironment", name, {}, opts);

    const stage = pulumi.output(args.stage);
    const envName = pulumi.output(args.envName);
    const namePrefix = pulumi.interpolate`${stage}-${envName}`;

    const defaultTags = pulumi.output(args.tags ?? {}).apply((extra) => ({
      environment: stage,
      env_name: envName,
      project: "as-platform",
      "managed-by": "pulumi",
      ...extra,
    }));

    // -------------------------------------------------------------------------
    // Read foundation SSM parameters
    // -------------------------------------------------------------------------

    const vpcId = stage
      .apply((s) => aws.ssm.getParameter({ name: `/${s}/foundation/vpc-id` }))
      .apply((p) => p.value);

    const privateSubnetIds = stage
      .apply((s) => aws.ssm.getParameter({ name: `/${s}/foundation/private-subnet-ids` }))
      .apply((p) => JSON.parse(p.value) as string[]);

    const hostedZoneId = stage
      .apply((s) => aws.ssm.getParameter({ name: `/${s}/foundation/hosted-zone-id` }))
      .apply((p) => p.value);

    const foundationDomain = stage
      .apply((s) => aws.ssm.getParameter({ name: `/${s}/foundation/domain` }))
      .apply((p) => p.value);

    const certificateArn = stage
      .apply((s) => aws.ssm.getParameter({ name: `/${s}/foundation/certificate-arn` }))
      .apply((p) => p.value);

    // -------------------------------------------------------------------------
    // API Gateway HTTP API v2
    // -------------------------------------------------------------------------

    const apiGateway = new aws.apigatewayv2.Api(
      `${name}-api`,
      {
        name: namePrefix,
        protocolType: "HTTP",
        corsConfiguration: {
          allowOrigins: ["*"],
          allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
          allowHeaders: ["Content-Type", "Authorization", "AS-Platform-Version"],
          maxAge: 3600,
        },
        tags: defaultTags,
      },
      { parent: this },
    );

    const logGroup = new aws.cloudwatch.LogGroup(
      `${name}-api-logs`,
      {
        name: pulumi.interpolate`/aws/apigateway/${namePrefix}`,
        retentionInDays: 30,
        tags: defaultTags,
      },
      { parent: this },
    );

    new aws.apigatewayv2.Stage(
      `${name}-default-stage`,
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
        tags: defaultTags,
      },
      { parent: this },
    );

    // -------------------------------------------------------------------------
    // ECS Fargate Cluster
    // -------------------------------------------------------------------------

    const ecsCluster = new aws.ecs.Cluster(
      `${name}-ecs`,
      {
        name: namePrefix,
        settings: [{ name: "containerInsights", value: "enabled" }],
        tags: defaultTags,
      },
      { parent: this },
    );

    // -------------------------------------------------------------------------
    // VPC Link (API Gateway → private subnets)
    // -------------------------------------------------------------------------

    const vpcLinkSg = new aws.ec2.SecurityGroup(
      `${name}-vpc-link-sg`,
      {
        name: pulumi.interpolate`${namePrefix}-vpc-link`,
        description: "Security group for API Gateway VPC Link",
        vpcId: vpcId,
        egress: [
          {
            fromPort: 0,
            toPort: 0,
            protocol: "-1",
            cidrBlocks: ["0.0.0.0/0"],
          },
        ],
        tags: defaultTags,
      },
      { parent: this },
    );

    const vpcLink = new aws.apigatewayv2.VpcLink(
      `${name}-vpc-link`,
      {
        name: namePrefix,
        securityGroupIds: [vpcLinkSg.id],
        subnetIds: privateSubnetIds,
        tags: defaultTags,
      },
      { parent: this },
    );

    // -------------------------------------------------------------------------
    // Custom Domain — {env_name}.{domain}
    // -------------------------------------------------------------------------

    const envDomain = pulumi.interpolate`${envName}.${foundationDomain}`;

    const domainName = new aws.apigatewayv2.DomainName(
      `${name}-domain`,
      {
        domainName: envDomain,
        domainNameConfiguration: {
          certificateArn: certificateArn,
          endpointType: "REGIONAL",
          securityPolicy: "TLS_1_2",
        },
        tags: defaultTags,
      },
      { parent: this },
    );

    new aws.apigatewayv2.ApiMapping(
      `${name}-api-mapping`,
      {
        apiId: apiGateway.id,
        domainName: domainName.id,
        stage: "$default",
      },
      { parent: this },
    );

    new aws.route53.Record(
      `${name}-dns`,
      {
        zoneId: hostedZoneId,
        name: envDomain,
        type: "A",
        aliases: [
          {
            name: domainName.domainNameConfiguration.apply(
              (c) => c.targetDomainName,
            ),
            zoneId: domainName.domainNameConfiguration.apply(
              (c) => c.hostedZoneId,
            ),
            evaluateTargetHealth: false,
          },
        ],
      },
      { parent: this },
    );

    // -------------------------------------------------------------------------
    // SSM Parameters — environment outputs for components
    // -------------------------------------------------------------------------

    const ssmPrefix = pulumi.interpolate`/${stage}/${envName}`;

    new aws.ssm.Parameter(
      `${name}-ssm-api-gw-id`,
      {
        name: pulumi.interpolate`${ssmPrefix}/api-gateway-id`,
        type: "String",
        value: apiGateway.id,
        tags: defaultTags,
      },
      { parent: this },
    );

    new aws.ssm.Parameter(
      `${name}-ssm-api-gw-endpoint`,
      {
        name: pulumi.interpolate`${ssmPrefix}/api-gateway-endpoint`,
        type: "String",
        value: apiGateway.apiEndpoint,
        tags: defaultTags,
      },
      { parent: this },
    );

    new aws.ssm.Parameter(
      `${name}-ssm-ecs-cluster`,
      {
        name: pulumi.interpolate`${ssmPrefix}/ecs-cluster-arn`,
        type: "String",
        value: ecsCluster.arn,
        tags: defaultTags,
      },
      { parent: this },
    );

    new aws.ssm.Parameter(
      `${name}-ssm-vpc-link`,
      {
        name: pulumi.interpolate`${ssmPrefix}/vpc-link-id`,
        type: "String",
        value: vpcLink.id,
        tags: defaultTags,
      },
      { parent: this },
    );

    // -------------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------------

    this.apiGatewayId = apiGateway.id;
    this.apiGatewayEndpoint = apiGateway.apiEndpoint;
    this.ecsClusterArn = ecsCluster.arn;
    this.vpcLinkId = vpcLink.id;
    this.domain = envDomain;

    this.registerOutputs({
      apiGatewayId: this.apiGatewayId,
      apiGatewayEndpoint: this.apiGatewayEndpoint,
      ecsClusterArn: this.ecsClusterArn,
      vpcLinkId: this.vpcLinkId,
      domain: this.domain,
    });
  }

  /**
   * Returns a connection that attaches a service to this environment's API Gateway.
   */
  gateway(opts?: { routes?: string[] }): Connection<HasRoutes> {
    const apiGatewayId = this.apiGatewayId;
    const vpcLinkId = this.vpcLinkId;
    const routes = opts?.routes;
    return {
      bind(target) {
        target.addRoute({ apiGatewayId, vpcLinkId, routes });
      },
    };
  }

  /**
   * Creates a lightweight reference to an environment deployed in a separate stack.
   * Reads SSM parameters to discover the environment's API Gateway, ECS cluster, etc.
   */
  static ref(stage: pulumi.Input<string>, envName: pulumi.Input<string>): AsEnvironmentRef {
    return new AsEnvironmentRef(stage, envName);
  }
}

/**
 * Lightweight cross-stack reference to an environment.
 * Reads SSM parameters — no resources created.
 */
export class AsEnvironmentRef {
  public readonly apiGatewayId: pulumi.Output<string>;
  public readonly apiGatewayEndpoint: pulumi.Output<string>;
  public readonly ecsClusterArn: pulumi.Output<string>;
  public readonly vpcLinkId: pulumi.Output<string>;

  constructor(stage: pulumi.Input<string>, envName: pulumi.Input<string>) {
    const s = pulumi.output(stage);
    const e = pulumi.output(envName);
    const prefix = pulumi.interpolate`/${s}/${e}`;

    this.apiGatewayId = prefix
      .apply((p) => aws.ssm.getParameter({ name: `${p}/api-gateway-id` }))
      .apply((r) => r.value);

    this.apiGatewayEndpoint = prefix
      .apply((p) => aws.ssm.getParameter({ name: `${p}/api-gateway-endpoint` }))
      .apply((r) => r.value);

    this.ecsClusterArn = prefix
      .apply((p) => aws.ssm.getParameter({ name: `${p}/ecs-cluster-arn` }))
      .apply((r) => r.value);

    this.vpcLinkId = prefix
      .apply((p) => aws.ssm.getParameter({ name: `${p}/vpc-link-id` }))
      .apply((r) => r.value);
  }

  /**
   * Returns a connection that attaches a service to this environment's API Gateway.
   */
  gateway(opts?: { routes?: string[] }): Connection<HasRoutes> {
    const apiGatewayId = this.apiGatewayId;
    const vpcLinkId = this.vpcLinkId;
    const routes = opts?.routes;
    return {
      bind(target) {
        target.addRoute({ apiGatewayId, vpcLinkId, routes });
      },
    };
  }
}
