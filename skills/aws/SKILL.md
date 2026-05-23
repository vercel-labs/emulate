---
name: aws
description: Emulated AWS cloud services (S3, SQS, SNS, EventBridge, API Gateway v2, DynamoDB, CloudWatch Logs, Secrets Manager, SSM Parameter Store, KMS, Lambda, IAM, STS) for local development, testing, and native Vercel preview functions. Use when the user needs to interact with AWS API endpoints locally, test S3 bucket and object operations, emulate SQS queues and messages, test SNS topics and subscriptions, test EventBridge buses/rules/events, test API Gateway v2 HTTP APIs and Lambda proxy routes, test DynamoDB tables and items, test CloudWatch log groups and log events, test Secrets Manager values and rotations, test SSM Parameter Store values and paths, test KMS keys/aliases/encrypt/decrypt/data keys, test Lambda function control-plane APIs, invoke stubs, and local Node.js handlers, manage IAM users/roles/access keys, test STS assume role, scaffold AWS through npx emulate vercel init, or work without hitting real AWS APIs. Triggers include "AWS emulator", "emulate AWS", "mock S3", "local SQS", "local SNS", "local EventBridge", "local API Gateway", "local DynamoDB", "local CloudWatch Logs", "local Secrets Manager", "local SSM", "local Parameter Store", "local KMS", "test KMS", "local Lambda", "test Lambda", "test IAM", "emulate S3", "AWS locally", "STS assume role", or any task requiring local AWS service emulation.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# AWS Emulator

S3, SQS, SNS, EventBridge, API Gateway v2, DynamoDB, CloudWatch Logs, Secrets Manager, SSM Parameter Store, KMS, Lambda, IAM, and STS emulation with AWS SDK-compatible S3 paths, AWS JSON RPC endpoints for SQS, EventBridge, DynamoDB, CloudWatch Logs, Secrets Manager, SSM, and KMS, REST JSON endpoints for API Gateway v2 and Lambda, and AWS Query endpoints for SNS/SQS/IAM/STS. All state is in-memory. Query and REST XML operations return AWS-compatible XML. The native Go runtime is verified against current AWS SDK v3 clients for SQS, SNS, EventBridge, API Gateway v2, DynamoDB, CloudWatch Logs, Secrets Manager, SSM, KMS, Lambda, IAM, and STS; SQS, EventBridge, DynamoDB, CloudWatch Logs, Secrets Manager, SSM, and KMS use JSON target requests, API Gateway v2 and Lambda use REST JSON, and SNS/IAM/STS use AWS Query XML.

## Vercel Preview

To expose the native AWS emulator in a Vercel preview without separate infrastructure, scaffold the Go Function route:

```bash
npx emulate vercel init --service aws
```

The generated route serves AWS at `/emulate/aws/*`. State uses warm memory by default: cold starts reset to a fresh store, warm invocations reuse mutations, and concurrent function instances can diverge.

## Start

```bash
# AWS only
npx emulate --service aws

# Enable local Node.js Lambda ZipFile execution
npx emulate --service aws --allow-local-lambda

# Default port (when run alone)
# http://localhost:4000
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const aws = await createEmulator({ service: 'aws', port: 4006 })
// aws.url === 'http://localhost:4006'
```

## Auth

Pass tokens as `Authorization: Bearer <token>`. Scoped permissions use `s3:*`, `sqs:*`, `sns:*`, `events:*`, `apigatewayv2:*`, `execute-api:*`, `dynamodb:*`, `logs:*`, `secretsmanager:*`, `ssm:*`, `kms:*`, `lambda:*`, `iam:*`, `sts:*` patterns.

```bash
curl http://localhost:4000/ \
  -H "Authorization: Bearer test_token_admin"
```

## Pointing Your App at the Emulator

### Environment Variable

```bash
AWS_EMULATOR_URL=http://localhost:4000
```

### AWS SDK v3

```typescript
import { S3Client } from '@aws-sdk/client-s3'

const s3 = new S3Client({
  endpoint: process.env.AWS_EMULATOR_URL,
  region: 'us-east-1',
  credentials: {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  },
  forcePathStyle: true,
})
```

