---
name: aws
description: Emulated AWS cloud services (S3, SQS, Cognito, IAM, STS) for local development and testing. Use when the user needs to interact with AWS API endpoints locally, test S3 bucket and object operations, emulate SQS queues and messages, test Cognito sign-up, sign-in, JWTs, or Identity Pools, manage IAM users/roles/access keys, test STS assume role, or work without hitting real AWS APIs. Triggers include "AWS emulator", "emulate AWS", "mock S3", "local SQS", "test IAM", "emulate S3", "AWS locally", "STS assume role", or any task requiring local AWS service emulation.
allowed-tools: Bash(npx emulate:*), Bash(curl:*)
---

# AWS Emulator

S3, SQS, Cognito, IAM, and STS emulation with AWS SDK-compatible S3 paths. S3 uploads and downloads preserve arbitrary binary payloads, including raw byte lengths and ETags. SQS supports AWS JSON 1.0 and XML Query protocols; IAM and STS use XML Query. All state is in-memory.

## Start

Local listeners bind to `127.0.0.1` by default. For access from containers or other machines, pass `--host 0.0.0.0` to the CLI or `hostname: '0.0.0.0'` to `createEmulator`. Configure `--base-url` or `baseUrl` for advertised URLs reachable by those clients.

```bash
# AWS only
npx emulate --service aws

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

Pass tokens as `Authorization: Bearer <token>`. Scoped permissions use `s3:*`, `sqs:*`, `iam:*`, `sts:*` patterns.

```bash
curl http://localhost:4006/ \
  -H "Authorization: Bearer test_token_admin"
```

## Pointing Your App at the Emulator

### Environment Variable

```bash
AWS_EMULATOR_URL=http://localhost:4006
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
  iam:
    users:
      - user_name: developer
        create_access_key: true
      - user_name: readonly-user
    roles:
      - role_name: lambda-execution-role
        description: Role for Lambda function execution
        assume_role_policy: '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
```

Default seed (always created): S3 bucket `emulate-default`, SQS queue `emulate-default-queue`, IAM user `admin` with access key pair (`AKIAIOSFODNN7EXAMPLE` / `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`).

## API Endpoints

### S3

S3 routes use root paths matching the real AWS S3 wire format. Legacy `/s3/` prefixed paths are also supported.

```bash
# List all buckets
curl http://localhost:4006/ \
  -H "Authorization: Bearer $TOKEN"

# Create bucket
curl -X PUT http://localhost:4006/my-bucket \
  -H "Authorization: Bearer $TOKEN"

# Delete bucket (must be empty)
curl -X DELETE http://localhost:4006/my-bucket \
  -H "Authorization: Bearer $TOKEN"

# Head bucket (check existence, get region)
curl -I http://localhost:4006/my-bucket \
  -H "Authorization: Bearer $TOKEN"

# List objects (with prefix, delimiter, pagination)
curl "http://localhost:4006/my-bucket?prefix=uploads/&delimiter=/&max-keys=100" \
  -H "Authorization: Bearer $TOKEN"

# Put object
curl -X PUT http://localhost:4006/my-bucket/path/to/file.txt \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: text/plain" \
  -H "x-amz-meta-author: test" \
  --data-binary "file contents"

# Get object
curl http://localhost:4006/my-bucket/path/to/file.txt \
  -H "Authorization: Bearer $TOKEN"

# Head object (metadata only)
curl -I http://localhost:4006/my-bucket/path/to/file.txt \
  -H "Authorization: Bearer $TOKEN"

# Delete object
curl -X DELETE http://localhost:4006/my-bucket/path/to/file.txt \
  -H "Authorization: Bearer $TOKEN"

# Copy object
curl -X PUT http://localhost:4006/dest-bucket/copy.txt \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-amz-copy-source: /source-bucket/original.txt"
```

### SQS

Current AWS SDK clients use the `/sqs` endpoint shown above. SQS accepts AWS JSON 1.0 requests at `POST /sqs/` with `Content-Type: application/x-amz-json-1.0` and `X-Amz-Target: AmazonSQS.<Action>`, returning JSON results and errors. XML Query requests with an `Action` form parameter remain supported. Queue operations also accept the returned `QueueUrl` as the endpoint.

```bash
# List queues using AWS JSON 1.0
curl -X POST http://localhost:4006/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/x-amz-json-1.0" \
  -H "X-Amz-Target: AmazonSQS.ListQueues" \
  -d '{}'
```

```bash
# Create queue
curl -X POST http://localhost:4006/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "Action=CreateQueue&QueueName=my-queue"

# Create queue with attributes
curl -X POST http://localhost:4006/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "Action=CreateQueue&QueueName=my-queue&Attribute.1.Name=VisibilityTimeout&Attribute.1.Value=30"

