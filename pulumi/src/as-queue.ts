/**
 * AsQueue — creates an SQS queue with a dead-letter queue and redrive policy.
 *
 * Exposes connection factories:
 *   queue.publisher() — grants sqs:SendMessage + env var with queue URL
 *   queue.consumer()  — creates event source mapping + grants receive/delete
 *
 * Mirrors the as-queue Terraform module.
 */

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import type { Connection, HasEnvVars, HasPolicy, HasEventSources } from "./connections.js";

export interface AsQueueArgs {
  stage: pulumi.Input<string>;
  envName: pulumi.Input<string>;
  queueName: pulumi.Input<string>;
  retentionDays?: pulumi.Input<number>;
  visibilityTimeout?: pulumi.Input<number>;
  maxReceiveCount?: pulumi.Input<number>;
  tags?: pulumi.Input<Record<string, string>>;
}

export class AsQueue extends pulumi.ComponentResource {
  public readonly queueArn: pulumi.Output<string>;
  public readonly queueUrl: pulumi.Output<string>;
  public readonly dlqArn: pulumi.Output<string>;
  public readonly dlqUrl: pulumi.Output<string>;

  private readonly resourceName: string;

  constructor(name: string, args: AsQueueArgs, opts?: pulumi.ComponentResourceOptions) {
    super("as:queue:AsQueue", name, {}, opts);
    this.resourceName = name;

    const stage = pulumi.output(args.stage);
    const envName = pulumi.output(args.envName);
    const queueName = pulumi.output(args.queueName);
    const retentionDays = pulumi.output(args.retentionDays ?? 14);
    const visibilityTimeout = pulumi.output(args.visibilityTimeout ?? 300);
    const maxReceiveCount = args.maxReceiveCount ?? 3;

    const namePrefix = pulumi.interpolate`${stage}-${envName}-${queueName}`;

    const defaultTags = pulumi.output(args.tags ?? {}).apply((extra) => ({
      environment: stage,
      env_name: envName,
      project: "as-platform",
      "managed-by": "pulumi",
      ...extra,
    }));

    // -------------------------------------------------------------------------
    // Dead-letter queue
    // -------------------------------------------------------------------------

    const dlq = new aws.sqs.Queue(
      `${name}-dlq`,
      {
        name: pulumi.interpolate`${namePrefix}-dlq`,
        messageRetentionSeconds: retentionDays.apply((d) => d * 86400),
        visibilityTimeoutSeconds: visibilityTimeout,
        tags: defaultTags.apply((t) => ({ ...t, Name: namePrefix })),
      },
      { parent: this },
    );

    // -------------------------------------------------------------------------
    // Main queue
    // -------------------------------------------------------------------------

    const mainQueue = new aws.sqs.Queue(
      `${name}-main`,
      {
        name: namePrefix,
        visibilityTimeoutSeconds: visibilityTimeout,
        messageRetentionSeconds: retentionDays.apply((d) => d * 86400),
        redrivePolicy: dlq.arn.apply((arn) =>
          JSON.stringify({
            deadLetterTargetArn: arn,
            maxReceiveCount,
          }),
        ),
        tags: defaultTags.apply((t) => ({ ...t, Name: namePrefix })),
      },
      { parent: this },
    );

    // -------------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------------

    this.queueArn = mainQueue.arn;
    this.queueUrl = mainQueue.url;
    this.dlqArn = dlq.arn;
    this.dlqUrl = dlq.url;

    this.registerOutputs({
      queueArn: this.queueArn,
      queueUrl: this.queueUrl,
      dlqArn: this.dlqArn,
      dlqUrl: this.dlqUrl,
    });
  }

  /**
   * Returns a connection that grants publish (SendMessage) access to this queue.
   * Adds QUEUE_URL_{NAME} env var and sqs:SendMessage policy.
   */
  publisher(opts?: { envVarName?: string }): Connection<HasEnvVars & HasPolicy> {
    const envKey = opts?.envVarName
      ?? `QUEUE_URL_${this.resourceName.replace(/-/g, "_").toUpperCase()}`;
    const queueUrl = this.queueUrl;
    const queueArn = this.queueArn;
    return {
      bind(target) {
        target.addEnvVar(envKey, queueUrl);
        target.addPolicy(["sqs:SendMessage", "sqs:GetQueueAttributes"], queueArn);
      },
    };
  }

  /**
   * Returns a connection that wires this queue as an event source.
   * Adds event source mapping + sqs:ReceiveMessage/DeleteMessage policy.
   */
  consumer(opts?: { batchSize?: number }): Connection<HasEventSources & HasPolicy> {
    const queueArn = this.queueArn;
    const batchSize = opts?.batchSize ?? 10;
    return {
      bind(target) {
        target.addEventSource({ arn: queueArn, batchSize });
        target.addPolicy(
          ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
          queueArn,
        );
      },
    };
  }
}