```typescript
import { SQSClient } from '@aws-sdk/client-sqs'

const sqs = new SQSClient({
  endpoint: `${process.env.AWS_EMULATOR_URL}/sqs`,
  region: 'us-east-1',
  credentials: {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  },
})
```

The native Go runtime accepts the SQS SDK client's `X-Amz-Target: AmazonSQS.<Action>` JSON requests to `/sqs` and returns JSON responses. Manual curl calls can use the AWS Query form examples below.

```typescript
import { SNSClient } from '@aws-sdk/client-sns'

const sns = new SNSClient({
  endpoint: `${process.env.AWS_EMULATOR_URL}/sns`,
  region: 'us-east-1',
  credentials: {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  },
})
```

The native Go runtime accepts the SNS SDK client's AWS Query requests to `/sns` and can deliver published notifications to SQS subscriptions.

```typescript
import { EventBridgeClient } from '@aws-sdk/client-eventbridge'

const eventbridge = new EventBridgeClient({
  endpoint: `${process.env.AWS_EMULATOR_URL}/events`,
  region: 'us-east-1',
  credentials: {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  },
})
```

The native Go runtime accepts the EventBridge SDK client's `X-Amz-Target: AWSEvents.<Action>` JSON requests to `/events` and can deliver matching events to SQS queues, SNS topics, and Lambda functions. Lambda targets create CloudWatch Logs entries; zipped Node.js handlers run only when `npx emulate` is started with `--allow-local-lambda` and the EventBridge request uses a direct localhost endpoint signed by a known AWS access key.

```typescript
import { ApiGatewayV2Client } from '@aws-sdk/client-apigatewayv2'

const apigatewayv2 = new ApiGatewayV2Client({
  endpoint: `${process.env.AWS_EMULATOR_URL}/apigatewayv2`,
  region: 'us-east-1',
  credentials: {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  },
})
```

The native Go runtime accepts the API Gateway v2 SDK client's REST JSON requests to `/apigatewayv2/v2/apis`. Created HTTP APIs return local invoke URLs such as `${process.env.AWS_EMULATOR_URL}/_aws/apigatewayv2/<api-id>` for Lambda proxy route testing with payload format version `2.0`.

```typescript
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'

const dynamodb = new DynamoDBClient({
  endpoint: `${process.env.AWS_EMULATOR_URL}/dynamodb`,
  region: 'us-east-1',
  credentials: {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  },
})
```

The native Go runtime accepts the DynamoDB SDK client's `X-Amz-Target: DynamoDB_20120810.<Action>` JSON requests to `/dynamodb` and returns JSON responses.

```typescript
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs'

const cloudWatchLogs = new CloudWatchLogsClient({
  endpoint: `${process.env.AWS_EMULATOR_URL}/logs`,
  region: 'us-east-1',
  credentials: {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  },
})
```

The native Go runtime accepts the CloudWatch Logs SDK client's `X-Amz-Target: Logs_20140328.<Action>` JSON requests to `/logs` and returns JSON responses.

```typescript
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager'

const secretsManager = new SecretsManagerClient({
  endpoint: `${process.env.AWS_EMULATOR_URL}/secretsmanager`,
  region: 'us-east-1',
  credentials: {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  },
})
```

The native Go runtime accepts the Secrets Manager SDK client's `X-Amz-Target: secretsmanager.<Action>` JSON requests to `/secretsmanager` and returns JSON responses.

```typescript
import { SSMClient } from '@aws-sdk/client-ssm'

const ssm = new SSMClient({
  endpoint: `${process.env.AWS_EMULATOR_URL}/ssm`,
  region: 'us-east-1',
  credentials: {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  },
})
```

The native Go runtime accepts the SSM SDK client's `X-Amz-Target: AmazonSSM.<Action>` JSON requests to `/ssm` and returns JSON responses.