# List queues
curl -X POST http://localhost:4006/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=ListQueues"

# List queues with prefix filter
curl -X POST http://localhost:4006/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=ListQueues&QueueNamePrefix=my-"

# Get queue URL
curl -X POST http://localhost:4006/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=GetQueueUrl&QueueName=my-queue"

# Get queue attributes
curl -X POST http://localhost:4006/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=GetQueueAttributes&QueueUrl=<queue_url>"

# Send message
curl -X POST http://localhost:4006/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=SendMessage&QueueUrl=<queue_url>&MessageBody=Hello+World"

# Send message with attributes
curl -X POST http://localhost:4006/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=SendMessage&QueueUrl=<queue_url>&MessageBody=Hello&MessageAttribute.1.Name=type&MessageAttribute.1.Value.DataType=String&MessageAttribute.1.Value.StringValue=greeting"

# Receive messages
curl -X POST http://localhost:4006/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=ReceiveMessage&QueueUrl=<queue_url>&MaxNumberOfMessages=5"

# Delete message
curl -X POST http://localhost:4006/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=DeleteMessage&QueueUrl=<queue_url>&ReceiptHandle=<receipt_handle>"

# Purge queue
curl -X POST http://localhost:4006/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=PurgeQueue&QueueUrl=<queue_url>"

# Delete queue
curl -X POST http://localhost:4006/sqs/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=DeleteQueue&QueueUrl=<queue_url>"
```

### IAM

All IAM operations use `POST /iam/` with `Action` as a form-urlencoded parameter.

```bash
# Create user
curl -X POST http://localhost:4006/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=CreateUser&UserName=new-user"

# Get user
curl -X POST http://localhost:4006/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=GetUser&UserName=new-user"

# List users
curl -X POST http://localhost:4006/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=ListUsers"

# Delete user
curl -X POST http://localhost:4006/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=DeleteUser&UserName=new-user"

# Create access key
curl -X POST http://localhost:4006/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=CreateAccessKey&UserName=developer"

# List access keys
curl -X POST http://localhost:4006/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=ListAccessKeys&UserName=developer"

# Delete access key
curl -X POST http://localhost:4006/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=DeleteAccessKey&UserName=developer&AccessKeyId=AKIA..."

# Create role
curl -X POST http://localhost:4006/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=CreateRole&RoleName=my-role&AssumeRolePolicyDocument={}"

# Get role
curl -X POST http://localhost:4006/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=GetRole&RoleName=my-role"

# List roles
curl -X POST http://localhost:4006/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=ListRoles"

# Delete role
curl -X POST http://localhost:4006/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=DeleteRole&RoleName=my-role"
```

### Cognito

Use `CognitoIdentityProviderClient` with endpoint `/cognito-idp` and `CognitoIdentityClient` with `/cognito-identity`. Both accept AWS JSON 1.1 and work with the official AWS SDK v3:

```typescript
import { CognitoIdentityProviderClient, InitiateAuthCommand } from "@aws-sdk/client-cognito-identity-provider";

const cognito = new CognitoIdentityProviderClient({
  endpoint: "http://localhost:4007/cognito-idp",
  region: "us-east-1",
  credentials: { accessKeyId: "local-access-key", secretAccessKey: "local-secret" },
});
const result = await cognito.send(new InitiateAuthCommand({
  ClientId: "emulateclient",
  AuthFlow: "USER_PASSWORD_AUTH",
  AuthParameters: { USERNAME: "developer", PASSWORD: "LocalPass123!" },
}));
```

A default User Pool `us-east-1_emulate`, public app client `emulateclient`, and Identity Pool `us-east-1:00000000-0000-4000-8000-000000000001` are created without users. Seed a confirmed account for the example above:

```yaml
aws:
  cognito:
    user_pools:
      - id: us-east-1_emulate
        confirmation_code: "123456"
        users:
          - username: developer
            password: LocalPass123!
            attributes:
              email: dev@example.com
              email_verified: "true"
              name: Developer
