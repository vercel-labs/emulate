# @emulators/aws

S3, SQS, Cognito, IAM, and STS emulation with AWS SDK-compatible S3 paths, JSON SQS/Cognito endpoints, and XML Query IAM/STS endpoints. S3 uploads and downloads preserve arbitrary binary payloads, including raw byte lengths and ETags. Responses use the corresponding AWS wire format.

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
All operations via `POST /sqs/` with `Action` parameter:
- `CreateQueue`, `ListQueues`, `GetQueueUrl`, `GetQueueAttributes`
- `SendMessage`, `ReceiveMessage`, `DeleteMessage`
- `PurgeQueue`, `DeleteQueue`

### IAM
All operations via `POST /iam/` with `Action` parameter:
- `CreateUser`, `GetUser`, `ListUsers`, `DeleteUser`
- `CreateAccessKey`, `ListAccessKeys`, `DeleteAccessKey`
- `CreateRole`, `GetRole`, `ListRoles`, `DeleteRole`

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
All operations via `POST /sts/` with `Action` parameter:
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