```typescript
import { KMSClient } from '@aws-sdk/client-kms'

const kms = new KMSClient({
  endpoint: `${process.env.AWS_EMULATOR_URL}/kms`,
  region: 'us-east-1',
  credentials: {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  },
})
```

The native Go runtime accepts the KMS SDK client's `X-Amz-Target: TrentService.<Action>` JSON requests to `/kms` and returns JSON responses.

```typescript
import { IAMClient } from '@aws-sdk/client-iam'

const iam = new IAMClient({
  endpoint: `${process.env.AWS_EMULATOR_URL}/iam`,
  region: 'us-east-1',
  credentials: {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  },
})
```

```typescript
import { STSClient } from '@aws-sdk/client-sts'

const sts = new STSClient({
  endpoint: `${process.env.AWS_EMULATOR_URL}/sts`,
  region: 'us-east-1',
  credentials: {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  },
})
```

## Seed Config

```yaml
aws:
  region: us-east-1
  s3:
    buckets:
      - name: my-app-bucket
      - name: my-app-uploads
        region: eu-west-1
  sqs:
    queues:
      - name: my-app-events
      - name: my-app-dlq
        visibility_timeout: 60
      - name: my-app-orders.fifo
        fifo: true
  secretsmanager:
    secrets:
      - name: my-app/database-url
        description: Local database URL
        secret_string: postgres://localhost:5432/app
        kms_key_id: alias/my-app
        tags:
          env: local
  ssm:
    parameters:
      - name: /my-app/database-url
        type: SecureString
        value: postgres://localhost:5432/app
        key_id: alias/my-app
        tags:
          env: local
  kms:
    keys:
      - description: My app KMS key
        aliases:
          - alias/my-app
  lambda:
    functions:
      - function_name: my-app-handler
        runtime: nodejs22.x
        role: arn:aws:iam::123456789012:role/lambda-execution-role
        handler: index.handler
        invoke_payload: '{"ok":true}'
        # Optional base64 Lambda zip for local Node.js handler execution.
        code_zip_base64: ""
        environment:
          NODE_ENV: local
  iam:
    users:
      - user_name: developer
        create_access_key: true
      - user_name: readonly-user
    roles:
      - role_name: lambda-execution-role
        description: Role for Lambda function execution
        max_session_duration: 7200
        assume_role_policy: '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
```

Default seed (always created): S3 bucket `emulate-default`, SQS queue `emulate-default-queue`, EventBridge event bus `default`, and IAM user `admin` with access key pair (`AKIAIOSFODNN7EXAMPLE` / `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`).

## API Endpoints

### S3

S3 routes use root paths matching the real AWS S3 wire format. Legacy `/s3/` prefixed paths are also supported.

```bash
# List all buckets
curl http://localhost:4000/ \
  -H "Authorization: Bearer $TOKEN"

# Create bucket
curl -X PUT http://localhost:4000/my-bucket \
  -H "Authorization: Bearer $TOKEN"

# Delete bucket (must be empty)
curl -X DELETE http://localhost:4000/my-bucket \
  -H "Authorization: Bearer $TOKEN"

# Head bucket (check existence, get region)
curl -I http://localhost:4000/my-bucket \
  -H "Authorization: Bearer $TOKEN"

# Get bucket location
curl "http://localhost:4000/my-bucket?location" \
  -H "Authorization: Bearer $TOKEN"

# List objects (with prefix, delimiter, pagination)
curl "http://localhost:4000/my-bucket?prefix=uploads/&delimiter=/&max-keys=100" \
  -H "Authorization: Bearer $TOKEN"

# Put object
curl -X PUT http://localhost:4000/my-bucket/path/to/file.txt \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: text/plain" \
  -H "x-amz-meta-author: test" \
  --data-binary "file contents"

# Get object
curl http://localhost:4000/my-bucket/path/to/file.txt \
  -H "Authorization: Bearer $TOKEN"

# Get object byte range
curl http://localhost:4000/my-bucket/path/to/file.txt \
  -H "Authorization: Bearer $TOKEN" \
  -H "Range: bytes=0-99"

# Conditional object read
curl http://localhost:4000/my-bucket/path/to/file.txt \
  -H "Authorization: Bearer $TOKEN" \
  -H 'If-None-Match: "<etag>"'

# Head object (metadata only)
curl -I http://localhost:4000/my-bucket/path/to/file.txt \
  -H "Authorization: Bearer $TOKEN"

# Delete object
curl -X DELETE http://localhost:4000/my-bucket/path/to/file.txt \
  -H "Authorization: Bearer $TOKEN"

# Copy object
curl -X PUT http://localhost:4000/dest-bucket/copy.txt \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-amz-copy-source: /source-bucket/original.txt"
```

