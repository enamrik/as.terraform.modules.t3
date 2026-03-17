/**
 * IacEngine — abstraction over infrastructure-as-code tools.
 *
 * Commands depend on this interface, never on terraform or pulumi directly.
 * The engine is resolved at startup from .as.yml's `engine` field.
 */

export type IacType = "env" | "component";

export type IacInitOpts = {
  root: string;
  stage: string;
  envName: string;
  type: IacType;
  serviceName?: string;
};

export type IacRunOpts = {
  root: string;
  stage: string;
  envName: string;
  type: IacType;
  serviceName?: string;
  vars?: Record<string, string>;
  autoApprove?: boolean;
};

export type IacOutputs = Record<string, string>;

export interface IacEngine {
  readonly name: string;
  init(opts: IacInitOpts): void;
  apply(opts: IacRunOpts): void;
  applyAsync(opts: IacRunOpts & { prefix?: string }): Promise<void>;
  destroy(opts: IacRunOpts): void;
  destroyAsync(opts: IacRunOpts & { prefix?: string }): Promise<void>;
  plan(opts: IacRunOpts): void;
}