```

User pools also accept `name` and `clients` with `client_id`, optional `client_secret`, exact `redirect_uris`, and allowed `scopes`. Users accept `status` (`CONFIRMED`, `UNCONFIRMED`, or `FORCE_CHANGE_PASSWORD`) and `enabled`. Passwords require at least eight characters and are stored as salted hashes. Confidential clients require Cognito's HMAC `SecretHash` or `SECRET_HASH` for SDK flows.

- `SignUp`, `ConfirmSignUp`, `ResendConfirmationCode`, `ForgotPassword`, and `ConfirmForgotPassword` model account confirmation and recovery. Codes expire after ten minutes and use the pool's `confirmation_code` fixture, default `123456`. No email or SMS is sent. Inspect active codes at `/_inspector?tab=cognito`; seeded unconfirmed users can request a code with `ResendConfirmationCode`.
- `InitiateAuth` supports `USER_PASSWORD_AUTH`, `REFRESH_TOKEN_AUTH`, and `REFRESH_TOKEN`. `AdminInitiateAuth` also supports `ADMIN_USER_PASSWORD_AUTH`. Admin-created temporary passwords return `NEW_PASSWORD_REQUIRED`, completed with `RespondToAuthChallenge` or `AdminRespondToAuthChallenge`. Challenge sessions expire after three minutes and are bound to the user and client.
- `GetUser`, `ChangePassword`, `GlobalSignOut`, and `RevokeToken` use issued tokens. `AdminCreateUser` (with `TemporaryPassword`), `AdminGetUser`, `AdminConfirmSignUp`, `AdminSetUserPassword`, `AdminEnableUser`, `AdminDisableUser`, `AdminDeleteUser`, and paginated `ListUsers` support test setup and administration.

Tokens are RS256 JWTs with Cognito `token_use` claims. ID tokens identify the app client in `aud`; access tokens use `client_id`. ID and access tokens expire after one hour; refresh tokens after thirty days. Sign-out, revocation, disabling, deletion, and password resets invalidate affected sessions. Users, sessions, identities, and signing keys participate in snapshots, restore, and reset.

The local issuer is `http://localhost:4007/cognito-idp/USER_POOL_ID`. Discovery and public keys are served at `ISSUER/.well-known/openid-configuration` and `ISSUER/.well-known/jwks.json`. Configure token verifiers with this local issuer and JWKS. `ISSUER/oauth2/authorize` presents a local user picker, `ISSUER/oauth2/token` exchanges authorization codes or refresh tokens, and `ISSUER/oauth2/userInfo` returns scoped profile claims. Authorization codes expire after five minutes, are single-use, and bind the client, exact redirect URI, and optional S256 PKCE challenge. Client authentication accepts `client_secret_basic` or `client_secret_post`. The default client permits `http://localhost:3000/callback`.

Identity Pools support `GetId` and `GetCredentialsForIdentity`. Supply the ID token in `Logins` under `cognito-idp.REGION.amazonaws.com/USER_POOL_ID`. The default Identity Pool accepts the default User Pool and app client. Custom `aws.cognito.identity_pools` entries take `id`, optional `name`, `providers: [{ user_pool_id, client_id }]`, and `allow_unauthenticated_identities` (default `false`). Identities remain stable for the same authenticated subject. Credentials expire after one hour; login signatures, expiry, audience, and identity ownership are checked.

SRP, MFA, external identity providers, Lambda triggers, pool/client management APIs, `ListUsers` filters, and Identity Pool role selection are not simulated. Administrative requests follow the AWS emulator's permissive credential behavior: SigV4 signatures and IAM policies are not evaluated. Identity Pool credentials are generated test credentials, without role or policy evaluation.

### STS

All STS operations use `POST /sts/` with `Action` as a form-urlencoded parameter.

```bash
# Get caller identity
curl -X POST http://localhost:4006/sts/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=GetCallerIdentity"

# Assume role
curl -X POST http://localhost:4006/sts/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=AssumeRole&RoleArn=arn:aws:iam::123456789012:role/my-role&RoleSessionName=my-session"
```

### Inspector

```bash
# HTML dashboard (shows S3, SQS, IAM state)
curl http://localhost:4006/_inspector?tab=s3
curl http://localhost:4006/_inspector?tab=sqs
curl http://localhost:4006/_inspector?tab=iam
```

## Common Patterns

### Upload and Retrieve an Object

```bash
TOKEN="test_token_admin"
BASE="http://localhost:4006"

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
BASE="http://localhost:4006"

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
BASE="http://localhost:4006"

# Create user
curl -X POST $BASE/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=CreateUser&UserName=ci-user"

# Generate access key
curl -X POST $BASE/iam/ \
  -H "Authorization: Bearer $TOKEN" \
  -d "Action=CreateAccessKey&UserName=ci-user"
```

## Custom emulators alongside built-ins

Use `npx emulate init --custom inventory` to scaffold a third-party API emulator and test. Register it in `emulate.config.ts` with `defineConfig` from `emulate`, alongside built-in entries such as `{ emulator: "aws" }`. Run `npx emulate start --watch` to reload imports and inspect custom state at the printed `/_emulate` URL. Successful reloads reset the run to seed. Existing flat seed configs still work; `--config` selects an explicit file. For authoring and testing third-party API emulators, see https://emulate.dev/docs/custom-emulators.