### SQS

Manual SQS calls can use AWS Query over `POST /sqs/` with `Action` as a form-urlencoded parameter. In the native Go runtime, the same operations also work through `@aws-sdk/client-sqs` with endpoint `${AWS_EMULATOR_URL}/sqs`; SDK responses are JSON. Supported operations include queue create/list/url/attributes, message send/receive/delete/purge, batch send/delete, visibility changes, and queue tags.

```bash
# Create queue
curl -X POST http://localhost:4000/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "Action=CreateQueue&QueueName=my-queue"

# Create queue with attributes
curl -X POST http://localhost:4000/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "Action=CreateQueue&QueueName=my-queue&Attribute.1.Name=VisibilityTimeout&Attribute.1.Value=30"

# List queues
curl -X POST http://localhost:4000/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=ListQueues"

# List queues with prefix filter
curl -X POST http://localhost:4000/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=ListQueues&QueueNamePrefix=my-"

# Get queue URL
curl -X POST http://localhost:4000/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=GetQueueUrl&QueueName=my-queue"

# Get queue attributes
curl -X POST http://localhost:4000/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=GetQueueAttributes&QueueUrl=<queue_url>"

# Set queue attributes
curl -X POST http://localhost:4000/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=SetQueueAttributes&QueueUrl=<queue_url>&Attribute.1.Name=VisibilityTimeout&Attribute.1.Value=45"

# Send message
curl -X POST http://localhost:4000/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=SendMessage&QueueUrl=<queue_url>&MessageBody=Hello+World"

# Send message with attributes
curl -X POST http://localhost:4000/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=SendMessage&QueueUrl=<queue_url>&MessageBody=Hello&MessageAttribute.1.Name=type&MessageAttribute.1.Value.DataType=String&MessageAttribute.1.Value.StringValue=greeting"

# Send message batch
curl -X POST http://localhost:4000/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=SendMessageBatch&QueueUrl=<queue_url>&SendMessageBatchRequestEntry.1.Id=one&SendMessageBatchRequestEntry.1.MessageBody=Hello&SendMessageBatchRequestEntry.2.Id=two&SendMessageBatchRequestEntry.2.MessageBody=World"

# Receive messages
curl -X POST http://localhost:4000/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=ReceiveMessage&QueueUrl=<queue_url>&MaxNumberOfMessages=5"

# Change message visibility
curl -X POST http://localhost:4000/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=ChangeMessageVisibility&QueueUrl=<queue_url>&ReceiptHandle=<receipt_handle>&VisibilityTimeout=0"

# Delete message
curl -X POST http://localhost:4000/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=DeleteMessage&QueueUrl=<queue_url>&ReceiptHandle=<receipt_handle>"

# Delete message batch
curl -X POST http://localhost:4000/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=DeleteMessageBatch&QueueUrl=<queue_url>&DeleteMessageBatchRequestEntry.1.Id=one&DeleteMessageBatchRequestEntry.1.ReceiptHandle=<receipt_handle>"

# Tag queue and list tags
curl -X POST http://localhost:4000/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=TagQueue&QueueUrl=<queue_url>&Tag.1.Key=env&Tag.1.Value=test"

curl -X POST http://localhost:4000/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=ListQueueTags&QueueUrl=<queue_url>"

# Purge queue
curl -X POST http://localhost:4000/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=PurgeQueue&QueueUrl=<queue_url>"

# Delete queue
curl -X POST http://localhost:4000/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=DeleteQueue&QueueUrl=<queue_url>"
```

