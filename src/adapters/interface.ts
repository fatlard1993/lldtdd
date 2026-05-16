import type { TestSuite, RunResult } from "../types.ts";

export interface AdapterOptions {
  timeout?: number;
  [key: string]: unknown;
}

export interface Adapter {
  readonly name: string;
  run(suite: TestSuite, options?: AdapterOptions): Promise<RunResult>;
}
