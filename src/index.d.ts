export type ThrottlDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: Date;
  retryAfterMs: number;
};

export type ThrottlStore = {
  check(key: string, options: ThrottlOptions): ThrottlDecision | Promise<ThrottlDecision>;
  reset(key: string): boolean | Promise<boolean>;
  cleanup?(): number | Promise<number>;
};

type CommonOptions = {
  maxKeys?: number;
  maxEvents?: number;
  clock?: () => number;
  store?: ThrottlStore;
};

export type SlidingWindowOptions = CommonOptions & {
  algorithm?: 'sliding-window';
  limit: number;
  windowMs: number;
};

export type TokenBucketOptions = CommonOptions & {
  algorithm: 'token-bucket';
  capacity: number;
  refillRate: number;
  refillIntervalMs: number;
};

export type ThrottlOptions = SlidingWindowOptions | TokenBucketOptions;

export type ThrottlInstance = {
  check(key: string): Promise<ThrottlDecision>;
  reset(key: string): Promise<boolean>;
  cleanup(): Promise<number>;
  middleware<Request>(options: { key(request: Request): string }): (
    request: Request,
    response: {
      setHeader(name: string, value: string): void;
      status(code: number): { json(body: unknown): void };
    },
    next: (error?: unknown) => void,
  ) => Promise<void>;
};

export type PgQueryResult = { rows: Record<string, unknown>[]; rowCount: number | null };
export type PgConnection = {
  query(sql: string, values?: unknown[]): Promise<PgQueryResult>;
  release(): void;
};
export type PgPool = {
  connect(): Promise<PgConnection>;
  query(sql: string, values?: unknown[]): Promise<PgQueryResult>;
};

export type PostgresStore = ThrottlStore & { migrate(): Promise<void> };

export function postgresStore(options: { pool: PgPool; namespace: string; timeoutMs?: number }): PostgresStore;
export const postgresSchema: string;

export class ThrottlCapacityError extends Error {}
export class ThrottlConfigurationError extends Error {}
export class ThrottlStoreError extends Error { cause?: unknown }

export default function throttl(options: ThrottlOptions): ThrottlInstance;