### API Gateway v2

In the native Go runtime, `@aws-sdk/client-apigatewayv2` can use endpoint `${AWS_EMULATOR_URL}/apigatewayv2`. SDK responses are JSON. `CreateApi` returns an `ApiEndpoint` such as `${AWS_EMULATOR_URL}/_aws/apigatewayv2/<api-id>` for local HTTP API route invokes backed by Lambda proxy integrations using payload format version `2.0`. Local Node.js Lambda handlers run only when `npx emulate` is started with `--allow-local-lambda` and the route invoke uses a direct localhost endpoint signed by a known AWS access key; otherwise the Lambda deterministic stub payload path is used.

- `CreateApi`, `GetApi`, `GetApis`, `DeleteApi`
- `CreateIntegration`, `GetIntegration`, `GetIntegrations`, `DeleteIntegration` for `AWS_PROXY` Lambda integrations with payload format version `2.0`
- `CreateRoute`, `GetRoute`, `GetRoutes`, `DeleteRoute` for exact HTTP routes, path parameter routes, `ANY` routes, greedy proxy routes, and `$default`
- `CreateStage`, `GetStage`, `GetStages`, `DeleteStage` for local stages, including `$default`
- Local route invokes under `/_aws/apigatewayv2/<api-id>/...`

### DynamoDB

In the native Go runtime, `@aws-sdk/client-dynamodb` can use endpoint `${AWS_EMULATOR_URL}/dynamodb`. SDK responses are JSON.

- `CreateTable`, `DescribeTable`, `ListTables`, `UpdateTable`, `DeleteTable`
- `PutItem`, `GetItem`, `DeleteItem`, `Scan`, `Query`
- `BatchGetItem`, `BatchWriteItem`
- `TagResource`, `UntagResource`, `ListTagsOfResource`

### SNS

In the native Go runtime, `@aws-sdk/client-sns` can use endpoint `${AWS_EMULATOR_URL}/sns`. Manual SNS calls can use AWS Query over `POST /sns/` with `Action` as a form-urlencoded parameter.

- `CreateTopic`, `DeleteTopic`, `ListTopics`, `GetTopicAttributes`, `SetTopicAttributes`
- `Subscribe`, `Unsubscribe`, `ListSubscriptions`, `ListSubscriptionsByTopic`, `ConfirmSubscription`
- `Publish` with SQS subscription delivery
- `TagResource`, `UntagResource`, `ListTagsForResource`
- `AddPermission`, `RemovePermission`

### EventBridge

In the native Go runtime, `@aws-sdk/client-eventbridge` can use endpoint `${AWS_EMULATOR_URL}/events`. SDK responses are JSON. Matching events can deliver to SQS, SNS, and Lambda targets. Lambda targets create CloudWatch Logs entries; zipped Node.js handlers run only when `npx emulate` is started with `--allow-local-lambda` and the EventBridge request uses a direct localhost endpoint signed by a known AWS access key.

- `CreateEventBus`, `DeleteEventBus`, `ListEventBuses`
- `PutRule`, `DescribeRule`, `ListRules`, `DeleteRule`, `EnableRule`, `DisableRule`
- `PutTargets`, `ListTargetsByRule`, `RemoveTargets`
- `PutEvents` with SQS, SNS, and Lambda target delivery
- `TagResource`, `UntagResource`, `ListTagsForResource`

### CloudWatch Logs

In the native Go runtime, `@aws-sdk/client-cloudwatch-logs` can use endpoint `${AWS_EMULATOR_URL}/logs`. SDK responses are JSON.

- `CreateLogGroup`, `DeleteLogGroup`, `DescribeLogGroups`
- `CreateLogStream`, `DeleteLogStream`, `DescribeLogStreams`
- `PutLogEvents`, `GetLogEvents`, `FilterLogEvents`
- `PutRetentionPolicy`, `DeleteRetentionPolicy`
- `TagResource`, `UntagResource`, `ListTagsForResource`

### Secrets Manager

