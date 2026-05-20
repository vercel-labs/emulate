# @emulators/aws

The in-process JavaScript plugin provides S3, SQS, IAM, and STS emulation with AWS SDK-compatible S3 paths and AWS Query endpoints for SQS/IAM/STS. Query and REST XML operations return AWS-compatible XML. DynamoDB is available in the native Go AWS runtime; see the DynamoDB note below.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/aws
```

## Endpoints

### S3

S3 routes use root paths matching the real AWS S3 wire format, so the official AWS SDK works out of the box with `forcePathStyle: true`. Legacy `/s3/` prefixed paths are also supported for backward compatibility.

- `GET /` — list all buckets
- `PUT /:bucket` — create bucket
- `DELETE /:bucket` — delete bucket
- `HEAD /:bucket` — check existence
- `GET /:bucket` — list objects (prefix, delimiter, max-keys, continuation-token, start-after)
- `POST /:bucket` — presigned POST upload (browser-style multipart form with policy validation)
- `PUT /:bucket/:key` — put object (supports copy via `x-amz-copy-source`)
- `GET /:bucket/:key` — get object
- `HEAD /:bucket/:key` — head object
- `DELETE /:bucket/:key` — delete object

### SQS
SQS requests use `POST /sqs/` with an `Action` form parameter.

- `CreateQueue`, `ListQueues`, `GetQueueUrl`, `GetQueueAttributes`
- `SendMessage`, `ReceiveMessage`, `DeleteMessage`
- `PurgeQueue`, `DeleteQueue`

### DynamoDB (native Go runtime)
DynamoDB is currently available through the native Go AWS runtime, not through the in-process JavaScript plugin exported by this package. In that runtime, requests use the `/dynamodb/` endpoint with `X-Amz-Target: DynamoDB_20120810.<Action>` JSON requests.

- `CreateTable`, `DescribeTable`, `ListTables`, `UpdateTable`, `DeleteTable`
- `PutItem`, `GetItem`, `DeleteItem`, `Scan`, `Query`
- `BatchGetItem`, `BatchWriteItem`
- `TagResource`, `UntagResource`, `ListTagsOfResource`

### IAM
IAM requests use `POST /iam/` with an `Action` form parameter.

- `CreateUser`, `GetUser`, `ListUsers`, `DeleteUser`
- `CreateAccessKey`, `ListAccessKeys`, `DeleteAccessKey`
- `CreateRole`, `GetRole`, `ListRoles`, `DeleteRole`

### STS
STS requests use `POST /sts/` with an `Action` form parameter.

- `GetCallerIdentity`, `AssumeRole`

## Auth

Bearer tokens or IAM access key credentials. Default key pair always seeded: `AKIAIOSFODNN7EXAMPLE` / `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`.

## Seed Configuration

```yaml
aws:
  region: us-east-1
  s3:
    buckets:
      - name: my-app-bucket
      - name: my-app-uploads
  sqs:
    queues:
      - name: my-app-events
      - name: my-app-dlq
  iam:
    users:
      - user_name: developer
        create_access_key: true
    roles:
      - role_name: lambda-execution-role
        description: Role for Lambda function execution
```

## Links

- [Full documentation](https://emulate.dev/aws)
- [GitHub](https://github.com/vercel-labs/emulate)
