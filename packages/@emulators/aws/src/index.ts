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

export interface APIGatewayV2API extends CompatEntity {
  [key: string]: unknown;
}
export interface APIGatewayV2Integration extends CompatEntity {
  [key: string]: unknown;
}
export interface APIGatewayV2Route extends CompatEntity {
  [key: string]: unknown;
}
export interface APIGatewayV2Stage extends CompatEntity {
  [key: string]: unknown;
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
export interface LogGroup extends CompatEntity {
  [key: string]: unknown;
}
export interface LogStream extends CompatEntity {
  [key: string]: unknown;
}
export interface LogEvent extends CompatEntity {
  [key: string]: unknown;
}
export interface Secret extends CompatEntity {
  [key: string]: unknown;
}
export interface SecretVersion extends CompatEntity {
  [key: string]: unknown;
}
export interface SSMParameter extends CompatEntity {
  [key: string]: unknown;
}
export interface SSMParameterVersion extends CompatEntity {
  [key: string]: unknown;
}
export interface KMSKey extends CompatEntity {
  [key: string]: unknown;
}
export interface KMSAlias extends CompatEntity {
  [key: string]: unknown;
}
export interface LambdaFunction extends CompatEntity {
  [key: string]: unknown;
}
export interface LambdaVersion extends CompatEntity {
  [key: string]: unknown;
}
export interface LambdaAlias extends CompatEntity {
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
  apiGatewayV2Apis: CompatCollection<APIGatewayV2API>;
  apiGatewayV2Integrations: CompatCollection<APIGatewayV2Integration>;
  apiGatewayV2Routes: CompatCollection<APIGatewayV2Route>;
  apiGatewayV2Stages: CompatCollection<APIGatewayV2Stage>;
  s3Buckets: CompatCollection<S3Bucket>;
  s3Objects: CompatCollection<S3Object>;
  sqsQueues: CompatCollection<SqsQueue>;
  sqsMessages: CompatCollection<SqsMessage>;
  logGroups: CompatCollection<LogGroup>;
  logStreams: CompatCollection<LogStream>;
  logEvents: CompatCollection<LogEvent>;
  secrets: CompatCollection<Secret>;
  secretVersions: CompatCollection<SecretVersion>;
  ssmParameters: CompatCollection<SSMParameter>;
  ssmParameterVersions: CompatCollection<SSMParameterVersion>;
  kmsKeys: CompatCollection<KMSKey>;
  kmsAliases: CompatCollection<KMSAlias>;
  lambdaFunctions: CompatCollection<LambdaFunction>;
  lambdaVersions: CompatCollection<LambdaVersion>;
  lambdaAliases: CompatCollection<LambdaAlias>;
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
    apiGatewayV2Apis: compatCollection<APIGatewayV2API>(store, "aws.apigatewayv2_apis", [
      "account_id",
      "region",
      "api_id",
      "name",
    ]),
    apiGatewayV2Integrations: compatCollection<APIGatewayV2Integration>(store, "aws.apigatewayv2_integrations", [
      "account_id",
      "region",
      "api_id",
      "integration_id",
    ]),
    apiGatewayV2Routes: compatCollection<APIGatewayV2Route>(store, "aws.apigatewayv2_routes", [
      "account_id",
      "region",
      "api_id",
      "route_id",
      "route_key",
    ]),
    apiGatewayV2Stages: compatCollection<APIGatewayV2Stage>(store, "aws.apigatewayv2_stages", [
      "account_id",
      "region",
      "api_id",
      "stage_name",
    ]),
    s3Buckets: compatCollection<S3Bucket>(store, "aws.s3_buckets", ["bucket_name"]),
    s3Objects: compatCollection<S3Object>(store, "aws.s3_objects", ["key", "bucket_name"]),
    sqsQueues: compatCollection<SqsQueue>(store, "aws.sqs_queues", ["queue_name", "queue_url"]),
    sqsMessages: compatCollection<SqsMessage>(store, "aws.sqs_messages", ["message_id", "queue_name"]),
    logGroups: compatCollection<LogGroup>(store, "aws.log_groups", ["account_id", "region", "log_group_name", "arn"]),
    logStreams: compatCollection<LogStream>(store, "aws.log_streams", [
      "account_id",
      "region",
      "log_group_name",
      "log_stream_name",
      "arn",
    ]),
    logEvents: compatCollection<LogEvent>(store, "aws.log_events", [
      "account_id",
      "region",
      "log_group_name",
      "log_stream_name",
      "event_id",
    ]),
    secrets: compatCollection<Secret>(store, "aws.secretsmanager_secrets", ["account_id", "region", "name", "arn"]),
    secretVersions: compatCollection<SecretVersion>(store, "aws.secretsmanager_versions", [
      "account_id",
      "region",
      "secret_arn",
      "secret_name",
      "version_id",
    ]),
    ssmParameters: compatCollection<SSMParameter>(store, "aws.ssm_parameters", [
      "account_id",
      "region",
      "name",
      "arn",
      "path",
    ]),
    ssmParameterVersions: compatCollection<SSMParameterVersion>(store, "aws.ssm_parameter_versions", [
      "account_id",
      "region",
      "name",
      "version",
    ]),
    kmsKeys: compatCollection<KMSKey>(store, "aws.kms_keys", ["account_id", "region", "key_id", "arn"]),
    kmsAliases: compatCollection<KMSAlias>(store, "aws.kms_aliases", [
      "account_id",
      "region",
      "alias_name",
      "alias_arn",
      "target_key_id",
    ]),
    lambdaFunctions: compatCollection<LambdaFunction>(store, "aws.lambda_functions", [
      "account_id",
      "region",
      "function_name",
      "arn",
    ]),
    lambdaVersions: compatCollection<LambdaVersion>(store, "aws.lambda_versions", [
      "account_id",
      "region",
      "function_name",
      "version",
      "arn",
    ]),
    lambdaAliases: compatCollection<LambdaAlias>(store, "aws.lambda_aliases", [
      "account_id",
      "region",
      "function_name",
      "name",
      "arn",
    ]),
    iamUsers: compatCollection<IamUser>(store, "aws.iam_users", ["user_name", "user_id"]),
    iamRoles: compatCollection<IamRole>(store, "aws.iam_roles", ["role_name", "role_id"]),
  };
}