In the native Go runtime, `@aws-sdk/client-secrets-manager` can use endpoint `${AWS_EMULATOR_URL}/secretsmanager`. SDK responses are JSON.

- `CreateSecret`, `GetSecretValue`, `PutSecretValue`, `UpdateSecret`
- `DeleteSecret`, `RestoreSecret`, `ListSecrets`, `DescribeSecret`
- `TagResource`, `UntagResource`, `ListSecretVersionIds`
- String and binary values, version ids, staging labels, deletion recovery metadata, and KMS key id metadata

### SSM Parameter Store

In the native Go runtime, `@aws-sdk/client-ssm` can use endpoint `${AWS_EMULATOR_URL}/ssm`. SDK responses are JSON.

- `PutParameter`, `GetParameter`, `GetParameters`, `GetParametersByPath`
- `DeleteParameter`, `DeleteParameters`, `DescribeParameters`
- `AddTagsToResource`, `RemoveTagsFromResource`, `ListTagsForResource`
- `String`, `StringList`, and `SecureString` values with local plaintext storage, version history, hierarchical paths, and KMS key id metadata

### KMS

In the native Go runtime, `@aws-sdk/client-kms` can use endpoint `${AWS_EMULATOR_URL}/kms`. SDK responses are JSON.

- `CreateKey`, `DescribeKey`, `ListKeys`
- `CreateAlias`, `ListAliases`
- `Encrypt`, `Decrypt`, `GenerateDataKey`
- `GenerateDataKey` accepts `NumberOfBytes` from 1 to 1024.
- Local reversible ciphertext blobs for test flows. This is not real cryptography.
- S3 `PutObject` and `HeadObject` preserve SSE-KMS metadata headers for local reference tests.


### Lambda

In the native Go runtime, `@aws-sdk/client-lambda` v3 can use endpoint `${AWS_EMULATOR_URL}` directly. Lambda uses AWS REST JSON paths such as `/2015-03-31/functions` and returns JSON responses. The control plane works without Docker. Valid inline `ZipFile` packages for `nodejs*` runtimes run locally with the installed `node` executable when `npx emulate` is started with `--allow-local-lambda` and the invoke request uses a direct localhost endpoint (`localhost`, `127.0.0.1`, or `::1`) signed by a known AWS access key. Custom proxy, tunnel, and portless hosts keep the deterministic stub response path.

Supported Lambda operations include function create/get/config/list/delete, configuration and code updates, request-response `Invoke` for zipped Node.js handlers when local Lambda execution is enabled, stub `Invoke` through `invoke_payload`, versions, aliases, tags, and stored resource policy statements. Creating or invoking a function creates local CloudWatch Logs metadata under `/aws/lambda/<function-name>`, and local Node.js console output is written there. Seed functions with `lambda.functions[].invoke_payload` for deterministic stubs or `lambda.functions[].code_zip_base64` for a base64 Lambda zip used by the local Node.js runner.

```bash
# List Lambda functions
curl http://localhost:4000/2015-03-31/functions \
  -H "Authorization: Bearer $TOKEN"
```

### IAM

Manual IAM calls can use AWS Query over `POST /iam/` with `Action` as a form-urlencoded parameter. In the native Go runtime, the same operations also work through `@aws-sdk/client-iam` with endpoint `${AWS_EMULATOR_URL}/iam`. Supported IAM operations include users, access keys, roles, inline user/role policies, managed policy storage, and user/role managed policy attachments for local policies and AWS managed policy ARNs. Delete users and roles after deleting inline policies and detaching managed policies.

