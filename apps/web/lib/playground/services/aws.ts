import type { ConsoleService } from "./types";

const userPool = "us-east-1_emulate";
const appClient = "emulateclient";
const form = { "Content-Type": "application/x-www-form-urlencoded" };
const sqsJson = "application/x-amz-json-1.0";
const cognitoJson = "application/x-amz-json-1.1";
const kmsJson = "application/x-amz-json-1.1";

/** AWS requests for the request console, one preset per operation the emulator can run in a browser. */
export const aws: ConsoleService = {
  name: "aws",
  label: "AWS",
  description:
    "S3 buckets and objects, SQS queues and messages, IAM users, roles, and access keys, STS, KMS keys, and Cognito users, sign-in, and sign-up.",
  variables: [
    {
      name: "access_key_id",
      label: "Access key ID",
      hint: "Copy the text between <AccessKeyId> and </AccessKeyId> from the response of Create access key. That response is XML, so the value is not filled in for you.",
    },
    {
      name: "queue_url",
      label: "Queue URL",
      hint: "Filled in when you run Get queue URL. You can also paste one.",
    },
    {
      name: "demo_queue_url",
      label: "Demo queue URL",
      hint: "Filled in when you run Create queue. You can also paste one.",
    },
    {
      name: "receipt_handle",
      label: "Receipt handle",
      hint: "Filled in when you run Receive message. You can also paste one.",
    },
  ],
  groups: [
    {
      title: "S3 buckets",
      presets: [
        { label: "List buckets", description: "Lists every bucket the emulator holds.", method: "GET", path: "/" },
        {
          label: "Create bucket",
          description: "Creates a bucket named playground-demo; change the name in the path to create another.",
          method: "PUT",
          path: "/playground-demo",
        },
        {
          label: "Check bucket",
          description:
            "Checks that playground-demo exists and returns its region in the headers. Run Create bucket first.",
          method: "HEAD",
          path: "/playground-demo",
        },
        {
          label: "Delete bucket",
          description: "Deletes the empty playground-demo bucket. Run Create bucket first.",
          method: "DELETE",
          path: "/playground-demo",
        },
      ],
    },
    {
      title: "S3 objects",
      presets: [
        {
          label: "Put object",
          description: "Uploads hello.txt into the default bucket; edit the body to upload other content.",
          method: "PUT",
          path: "/emulate-default/hello.txt",
          headers: { "Content-Type": "text/plain" },
          body: "hello from the playground",
        },
        {
          label: "List objects",
          description: "Lists the objects in the default bucket. Run Put object first to see hello.txt.",
          method: "GET",
          path: "/emulate-default",
        },
        {
          label: "Get object",
          description: "Downloads hello.txt from the default bucket. Run Put object first.",
          method: "GET",
          path: "/emulate-default/hello.txt",
        },
        {
          label: "Check object",
          description: "Returns the headers of hello.txt without its body. Run Put object first.",
          method: "HEAD",
          path: "/emulate-default/hello.txt",
        },
        {
          label: "Copy object",
          description: "Copies hello.txt to hello-copy.txt. Run Put object first.",
          method: "PUT",
          path: "/emulate-default/hello-copy.txt",
          headers: { "x-amz-copy-source": "/emulate-default/hello.txt" },
        },
        {
          label: "Post object",
          description: "Uploads a file with a browser-style form POST to uploads/form.txt in the default bucket.",
          method: "POST",
          path: "/emulate-default",
          headers: { "Content-Type": "multipart/form-data; boundary=emulate-form" },
          body: '--emulate-form\r\nContent-Disposition: form-data; name="key"\r\n\r\nuploads/form.txt\r\n--emulate-form\r\nContent-Disposition: form-data; name="file"; filename="form.txt"\r\nContent-Type: text/plain\r\n\r\nhello from a form upload\r\n--emulate-form--\r\n',
        },
        {
          label: "Delete object",
          description: "Deletes hello-copy.txt from the default bucket. Run Copy object first.",
          method: "DELETE",
          path: "/emulate-default/hello-copy.txt",
        },
      ],
    },
    {
      title: "SQS queues",
      presets: [
        {
          label: "Create queue",
          description: "Creates a queue named playground-demo. Delete queue removes it again.",
          method: "POST",
          path: "/sqs/123456789012/playground-demo",
          headers: { "Content-Type": sqsJson, "X-Amz-Target": "AmazonSQS.CreateQueue" },
          body: JSON.stringify({ QueueName: "playground-demo" }, null, 2),
          captures: { demo_queue_url: "QueueUrl" },
        },
        {
          label: "List queues",
          description: "Lists the URL of every queue the emulator holds.",
          method: "POST",
          path: "/sqs/123456789012/emulate-default-queue",
          headers: { "Content-Type": sqsJson, "X-Amz-Target": "AmazonSQS.ListQueues" },
          body: JSON.stringify({}, null, 2),
        },
        {
          label: "Get queue URL",
          description:
            "Looks up the URL of emulate-default-queue by its name and keeps it for the other queue operations.",
          method: "POST",
          path: "/sqs/123456789012/emulate-default-queue",
          headers: { "Content-Type": sqsJson, "X-Amz-Target": "AmazonSQS.GetQueueUrl" },
          body: JSON.stringify({ QueueName: "emulate-default-queue" }, null, 2),
          captures: { queue_url: "QueueUrl" },
        },
        {
          label: "Get queue attributes",
          description: "Returns the settings and message counts of emulate-default-queue.",
          method: "POST",
          path: "/sqs/123456789012/emulate-default-queue",
          headers: { "Content-Type": sqsJson, "X-Amz-Target": "AmazonSQS.GetQueueAttributes" },
          body: JSON.stringify({ QueueUrl: "{{queue_url}}" }, null, 2),
        },
        {
          label: "Delete queue",
          description: "Deletes playground-demo and any messages in it. Run Create queue first.",
          method: "POST",
          path: "/sqs/123456789012/playground-demo",
          headers: { "Content-Type": sqsJson, "X-Amz-Target": "AmazonSQS.DeleteQueue" },
          body: JSON.stringify({ QueueUrl: "{{demo_queue_url}}" }, null, 2),
        },
      ],
    },
    {
      title: "SQS messages",
      presets: [
        {
          label: "Send message",
          description: "Sends a message with the text hello from the playground to emulate-default-queue.",
          method: "POST",
          path: "/sqs/123456789012/emulate-default-queue",
          headers: { "Content-Type": sqsJson, "X-Amz-Target": "AmazonSQS.SendMessage" },
          body: JSON.stringify({ QueueUrl: "{{queue_url}}", MessageBody: "hello from the playground" }, null, 2),
        },
        {
          label: "Receive message",
          description:
            "Receives one message from emulate-default-queue and keeps its receipt handle for Delete message.",
          method: "POST",
          path: "/sqs/123456789012/emulate-default-queue",
          headers: { "Content-Type": sqsJson, "X-Amz-Target": "AmazonSQS.ReceiveMessage" },
          body: JSON.stringify({ QueueUrl: "{{queue_url}}", MaxNumberOfMessages: 1 }, null, 2),
          captures: { receipt_handle: "Messages.0.ReceiptHandle" },
        },
        {
          label: "Delete message",
          description: "Deletes the message whose receipt handle is in Receipt handle. Run Receive message first.",
          method: "POST",
          path: "/sqs/123456789012/emulate-default-queue",
          headers: { "Content-Type": sqsJson, "X-Amz-Target": "AmazonSQS.DeleteMessage" },
          body: JSON.stringify({ QueueUrl: "{{queue_url}}", ReceiptHandle: "{{receipt_handle}}" }, null, 2),
        },
        {
          label: "Purge queue",
          description: "Deletes every message left in emulate-default-queue.",
          method: "POST",
          path: "/sqs/123456789012/emulate-default-queue",
          headers: { "Content-Type": sqsJson, "X-Amz-Target": "AmazonSQS.PurgeQueue" },
          body: JSON.stringify({ QueueUrl: "{{queue_url}}" }, null, 2),
        },
      ],
    },
    {
      title: "IAM users",
      presets: [
        {
          label: "Create user",
          description: "Creates an IAM user named playground-user.",
          method: "POST",
          path: "/iam/",
          headers: form,
          body: "Action=CreateUser&UserName=playground-user&Version=2010-05-08",
        },
        {
          label: "List users",
          description: "Lists every IAM user, including the default admin user.",
          method: "POST",
          path: "/iam/",
          headers: form,
          body: "Action=ListUsers&Version=2010-05-08",
        },
        {
          label: "Get user",
          description: "Returns playground-user. Run Create user first.",
          method: "POST",
          path: "/iam/",
          headers: form,
          body: "Action=GetUser&UserName=playground-user&Version=2010-05-08",
        },
        {
          label: "Create access key",
          description:
            "Creates an access key for playground-user. Copy the AccessKeyId value from its XML response into Access key ID for Delete access key.",
          method: "POST",
          path: "/iam/",
          headers: form,
          body: "Action=CreateAccessKey&UserName=playground-user&Version=2010-05-08",
        },
        {
          label: "List access keys",
          description: "Lists the access keys of playground-user. Run Create user first.",
          method: "POST",
          path: "/iam/",
          headers: form,
          body: "Action=ListAccessKeys&UserName=playground-user&Version=2010-05-08",
        },
        {
          label: "Delete access key",
          description: "Deletes the access key in Access key ID from playground-user. Run Create access key first.",
          method: "POST",
          path: "/iam/",
          headers: form,
          body: "Action=DeleteAccessKey&UserName=playground-user&AccessKeyId={{access_key_id}}&Version=2010-05-08",
        },
        {
          label: "Delete user",
          description: "Deletes playground-user. Run Create user first.",
          method: "POST",
          path: "/iam/",
          headers: form,
          body: "Action=DeleteUser&UserName=playground-user&Version=2010-05-08",
        },
      ],
    },
    {
      title: "IAM roles",
      presets: [
        {
          label: "Create role",
          description: "Creates an IAM role named playground-role with an empty trust policy.",
          method: "POST",
          path: "/iam/",
          headers: form,
          body: "Action=CreateRole&RoleName=playground-role&Description=Playground%20role&AssumeRolePolicyDocument=%7B%22Version%22%3A%222012-10-17%22%2C%22Statement%22%3A%5B%5D%7D&Version=2010-05-08",
        },
        {
          label: "List roles",
          description: "Lists every IAM role, including the seeded emulate-default-role.",
          method: "POST",
          path: "/iam/",
          headers: form,
          body: "Action=ListRoles&Version=2010-05-08",
        },
        {
          label: "Get role",
          description: "Returns playground-role. Run Create role first.",
          method: "POST",
          path: "/iam/",
          headers: form,
          body: "Action=GetRole&RoleName=playground-role&Version=2010-05-08",
        },
        {
          label: "Delete role",
          description: "Deletes playground-role. Run Create role first.",
          method: "POST",
          path: "/iam/",
          headers: form,
          body: "Action=DeleteRole&RoleName=playground-role&Version=2010-05-08",
        },
      ],
    },
    {
      title: "STS",
      presets: [
        {
          label: "Get caller identity",
          description: "Returns the ARN and account of the caller, which the emulator reports as the admin user.",
          method: "POST",
          path: "/sts/",
          headers: form,
          body: "Action=GetCallerIdentity&Version=2011-06-15",
        },
        {
          label: "Assume role",
          description: "Returns temporary credentials for the seeded emulate-default-role.",
          method: "POST",
          path: "/sts/",
          headers: form,
          body: "Action=AssumeRole&RoleArn=arn:aws:iam::123456789012:role/emulate-default-role&RoleSessionName=playground&Version=2011-06-15",
        },
        {
          label: "Assume role with web identity",
          description:
            "Returns temporary credentials for emulate-default-role from a GitHub OAuth token, which the emulator does not check.",
          method: "POST",
          path: "/sts/",
          headers: form,
          body: "Action=AssumeRoleWithWebIdentity&RoleArn=arn:aws:iam::123456789012:role/emulate-default-role&RoleSessionName=playground&ProviderId=github.com&WebIdentityToken=playground-token&Version=2011-06-15",
        },
      ],
    },
    {
      title: "KMS keys",
      presets: [
        {
          label: "Create key",
          description: "Creates a symmetric encryption key with a description.",
          method: "POST",
          path: "/kms",
          headers: { "Content-Type": kmsJson, "X-Amz-Target": "TrentService.CreateKey" },
          body: JSON.stringify({ Description: "Playground key" }, null, 2),
        },
        {
          label: "List keys",
          description: "Lists the key IDs and ARNs of every key in the emulator.",
          method: "POST",
          path: "/kms",
          headers: { "Content-Type": kmsJson, "X-Amz-Target": "TrentService.ListKeys" },
          body: JSON.stringify({}, null, 2),
        },
        {
          label: "Describe key",
          description: "Returns the metadata of the default key, found through its alias.",
          method: "POST",
          path: "/kms",
          headers: { "Content-Type": kmsJson, "X-Amz-Target": "TrentService.DescribeKey" },
          body: JSON.stringify({ KeyId: "alias/emulate-default" }, null, 2),
        },
      ],
    },
    {
      title: "Cognito users",
      presets: [
        {
          label: "Create user",
          description: "Creates playground-user in the default user pool with a temporary password.",
          method: "POST",
          path: "/cognito-idp",
          headers: { "Content-Type": cognitoJson, "X-Amz-Target": "AWSCognitoIdentityProviderService.AdminCreateUser" },
          body: JSON.stringify(
            { UserPoolId: userPool, Username: "playground-user", TemporaryPassword: "Temp-Passw0rd!" },
            null,
            2,
          ),
        },
        {
          label: "List users",
          description: "Lists the users in the default user pool.",
          method: "POST",
          path: "/cognito-idp",
          headers: { "Content-Type": cognitoJson, "X-Amz-Target": "AWSCognitoIdentityProviderService.ListUsers" },
          body: JSON.stringify({ UserPoolId: userPool }, null, 2),
        },
        {
          label: "Get user",
          description: "Returns the status and attributes of playground-user. Run Create user first.",
          method: "POST",
          path: "/cognito-idp",
          headers: { "Content-Type": cognitoJson, "X-Amz-Target": "AWSCognitoIdentityProviderService.AdminGetUser" },
          body: JSON.stringify({ UserPoolId: userPool, Username: "playground-user" }, null, 2),
        },
        {
          label: "Start admin sign-in",
          description:
            "Signs in playground-user with the temporary password, which returns a password challenge. Run Create user first.",
          method: "POST",
          path: "/cognito-idp",
          headers: {
            "Content-Type": cognitoJson,
            "X-Amz-Target": "AWSCognitoIdentityProviderService.AdminInitiateAuth",
          },
          body: JSON.stringify(
            {
              UserPoolId: userPool,
              ClientId: appClient,
              AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
              AuthParameters: { USERNAME: "playground-user", PASSWORD: "Temp-Passw0rd!" },
            },
            null,
            2,
          ),
        },
        {
          label: "Set temporary password",
          description:
            "Sets the temporary password of playground-user again, so the next sign-in needs a new password. Run Create user first.",
          method: "POST",
          path: "/cognito-idp",
          headers: {
            "Content-Type": cognitoJson,
            "X-Amz-Target": "AWSCognitoIdentityProviderService.AdminSetUserPassword",
          },
          body: JSON.stringify(
            { UserPoolId: userPool, Username: "playground-user", Password: "Temp-Passw0rd!", Permanent: false },
            null,
            2,
          ),
        },
        {
          label: "Disable user",
          description: "Disables playground-user and revokes its sessions. Run Create user first.",
          method: "POST",
          path: "/cognito-idp",
          headers: {
            "Content-Type": cognitoJson,
            "X-Amz-Target": "AWSCognitoIdentityProviderService.AdminDisableUser",
          },
          body: JSON.stringify({ UserPoolId: userPool, Username: "playground-user" }, null, 2),
        },
        {
          label: "Enable user",
          description: "Enables playground-user again after Disable user.",
          method: "POST",
          path: "/cognito-idp",
          headers: { "Content-Type": cognitoJson, "X-Amz-Target": "AWSCognitoIdentityProviderService.AdminEnableUser" },
          body: JSON.stringify({ UserPoolId: userPool, Username: "playground-user" }, null, 2),
        },
      ],
    },
    {
      title: "Cognito sign-in",
      presets: [
        {
          label: "Sign in with password",
          description:
            "Signs in playground-user with the temporary password, which returns a new password challenge. Run Create user first.",
          method: "POST",
          path: "/cognito-idp",
          headers: { "Content-Type": cognitoJson, "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth" },
          body: JSON.stringify(
            {
              AuthFlow: "USER_PASSWORD_AUTH",
              ClientId: appClient,
              AuthParameters: { USERNAME: "playground-user", PASSWORD: "Temp-Passw0rd!" },
            },
            null,
            2,
          ),
        },
      ],
    },
    {
      title: "Cognito OAuth",
      presets: [
        {
          label: "OpenID configuration",
          description: "Returns the OpenID discovery document of the default user pool.",
          method: "GET",
          path: `/cognito-idp/${userPool}/.well-known/openid-configuration`,
        },
      ],
    },
    {
      title: "Cognito sign-up",
      presets: [
        {
          label: "Sign up",
          description: "Creates signup-user as unconfirmed. The emulator's confirmation code is 123456.",
          method: "POST",
          path: "/cognito-idp",
          headers: { "Content-Type": cognitoJson, "X-Amz-Target": "AWSCognitoIdentityProviderService.SignUp" },
          body: JSON.stringify(
            { ClientId: appClient, Username: "signup-user", Password: "Playground-Pass1!" },
            null,
            2,
          ),
        },
        {
          label: "Resend confirmation code",
          description: "Issues a new confirmation code for signup-user. Run Sign up first.",
          method: "POST",
          path: "/cognito-idp",
          headers: {
            "Content-Type": cognitoJson,
            "X-Amz-Target": "AWSCognitoIdentityProviderService.ResendConfirmationCode",
          },
          body: JSON.stringify({ ClientId: appClient, Username: "signup-user" }, null, 2),
        },
        {
          label: "Confirm sign-up",
          description: "Confirms signup-user with the code 123456. Run Sign up first.",
          method: "POST",
          path: "/cognito-idp",
          headers: { "Content-Type": cognitoJson, "X-Amz-Target": "AWSCognitoIdentityProviderService.ConfirmSignUp" },
          body: JSON.stringify({ ClientId: appClient, Username: "signup-user", ConfirmationCode: "123456" }, null, 2),
        },
        {
          label: "Forgot password",
          description: "Sends a password reset code for signup-user, which is 123456 in the emulator.",
          method: "POST",
          path: "/cognito-idp",
          headers: { "Content-Type": cognitoJson, "X-Amz-Target": "AWSCognitoIdentityProviderService.ForgotPassword" },
          body: JSON.stringify({ ClientId: appClient, Username: "signup-user" }, null, 2),
        },
        {
          label: "Confirm new password",
          description: "Sets a new password for signup-user with the reset code 123456. Run Forgot password first.",
          method: "POST",
          path: "/cognito-idp",
          headers: {
            "Content-Type": cognitoJson,
            "X-Amz-Target": "AWSCognitoIdentityProviderService.ConfirmForgotPassword",
          },
          body: JSON.stringify(
            { ClientId: appClient, Username: "signup-user", ConfirmationCode: "123456", Password: "Playground-Pass2!" },
            null,
            2,
          ),
        },
        {
          label: "Confirm user",
          description: "Marks signup-user as confirmed without a code. Run Sign up first.",
          method: "POST",
          path: "/cognito-idp",
          headers: {
            "Content-Type": cognitoJson,
            "X-Amz-Target": "AWSCognitoIdentityProviderService.AdminConfirmSignUp",
          },
          body: JSON.stringify({ UserPoolId: userPool, Username: "signup-user" }, null, 2),
        },
      ],
    },
    {
      title: "Cognito cleanup",
      presets: [
        {
          label: "Delete user",
          description: "Deletes playground-user so the Cognito users can be created again. Run it last.",
          method: "POST",
          path: "/cognito-idp",
          headers: {
            "Content-Type": cognitoJson,
            "X-Amz-Target": "AWSCognitoIdentityProviderService.AdminDeleteUser",
          },
          body: JSON.stringify({ UserPoolId: userPool, Username: "playground-user" }, null, 2),
        },
      ],
    },
  ],
};