// Legacy public entity type augmentations.
export interface APIGatewayV2API extends CompatEntity {
  account_id: string;
  region: string;
  api_id: string;
  name: string;
  protocol_type: "HTTP" | "WEBSOCKET";
  api_endpoint: string;
  api_key_selection_expression: string;
  route_selection_expression: string;
  description: string;
  cors_configuration: Record<string, unknown>;
  created_date: string;
  tags: Record<string, string>;
}

export interface APIGatewayV2Integration extends CompatEntity {
  account_id: string;
  region: string;
  api_id: string;
  integration_id: string;
  integration_type: string;
  integration_uri: string;
  integration_method: string;
  payload_format_version: string;
  timeout_in_millis: number;
  description: string;
}

export interface APIGatewayV2Route extends CompatEntity {
  account_id: string;
  region: string;
  api_id: string;
  route_id: string;
  route_key: string;
  target: string;
  authorization_type: string;
}

export interface APIGatewayV2Stage extends CompatEntity {
  account_id: string;
  region: string;
  api_id: string;
  stage_name: string;
  auto_deploy: boolean;
  deployment_id: string;
  description: string;
  stage_variables: Record<string, string>;
  created_date: string;
  last_updated_date: string;
}

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
  sse_algorithm: string;
  sse_kms_key_id: string;
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

export interface LogGroup extends CompatEntity {
  account_id: string;
  region: string;
  log_group_name: string;
  arn: string;
  creation_time: number;
  retention_in_days: number;
  kms_key_id: string;
  tags: Record<string, string>;
}

export interface LogStream extends CompatEntity {
  account_id: string;
  region: string;
  log_group_name: string;
  log_stream_name: string;
  arn: string;
  creation_time: number;
  first_event_timestamp: number;
  last_event_timestamp: number;
  last_ingestion_time: number;
  upload_sequence_token: string;
  stored_bytes: number;
}

export interface LogEvent extends CompatEntity {
  account_id: string;
  region: string;
  log_group_name: string;
  log_stream_name: string;
  event_id: string;
  timestamp: number;
  message: string;
  ingestion_time: number;
}

