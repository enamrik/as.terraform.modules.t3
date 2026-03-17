/**
 * Deployment manifest — DynamoDB operations for tracking what's deployed where.
 *
 * Record types:
 *   ENV#{system}#{stage}#{env}  / COMPONENT#{service}           — current deployed state
 *   ENV#{system}#{stage}#{env}  / DEPLOY#{timestamp}#{service}  — deploy history
 *   TAG#{system}#{service}      / {stage}                       — artifact promotion tags
 *   ARTIFACT#{system}#{service} / {sha}                         — artifact metadata
 *   VERIFICATION#{system}#{stage}#{env} / {ts}#{service}        — verification snapshots
 */

import {
  DynamoDBClient,
  TransactWriteItemsCommand,
  PutItemCommand,
  GetItemCommand,
  QueryCommand,
  ScanCommand,
  BatchWriteItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { fromSSO } from "@aws-sdk/credential-provider-sso";

// ─── Existing record types ──────────────────────────────────────────────────

export type ComponentRecord = {
  service: string;
  artifactSha: string;
  artifactUri: string;
  previousSha: string | null;
  deployedAt: string;
  deployedBy: string;
  version: number;
};

export type DeployHistoryRecord = {
  service: string;
  artifactSha: string;
  artifactUri: string;
  previousSha: string | null;
  deployedBy: string;
  status: "succeeded" | "failed" | "rolling-back";
  deployedAt: string;
};

export type EnvironmentSummary = {
  envName: string;
  componentCount: number;
  lastDeployedAt: string;
};

// ─── New record types: artifact promotion ───────────────────────────────────

export type TagRecord = {
  service: string;
  tag: string;
  sha: string;
  taggedAt: string;
  taggedBy: string;
};

export type ArtifactRecord = {
  service: string;
  sha: string;
  status: "dev" | "staging" | "staging_rejected" | "prod";
  builtAt: string;
  builtBy: string;
  testedIn?: string;
  rejectedReason?: string;
};

export type VerificationRecord = {
  service: string;
  sha: string;
  alongside: Record<string, string>;
  e2eResult?: "passed" | "failed";
  pipelineRun?: string;
  recordedAt: string;
};

// ─── PK/SK helpers ──────────────────────────────────────────────────────────

function envPk(system: string, stage: string, envName: string): string {
  return `ENV#${system}#${stage}#${envName}`;
}

function componentSk(service: string): string {
  return `COMPONENT#${service}`;
}

function deploySk(timestamp: string, service: string): string {
  return `DEPLOY#${timestamp}#${service}`;
}

function tagPk(system: string, service: string): string {
  return `TAG#${system}#${service}`;
}

function artifactPk(system: string, service: string): string {
  return `ARTIFACT#${system}#${service}`;
}

function verificationPk(system: string, stage: string, envName: string): string {
  return `VERIFICATION#${system}#${stage}#${envName}`;
}

// ─── Manifest class ─────────────────────────────────────────────────────────

export class Manifest {
  private client: DynamoDBClient;
  private tableName: string;
  private system: string;

  constructor(tableName: string, region: string, system: string, profile?: string) {
    const useSSO = profile && !process.env.AWS_ACCESS_KEY_ID;
    this.client = new DynamoDBClient({
      region,
      ...(useSSO ? { credentials: fromSSO({ profile }) } : {}),
    });
    this.tableName = tableName;
    this.system = system;
  }

  // ── Deploy & component tracking ─────────────────────────────────────────

  async deploy(
    stage: string,
    envName: string,
    service: string,
    artifactSha: string,
    artifactUri: string,
    deployedBy: string,
    expectedVersion: number | null,
  ): Promise<void> {
    const pk = envPk(this.system, stage, envName);
    const now = new Date().toISOString();

    const current = await this.getComponent(stage, envName, service);
    const previousSha = current?.artifactSha ?? null;

    const command = new TransactWriteItemsCommand({
      TransactItems: [
        {
          Update: {
            TableName: this.tableName,
            Key: marshall({ pk, sk: componentSk(service) }),
            UpdateExpression:
              "SET artifact_sha = :sha, artifact_uri = :uri, previous_sha = :prev, deployed_at = :ts, deployed_by = :actor, version = if_not_exists(version, :zero) + :one, service = :svc",
            ConditionExpression:
              expectedVersion === null
                ? "attribute_not_exists(pk)"
                : "version = :expected",
            ExpressionAttributeValues: marshall({
              ":sha": artifactSha,
              ":uri": artifactUri,
              ":prev": previousSha ?? "NONE",
              ":ts": now,
              ":actor": deployedBy,
              ":zero": 0,
              ":one": 1,
              ":svc": service,
              ...(expectedVersion !== null ? { ":expected": expectedVersion } : {}),
            }),
          },
        },
        {
          Put: {
            TableName: this.tableName,
            Item: marshall({
              pk,
              sk: deploySk(now, service),
              service,
              artifact_sha: artifactSha,
              artifact_uri: artifactUri,
              previous_sha: previousSha ?? "NONE",
              deployed_by: deployedBy,
              status: "succeeded",
              deployed_at: now,
            }),
          },
        },
      ],
    });

    await this.client.send(command);
  }

  async getComponent(
    stage: string,
    envName: string,
    service: string,
  ): Promise<ComponentRecord | null> {
    const command = new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: "pk = :pk AND sk = :sk",
      ExpressionAttributeValues: marshall({
        ":pk": envPk(this.system, stage, envName),
        ":sk": componentSk(service),
      }),
    });

    const result = await this.client.send(command);
    if (!result.Items || result.Items.length === 0) return null;

    const item = unmarshall(result.Items[0]);
    return {
      service: item.service,
      artifactSha: item.artifact_sha,
      artifactUri: item.artifact_uri,
      previousSha: item.previous_sha === "NONE" ? null : item.previous_sha,
      deployedAt: item.deployed_at,
      deployedBy: item.deployed_by,
      version: item.version,
    };
  }

  async listComponents(stage: string, envName: string): Promise<ComponentRecord[]> {
    const command = new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: marshall({
        ":pk": envPk(this.system, stage, envName),
        ":prefix": "COMPONENT#",
      }),
    });

    const result = await this.client.send(command);
    return (result.Items ?? []).map((raw) => {
      const item = unmarshall(raw);
      return {
        service: item.service,
        artifactSha: item.artifact_sha,
        artifactUri: item.artifact_uri,
        previousSha: item.previous_sha === "NONE" ? null : item.previous_sha,
        deployedAt: item.deployed_at,
        deployedBy: item.deployed_by,
        version: item.version,
      };
    });
  }

  async listEnvironments(stage: string): Promise<EnvironmentSummary[]> {
    const prefix = `ENV#${this.system}#${stage}#`;

    const envs = new Map<string, { count: number; lastDeployedAt: string }>();
    let lastKey: Record<string, unknown> | undefined;

    do {
      const command = new ScanCommand({
        TableName: this.tableName,
        FilterExpression: "begins_with(pk, :prefix) AND begins_with(sk, :comp)",
        ExpressionAttributeValues: marshall({
          ":prefix": prefix,
          ":comp": "COMPONENT#",
        }),
        ExclusiveStartKey: lastKey ? marshall(lastKey) : undefined,
      });

      const result = await this.client.send(command);
      for (const raw of result.Items ?? []) {
        const item = unmarshall(raw);
        const pk = item.pk as string;
        const envName = pk.replace(prefix, "");
        const deployedAt = item.deployed_at as string;

        const existing = envs.get(envName);
        if (!existing) {
          envs.set(envName, { count: 1, lastDeployedAt: deployedAt });
        } else {
          existing.count++;
          if (deployedAt > existing.lastDeployedAt) {
            existing.lastDeployedAt = deployedAt;
          }
        }
      }
      lastKey = result.LastEvaluatedKey ? unmarshall(result.LastEvaluatedKey) : undefined;
    } while (lastKey);

    return Array.from(envs.entries())
      .map(([envName, data]) => ({
        envName,
        componentCount: data.count,
        lastDeployedAt: data.lastDeployedAt,
      }))
      .sort((a, b) => a.envName.localeCompare(b.envName));
  }

  async getHistory(
    stage: string,
    envName: string,
    service?: string,
    limit = 10,
  ): Promise<DeployHistoryRecord[]> {
    const command = new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: marshall({
        ":pk": envPk(this.system, stage, envName),
        ":prefix": "DEPLOY#",
      }),
      ScanIndexForward: false,
      Limit: limit,
    });

    const result = await this.client.send(command);
    const items = (result.Items ?? []).map((raw) => {
      const item = unmarshall(raw);
      return {
        service: item.service,
        artifactSha: item.artifact_sha,
        artifactUri: item.artifact_uri,
        previousSha: item.previous_sha === "NONE" ? null : item.previous_sha,
        deployedBy: item.deployed_by,
        status: item.status as DeployHistoryRecord["status"],
        deployedAt: item.deployed_at,
      };
    });

    return service ? items.filter((i) => i.service === service) : items;
  }

  async deleteEnvironment(stage: string, envName: string): Promise<void> {
    const pk = envPk(this.system, stage, envName);

    const allItems: Array<{ pk: string; sk: string }> = [];
    let lastKey: Record<string, unknown> | undefined;

    do {
      const command = new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: marshall({ ":pk": pk }),
        ProjectionExpression: "pk, sk",
        ExclusiveStartKey: lastKey ? marshall(lastKey) : undefined,
      });

      const result = await this.client.send(command);
      for (const raw of result.Items ?? []) {
        const item = unmarshall(raw) as { pk: string; sk: string };
        allItems.push(item);
      }
      lastKey = result.LastEvaluatedKey ? unmarshall(result.LastEvaluatedKey) : undefined;
    } while (lastKey);

    for (let i = 0; i < allItems.length; i += 25) {
      const batch = allItems.slice(i, i + 25);
      const command = new BatchWriteItemCommand({
        RequestItems: {
          [this.tableName]: batch.map((item) => ({
            DeleteRequest: { Key: marshall({ pk: item.pk, sk: item.sk }) },
          })),
        },
      });
      await this.client.send(command);
    }
  }

  // ── Artifact promotion: tags ────────────────────────────────────────────

  async tagArtifact(
    service: string,
    tag: string,
    sha: string,
    taggedBy: string,
    rejectedReason?: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const status = tag as ArtifactRecord["status"];

    const command = new TransactWriteItemsCommand({
      TransactItems: [
        {
          Put: {
            TableName: this.tableName,
            Item: marshall({
              pk: tagPk(this.system, service),
              sk: tag,
              sha,
              tagged_at: now,
              tagged_by: taggedBy,
              service,
            }),
          },
        },
        {
          Put: {
            TableName: this.tableName,
            Item: marshall({
              pk: artifactPk(this.system, service),
              sk: sha,
              status,
              built_at: now,
              built_by: taggedBy,
              service,
              ...(rejectedReason ? { rejected_reason: rejectedReason } : {}),
            }),
          },
        },
      ],
    });

    await this.client.send(command);
  }

  async getTag(service: string, tag: string): Promise<TagRecord | null> {
    const command = new GetItemCommand({
      TableName: this.tableName,
      Key: marshall({ pk: tagPk(this.system, service), sk: tag }),
    });

    const result = await this.client.send(command);
    if (!result.Item) return null;

    const item = unmarshall(result.Item);
    return {
      service: item.service,
      tag: item.sk,
      sha: item.sha,
      taggedAt: item.tagged_at,
      taggedBy: item.tagged_by,
    };
  }

  async getAllTags(service: string): Promise<TagRecord[]> {
    const command = new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: marshall({
        ":pk": tagPk(this.system, service),
      }),
    });

    const result = await this.client.send(command);
    return (result.Items ?? []).map((raw) => {
      const item = unmarshall(raw);
      return {
        service: item.service,
        tag: item.sk,
        sha: item.sha,
        taggedAt: item.tagged_at,
        taggedBy: item.tagged_by,
      };
    });
  }

  async getAllServiceTags(tag: string, services: string[]): Promise<TagRecord[]> {
    const results: TagRecord[] = [];
    for (const service of services) {
      const record = await this.getTag(service, tag);
      if (record) results.push(record);
    }
    return results;
  }

  // ── Artifact promotion: metadata ────────────────────────────────────────

  async getArtifactMeta(service: string, sha: string): Promise<ArtifactRecord | null> {
    const command = new GetItemCommand({
      TableName: this.tableName,
      Key: marshall({ pk: artifactPk(this.system, service), sk: sha }),
    });

    const result = await this.client.send(command);
    if (!result.Item) return null;

    const item = unmarshall(result.Item);
    return {
      service: item.service,
      sha: item.sk,
      status: item.status,
      builtAt: item.built_at,
      builtBy: item.built_by,
      testedIn: item.tested_in,
      rejectedReason: item.rejected_reason,
    };
  }

  // ── Artifact promotion: verification snapshots ──────────────────────────

  async recordVerification(
    stage: string,
    envName: string,
    record: VerificationRecord,
  ): Promise<void> {
    const command = new PutItemCommand({
      TableName: this.tableName,
      Item: marshall({
        pk: verificationPk(this.system, stage, envName),
        sk: `${record.recordedAt}#${record.service}`,
        service: record.service,
        sha: record.sha,
        alongside: record.alongside,
        ...(record.e2eResult ? { e2e_result: record.e2eResult } : {}),
        ...(record.pipelineRun ? { pipeline_run: record.pipelineRun } : {}),
        recorded_at: record.recordedAt,
      }),
    });

    await this.client.send(command);
  }
}
