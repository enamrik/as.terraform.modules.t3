#!/usr/bin/env npx tsx
/**
 * One-time migration: adds system name to manifest DynamoDB PKs.
 *
 * Old PK: ENV#{stage}#{env_name}
 * New PK: ENV#{system}#{stage}#{env_name}
 *
 * Usage: npx tsx scripts/migrate-manifest-pks.ts --stage dev --system as-platform --profile sofreellc-dev --table as-deployments-dev [--dry-run]
 */

import {
  DynamoDBClient,
  ScanCommand,
  BatchWriteItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { fromSSO } from "@aws-sdk/credential-provider-sso";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    stage: { type: "string" },
    system: { type: "string" },
    profile: { type: "string" },
    table: { type: "string" },
    region: { type: "string", default: "us-east-1" },
    "dry-run": { type: "boolean", default: false },
  },
});

if (!values.stage || !values.system || !values.table) {
  console.error("Usage: npx tsx scripts/migrate-manifest-pks.ts --stage dev --system as-platform --profile <profile> --table <table> [--dry-run]");
  process.exit(1);
}

const dryRun = values["dry-run"];
const client = new DynamoDBClient({
  region: values.region,
  ...(values.profile ? { credentials: fromSSO({ profile: values.profile }) } : {}),
});

const oldPrefix = `ENV#${values.stage}#`;
const newPrefix = `ENV#${values.system}#${values.stage}#`;

// Scan for old-format PKs
let lastKey: Record<string, unknown> | undefined;
const oldItems: Array<Record<string, unknown>> = [];

do {
  const result = await client.send(
    new ScanCommand({
      TableName: values.table,
      FilterExpression: "begins_with(pk, :old) AND NOT begins_with(pk, :new)",
      ExpressionAttributeValues: marshall({
        ":old": oldPrefix,
        ":new": newPrefix,
      }),
      ExclusiveStartKey: lastKey ? marshall(lastKey) : undefined,
    }),
  );

  for (const raw of result.Items ?? []) {
    oldItems.push(unmarshall(raw));
  }
  lastKey = result.LastEvaluatedKey ? unmarshall(result.LastEvaluatedKey) : undefined;
} while (lastKey);

if (oldItems.length === 0) {
  console.log("No items to migrate.");
  process.exit(0);
}

console.log(`Found ${oldItems.length} items to migrate.`);

// Migrate in batches of 25 (DynamoDB limit, and we need 2 ops per item: put + delete)
const batchSize = 12; // 12 items = 24 ops (put + delete each)

for (let i = 0; i < oldItems.length; i += batchSize) {
  const batch = oldItems.slice(i, i + batchSize);
  const writeRequests = [];

  for (const item of batch) {
    const oldPk = item.pk as string;
    const envName = oldPk.replace(oldPrefix, "");
    const newPk = `${newPrefix}${envName}`;

    console.log(`  ${oldPk} → ${newPk}  (sk: ${item.sk})`);

    const newItem = { ...item, pk: newPk };

    writeRequests.push({
      PutRequest: { Item: marshall(newItem) },
    });
    writeRequests.push({
      DeleteRequest: { Key: marshall({ pk: oldPk, sk: item.sk }) },
    });
  }

  if (!dryRun) {
    await client.send(
      new BatchWriteItemCommand({
        RequestItems: { [values.table!]: writeRequests },
      }),
    );
    console.log(`  Migrated batch ${Math.floor(i / batchSize) + 1}`);
  }
}

console.log(`\n${dryRun ? "[DRY RUN] Would have migrated" : "Migrated"} ${oldItems.length} items.`);
