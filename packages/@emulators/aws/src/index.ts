export const serviceName = "aws";
export const serviceLabel = "AWS cloud services";
export const runtime = "native-go";

export interface CompatEntity {
  id: number;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export type CompatInsertInput<T extends CompatEntity> = Omit<T, "id" | "created_at" | "updated_at"> & { id?: number };

export interface CompatQueryOptions<T> {
  filter?: (item: T) => boolean;
  sort?: (a: T, b: T) => number;
  page?: number;
  per_page?: number;
}

export interface CompatPaginatedResult<T> {
  items: T[];
  total_count: number;
  page: number;
  per_page: number;
  has_next: boolean;
  has_prev: boolean;
}

export interface CompatCollection<T extends CompatEntity = CompatEntity> {
  readonly fieldNames?: string[];
  insert(data: CompatInsertInput<T>): T;
  get(id: number): T | undefined;
  findBy(field: keyof T, value: T[keyof T] | string | number): T[];
  findOneBy(field: keyof T, value: T[keyof T] | string | number): T | undefined;
  update(id: number, data: Partial<T>): T | undefined;
  delete(id: number): boolean;
  all(): T[];
  query(options?: CompatQueryOptions<T>): CompatPaginatedResult<T>;
  count(filter?: (item: T) => boolean): number;
  clear(): void;
  snapshot(): unknown;
  restore(snapshot: unknown): void;
}

export interface CompatStoreSource {
  collection<T extends CompatEntity>(name: string, indexFields?: string[]): CompatCollection<T>;
}

export interface S3Bucket extends CompatEntity {
  [key: string]: unknown;
}
export interface S3Object extends CompatEntity {
  [key: string]: unknown;
}
export interface SqsQueue extends CompatEntity {
  [key: string]: unknown;
}
export interface SqsMessage extends CompatEntity {
  [key: string]: unknown;
}
export interface IamUser extends CompatEntity {
  [key: string]: unknown;
}
export interface IamRole extends CompatEntity {
  [key: string]: unknown;
}

export interface AwsSeedConfig {
  [key: string]: unknown;
}

export interface AwsStore {
  s3Buckets: CompatCollection<S3Bucket>;
  s3Objects: CompatCollection<S3Object>;
  sqsQueues: CompatCollection<SqsQueue>;
  sqsMessages: CompatCollection<SqsMessage>;
  iamUsers: CompatCollection<IamUser>;
  iamRoles: CompatCollection<IamRole>;
}

function compatCollection<T extends CompatEntity>(
  store: CompatStoreSource,
  name: string,
  indexFields: string[],
): CompatCollection<T> {
  return store.collection<T>(name, indexFields);
}

export function getAwsStore(store: CompatStoreSource): AwsStore {
  return {
    s3Buckets: compatCollection<S3Bucket>(store, "aws.s3_buckets", ["bucket_name"]),
    s3Objects: compatCollection<S3Object>(store, "aws.s3_objects", ["key", "bucket_name"]),
    sqsQueues: compatCollection<SqsQueue>(store, "aws.sqs_queues", ["queue_name", "queue_url"]),
    sqsMessages: compatCollection<SqsMessage>(store, "aws.sqs_messages", ["message_id", "queue_name"]),
    iamUsers: compatCollection<IamUser>(store, "aws.iam_users", ["user_name", "user_id"]),
    iamRoles: compatCollection<IamRole>(store, "aws.iam_roles", ["role_name", "role_id"]),
  };
}

// Legacy public entity type augmentations.
export interface S3Bucket extends CompatEntity {
  bucket_name: string;
  region: string;
  creation_date: string;
  acl: "private" | "public-read" | "public-read-write";
  versioning_enabled: boolean;
}

export interface S3Object extends CompatEntity {
  bucket_name: string;
  key: string;
  body: string;
  content_type: string;
  content_length: number;
  etag: string;
  last_modified: string;
  metadata: Record<string, string>;
  version_id?: string;
}

export interface SqsQueue extends CompatEntity {
  queue_name: string;
  queue_url: string;
  arn: string;
  visibility_timeout: number;
  delay_seconds: number;
  max_message_size: number;
  message_retention_period: number;
  receive_message_wait_time: number;
  fifo: boolean;
}

export interface SqsMessage extends CompatEntity {
  queue_name: string;
  message_id: string;
  receipt_handle: string;
  body: string;
  md5_of_body: string;
  attributes: Record<string, string>;
  message_attributes: Record<string, { DataType: string; StringValue?: string; BinaryValue?: string }>;
  visible_after: number;
  sent_timestamp: number;
  receive_count: number;
}

export interface IamUser extends CompatEntity {
  user_name: string;
  user_id: string;
  arn: string;
  path: string;
  access_keys: Array<{ access_key_id: string; secret_access_key: string; status: "Active" | "Inactive" }>;
}

export interface IamRole extends CompatEntity {
  role_name: string;
  role_id: string;
  arn: string;
  path: string;
  assume_role_policy_document: string;
  description: string;
}

// Legacy public seed config type augmentations.
export interface AwsSeedConfig {
  port?: number;
  region?: string;
  account_id?: string;
  s3?: {
    buckets?: Array<{
      name: string;
      region?: string;
    }>;
  };
  sqs?: {
    queues?: Array<{
      name: string;
      fifo?: boolean;
      visibility_timeout?: number;
    }>;
  };
  iam?: {
    users?: Array<{
      user_name: string;
      path?: string;
      create_access_key?: boolean;
    }>;
    roles?: Array<{
      role_name: string;
      path?: string;
      description?: string;
      assume_role_policy?: string;
    }>;
  };
}
export const service = {
  name: serviceName,
  label: serviceLabel,
  runtime,
} as const;

export const plugin = {
  ...service,
  register(): void {
    return undefined;
  },
  seed(): void {
    return undefined;
  },
} as const;

export const awsPlugin = plugin;

export function seedFromConfig(_store?: unknown, _baseUrl?: string, _config?: AwsSeedConfig): void {
  throw new Error(
    "seedFromConfig is no longer supported by native compatibility facade packages. Pass seed data to createEmulateHandler or createEmulator instead.",
  );
}

export function createAppKeyResolver(): undefined {
  return undefined;
}

export default plugin;
