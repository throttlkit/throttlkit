export type ThrottlDecision = {
  allowed: boolean; limit: number; remaining: number; resetAt: Date; retryAfterMs: number;
};
export type CheckOptions = { cost?: number; signal?: AbortSignal; timeoutMs?: number };
export type ThrottlStore = {
  supportsCost?: boolean;
  check(key: string, options: ThrottlOptions, request?: CheckOptions): ThrottlDecision | Promise<ThrottlDecision>;
  reset(key: string): boolean | Promise<boolean>;
  cleanup?(): number | Promise<number>;
};
export type DecisionEvent = { key: string; cost: number; algorithm: string; decision: ThrottlDecision; durationMs: number };
export type ErrorEvent = { key: string; cost: number; error: unknown };
export type CommonOptions = {
  maxKeys?: number; maxEvents?: number; clock?: () => number; store?: ThrottlStore; timeoutMs?: number;
  onDecision?: (event: DecisionEvent) => void | Promise<void>;
  onError?: (event: ErrorEvent) => void | Promise<void>;
  onHookError?: (error: unknown) => void | Promise<void>;
};
export type SlidingWindowOptions = CommonOptions & {
  algorithm?: 'sliding-window'; limit: number; windowMs: number; maxSlidingWindowLimit?: number;
};
export type SlidingCounterOptions = CommonOptions & { algorithm: 'sliding-window-counter'; limit: number; windowMs: number };
export type TokenBucketOptions = CommonOptions & {
  algorithm: 'token-bucket'; capacity: number; refillRate: number; refillIntervalMs: number;
};
export type GcraOptions = CommonOptions & { algorithm: 'gcra'; limit: number; windowMs: number; burst?: number };
export type ThrottlOptions = SlidingWindowOptions | SlidingCounterOptions | TokenBucketOptions | GcraOptions;
export type Metrics = { checks: number; allowed: number; denied: number; errors: number; hookErrors: number; durationMs: number; averageDurationMs: number };
export type HeaderMode = 'both' | 'legacy' | 'ratelimit' | false;
export type MiddlewareOptions<Request> = {
  key(request: Request): string | Promise<string>;
  cost?: number | ((request: Request) => number | Promise<number>);
  signal?: (request: Request) => AbortSignal | undefined;
  headers?: HeaderMode;
  onStoreError?: 'allow' | 'deny' | ((error: Error, request: Request) => 'allow' | 'deny' | Promise<'allow' | 'deny'>);
};
export type ExpressResponse = {
  setHeader(name: string, value: string): unknown;
  status(code: number): { json(body: unknown): unknown };
};
export type ThrottlInstance = {
  check(key: string, options?: CheckOptions): Promise<ThrottlDecision>;
  reset(key: string): Promise<boolean>;
  cleanup(): Promise<number>;
  stats(): Metrics;
  store: ThrottlStore;
  middleware<Request>(options: MiddlewareOptions<Request>): (request: Request, response: ExpressResponse, next: (error?: unknown) => void) => Promise<void>;
};
export type MemoryStore = ThrottlStore & { supportsCost: true; cleanup(): number; stats(): { keys: number; events: number; maxKeys: number; maxEvents: number } };
export function memoryStore(options?: { maxKeys?: number; maxEvents?: number; clock?: () => number }): MemoryStore;
export function subjectKey(...parts: string[]): string;
export function rateLimitHeaders(decision: ThrottlDecision, mode?: HeaderMode): Record<string, string>;
export function expressMiddleware<Request>(limiter: ThrottlInstance, options: MiddlewareOptions<Request>): ReturnType<ThrottlInstance['middleware']>;
export type FastifyReply = { header(name: string, value: string): unknown; code(status: number): { send(body: unknown): unknown } };
export function fastifyHook<Request>(limiter: ThrottlInstance, options: MiddlewareOptions<Request>): (request: Request, reply: FastifyReply) => Promise<unknown>;
export type KoaContext = { set(name: string, value: string): void; status: number; body: unknown };
export function koaMiddleware<Context extends KoaContext>(limiter: ThrottlInstance, options: MiddlewareOptions<Context>): (context: Context, next: () => Promise<unknown>) => Promise<void>;
export function fetchHandler<Context extends unknown[]>(limiter: ThrottlInstance, options: MiddlewareOptions<Request>, handler: (request: Request, ...context: Context) => Response | Promise<Response>): (request: Request, ...context: Context) => Promise<Response>;
export type HapiResponse = { code(status: number): HapiResponse; header(name: string, value: string): HapiResponse; takeover(): unknown; isBoom?: boolean };
export type HapiToolkit = { continue: unknown; response(body: unknown): HapiResponse };
export type HapiRequest = { response: HapiResponse };
export function hapiPlugin<Request extends HapiRequest>(limiter: ThrottlInstance, options: MiddlewareOptions<Request>): {
  name: string; version: string; register(server: { ext(event: string, callback: (request: Request, toolkit: HapiToolkit) => unknown): void }): void;
};
export function nestGuard<Request>(limiter: ThrottlInstance, options: MiddlewareOptions<Request> & { exception(status: number, body: unknown): unknown }): {
  canActivate(context: { switchToHttp(): { getRequest(): Request; getResponse(): { header?(name: string, value: string): unknown; setHeader?(name: string, value: string): unknown } } }): Promise<boolean>;
};
export type DynamicPolicy = { id: string; key: string; options: ThrottlOptions };
export function dynamicLimiter<Context>(options: { resolve(context: Context): DynamicPolicy | Promise<DynamicPolicy>; maxPolicies?: number }): {
  check(context: Context, options?: CheckOptions): Promise<ThrottlDecision>;
  cleanup(): Promise<number>;
  stats(): { policies: number; maxPolicies: number; entries: (Metrics & { id: string })[] };
};
export type CompositeDecision = { allowed: boolean; decisions: ThrottlDecision[]; deniedIndex: number | null };
export function composeLimiters<Context>(rules: { limiter: ThrottlInstance; key(context: Context): string | Promise<string>; cost?: number | ((context: Context) => number | Promise<number>) }[]): {
  check(context: Context, options?: CheckOptions): Promise<CompositeDecision>;
};
export function circuitBreakerStore(store: ThrottlStore, options?: { failureThreshold?: number; cooldownMs?: number; clock?: () => number }): ThrottlStore & { stats(): { state: 'closed' | 'open' | 'half-open'; failures: number; openedAt: number | null } };
export type PgQueryResult = { rows: Record<string, unknown>[]; rowCount: number | null };
export type PgConnection = { query(sql: string, values?: unknown[]): Promise<PgQueryResult>; release(error?: Error): void };
export type PgPool = { connect(): Promise<PgConnection>; query(sql: string, values?: unknown[]): Promise<PgQueryResult> };
export type PostgresStore = ThrottlStore & { supportsCost: true; migrate(): Promise<void>; cleanup(): Promise<number> };
export function postgresStore(options: { pool: PgPool; namespace: string; timeoutMs?: number; cleanupBatchSize?: number }): PostgresStore;
export const postgresSchema: string;
export const postgresMigrations: { version: number; name: string; sql: string }[];
export type RedisClient = { eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  evalSha?(sha: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> };
export type IoredisClient = { eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
  evalsha?(sha: string, numKeys: number, ...args: string[]): Promise<unknown> };
export type RedisStoreOptions = { namespace: string; timeoutMs?: number } & (
  { client: RedisClient; clientType?: 'node-redis'; execute?: never } |
  { client: IoredisClient; clientType: 'ioredis'; execute?: never } |
  { execute(script: string, keys: string[], args: string[]): Promise<unknown>; client?: never; clientType?: never }
);
export function redisStore(options: RedisStoreOptions): ThrottlStore & { supportsCost: true; cleanup(): Promise<number> };
export class ThrottlCapacityError extends Error {}
export class ThrottlConfigurationError extends Error {}
export class ThrottlStoreError extends Error { cause?: unknown }
export class ThrottlTimeoutError extends ThrottlStoreError {}
export default function throttl(options: ThrottlOptions): ThrottlInstance;