export interface Secret extends CompatEntity {
  account_id: string;
  region: string;
  name: string;
  arn: string;
  arn_suffix: string;
  description: string;
  kms_key_id: string;
  created_date: number;
  last_changed_date: number;
  last_accessed_date: number;
  deleted_date: number;
  recovery_window_days: number;
  force_deleted: boolean;
  tags: Record<string, string>;
}

export interface SecretVersion extends CompatEntity {
  account_id: string;
  region: string;
  secret_arn: string;
  secret_name: string;
  version_id: string;
  secret_string: string;
  has_secret_string: boolean;
  secret_binary: string;
  has_secret_binary: boolean;
  version_stages: string[];
  created_date: number;
  last_accessed_date: number;
}

export interface SSMParameter extends CompatEntity {
  account_id: string;
  region: string;
  name: string;
  arn: string;
  path: string;
  type: "String" | "StringList" | "SecureString";
  value: string;
  version: number;
  description: string;
  key_id: string;
  tier: string;
  data_type: string;
  last_modified_date: number;
  last_accessed_date: number;
  tags: Record<string, string>;
  allowed_pattern: string;
  policies: string[];
  selector_labels: string[];
  source_result: string;
  has_secure_material: boolean;
}

export interface SSMParameterVersion extends CompatEntity {
  account_id: string;
  region: string;
  name: string;
  arn: string;
  version: number;
  type: "String" | "StringList" | "SecureString";
  value: string;
  description: string;
  key_id: string;
  tier: string;
  data_type: string;
  last_modified_date: number;
  has_secure_material: boolean;
}

export interface KMSKey extends CompatEntity {
  account_id: string;
  region: string;
  key_id: string;
  arn: string;
  description: string;
  enabled: boolean;
  key_state: string;
  key_usage: string;
  key_spec: string;
  customer_master_key_spec: string;
  origin: string;
  key_manager: string;
  creation_date: number;
  deletion_date: number;
  multi_region: boolean;
  tags: Record<string, string>;
}

export interface KMSAlias extends CompatEntity {
  account_id: string;
  region: string;
  alias_name: string;
  alias_arn: string;
  target_key_id: string;
  creation_date: number;
  last_updated_date: number;
}

export interface LambdaFunction extends CompatEntity {
  account_id: string;
  region: string;
  function_name: string;
  arn: string;
  runtime: string;
  role: string;
  handler: string;
  description: string;
  timeout: number;
  memory_size: number;
  package_type: string;
  architectures: string[];
  code_size: number;
  code_sha256: string;
  code_zip_base64: string;
  version: string;
  revision_id: string;
  last_modified: string;
  state: string;
  state_reason: string;
  state_reason_code: string;
  last_update_status: string;
  environment: Record<string, string>;
  tags: Record<string, string>;
  policy_statements: Array<Record<string, unknown>>;
  invoke_payload: string;
  log_group_name: string;
  tracing_mode: string;
  ephemeral_storage: number;
  kms_key_arn: string;
  dead_letter_target: string;
  snap_start_apply_on: string;
}

export interface LambdaVersion extends LambdaFunction {
  source_revision_id: string;
}

export interface LambdaAlias extends CompatEntity {
  account_id: string;
  region: string;
  function_name: string;
  name: string;
  arn: string;
  function_version: string;
  description: string;
  revision_id: string;
  routing_config: Record<string, unknown>;
  last_modified_time: string;
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
  secretsmanager?: {
    secrets?: Array<{
      name: string;
      description?: string;
      kms_key_id?: string;
      secret_string?: string;
      secret_binary?: string;
      tags?: Record<string, string>;
    }>;
  };
  ssm?: {
    parameters?: Array<{
      name: string;
      type?: "String" | "StringList" | "SecureString";
      value?: string;
      description?: string;
      key_id?: string;
      tier?: string;
      data_type?: string;
      tags?: Record<string, string>;
    }>;
  };
  kms?: {
    keys?: Array<{
      key_id?: string;
      description?: string;
      aliases?: string[];
      enabled?: boolean;
      key_usage?: string;
      key_spec?: string;
      origin?: string;
      tags?: Record<string, string>;
    }>;
  };
  lambda?: {
    functions?: Array<{
      function_name: string;
      runtime?: string;
      role?: string;
      handler?: string;
      description?: string;
      timeout?: number;
      memory_size?: number;
      environment?: Record<string, string>;
      tags?: Record<string, string>;
      invoke_payload?: string;
      code_zip_base64?: string;
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
