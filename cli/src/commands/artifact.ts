/**
 * ascli artifact <service> --stage <stage>
 *
 * Convenience command: build + publish in one step.
 */

import { buildCommand } from "./build.js";
import { publishCommand, type PublishResult } from "./publish.js";

export type ArtifactOptions = {
  service: string;
  stage: string;
  platform?: string;
};

export function artifactCommand(opts: ArtifactOptions): PublishResult {
  buildCommand({ service: opts.service, platform: opts.platform });
  return publishCommand({ service: opts.service, stage: opts.stage });
}