```bash
# Create user
curl -X POST http://localhost:4000/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=CreateUser&UserName=new-user"

# Get user
curl -X POST http://localhost:4000/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=GetUser&UserName=new-user"

# List users
curl -X POST http://localhost:4000/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=ListUsers"

# Delete user
curl -X POST http://localhost:4000/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=DeleteUser&UserName=new-user"

# Create access key
curl -X POST http://localhost:4000/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=CreateAccessKey&UserName=developer"

# List access keys
curl -X POST http://localhost:4000/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=ListAccessKeys&UserName=developer"

# Delete access key
curl -X POST http://localhost:4000/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=DeleteAccessKey&UserName=developer&AccessKeyId=AKIA..."

# Create role
curl -X POST http://localhost:4000/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=CreateRole&RoleName=my-role&AssumeRolePolicyDocument={}"

# Get role
curl -X POST http://localhost:4000/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=GetRole&RoleName=my-role"

# List roles
curl -X POST http://localhost:4000/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=ListRoles"

# Delete role
curl -X POST http://localhost:4000/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=DeleteRole&RoleName=my-role"

# Put and get an inline user policy
curl -X POST http://localhost:4000/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=PutUserPolicy&UserName=new-user&PolicyName=inline-policy&PolicyDocument={}"

curl -X POST http://localhost:4000/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=GetUserPolicy&UserName=new-user&PolicyName=inline-policy"

# Create and attach a managed policy
curl -X POST http://localhost:4000/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=CreatePolicy&PolicyName=my-policy&PolicyDocument={}"

curl -X POST http://localhost:4000/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=AttachRolePolicy&RoleName=my-role&PolicyArn=arn:aws:iam::123456789012:policy/my-policy"
```

### STS

Manual STS calls can use AWS Query over `POST /sts/` with `Action` as a form-urlencoded parameter. In the native Go runtime, the same operations also work through `@aws-sdk/client-sts` with endpoint `${AWS_EMULATOR_URL}/sts`. Roles default to 3600 second sessions, `MaxSessionDuration` can raise that to 43200 seconds, and role chaining is capped at 3600 seconds.

```bash
# Get caller identity
curl -X POST http://localhost:4000/sts/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=GetCallerIdentity"

# Assume role. DurationSeconds must be from 900 seconds up to the role MaxSessionDuration.
curl -X POST http://localhost:4000/sts/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=AssumeRole&RoleArn=arn:aws:iam::123456789012:role/my-role&RoleSessionName=my-session&DurationSeconds=1800&Tags.member.1.Key=env&Tags.member.1.Value=test"
```

### Inspector

```bash
# HTML dashboard (shows S3, SQS, IAM, Logs, Secrets, SSM, KMS, and Lambda state)
curl http://localhost:4000/_inspector?tab=s3
curl http://localhost:4000/_inspector?tab=sqs
curl http://localhost:4000/_inspector?tab=iam
curl http://localhost:4000/_inspector?tab=logs
curl http://localhost:4000/_inspector?tab=secretsmanager
curl http://localhost:4000/_inspector?tab=ssm
curl http://localhost:4000/_inspector?tab=kms
```

## Common Patterns

### Upload and Retrieve an Object

```bash
TOKEN="test_token_admin"
BASE="http://localhost:4000"

# Create bucket
curl -X PUT $BASE/my-data \
  -H "Authorization: Bearer $TOKEN"

# Upload file
curl -X PUT $BASE/my-data/config.json \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary '{"key": "value"}'

# Download file
curl $BASE/my-data/config.json \
  -H "Authorization: Bearer $TOKEN"
```

### Send and Receive SQS Messages

```bash
TOKEN="test_token_admin"
BASE="http://localhost:4000"

# Get queue URL
QUEUE_URL=$(curl -s -X POST $BASE/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=GetQueueUrl&QueueName=emulate-default-queue" | grep -oP '<QueueUrl>\K[^<]+')

# Send message
curl -X POST $BASE/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=SendMessage&QueueUrl=$QUEUE_URL&MessageBody=Hello+from+emulate"

# Receive messages
curl -X POST $BASE/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=ReceiveMessage&QueueUrl=$QUEUE_URL&MaxNumberOfMessages=1"
```

### Create IAM User with Access Key

```bash
TOKEN="test_token_admin"
BASE="http://localhost:4000"

# Create user
curl -X POST $BASE/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=CreateUser&UserName=ci-user"

# Generate access key
curl -X POST $BASE/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=CreateAccessKey&UserName=ci-user"
```
