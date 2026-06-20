import type { Context, RouteContext, Store } from "@emulators/core";
import type { SnsSubscription, SqsQueue } from "../entities.js";
import { getAwsStore } from "../store.js";
import {
  awsXmlResponse,
  awsErrorXml,
  escapeXml,
  generateMessageId,
  generateReceiptHandle,
  getAccountId,
  getDefaultRegion,
  md5,
  parseQueryString,
} from "../helpers.js";

interface SnsPublishInput {
  topicArn: string;
  message: string;
  subject?: string;
  messageAttributes?: Record<string, { Type: string; Value: string }>;
}

interface SnsEnvelope {
  Type: "Notification";
  MessageId: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: "1";
  Signature: string;
  SigningCertURL: string;
  UnsubscribeURL: string;
  MessageAttributes?: Record<string, { Type: string; Value: string }>;
}

export function snsRoutes(ctx: RouteContext): void {
  const { app, store, baseUrl } = ctx;
  const aws = () => getAwsStore(store);
  const accountId = getAccountId();
  const region = getDefaultRegion();

  const handleSnsAction = async (c: Context) => {
    const body = await c.req.text();
    const params = parseQueryString(body);
    const action = params["Action"] ?? c.req.query("Action") ?? "";

    switch (action) {
      case "CreateTopic":
        return createTopic(c, params);
      case "ListTopics":
        return listTopics(c);
      case "DeleteTopic":
        return deleteTopic(c, params);
      case "Subscribe":
        return subscribe(c, params);
      case "Unsubscribe":
        return unsubscribe(c, params);
      case "Publish":
        return publish(c, params);
      case "GetTopicAttributes":
        return getTopicAttributes(c, params);
      case "SetTopicAttributes":
        return setTopicAttributes(c, params);
      case "GetSubscriptionAttributes":
        return getSubscriptionAttributes(c, params);
      case "SetSubscriptionAttributes":
        return setSubscriptionAttributes(c, params);
      default:
        return awsErrorXml(c, "InvalidAction", `The action ${action} is not valid for this endpoint.`, 400);
    }
  };

  app.post("/sns", handleSnsAction);
  app.post("/sns/", handleSnsAction);

  function createTopic(c: Context, params: Record<string, string>) {
    const topicName = params["Name"] ?? "";
    if (!topicName) {
      return awsErrorXml(c, "MissingParameter", "The request must contain the parameter Name.", 400);
    }

    const existing = aws().snsTopics.findOneBy("topic_name", topicName);
    if (existing) {
      return createTopicResponse(c, existing.arn);
    }

    const attrs = parseAttributeMap(params, "Attributes");
    const arn = `arn:aws:sns:${region}:${accountId}:${topicName}`;
    aws().snsTopics.insert({
      topic_name: topicName,
      arn,
      attributes: attrs,
    });

    return createTopicResponse(c, arn);
  }

  function createTopicResponse(c: Context, topicArn: string) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CreateTopicResponse>
  <CreateTopicResult>
    <TopicArn>${escapeXml(topicArn)}</TopicArn>
  </CreateTopicResult>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</CreateTopicResponse>`;
    return awsXmlResponse(c, xml);
  }

  function listTopics(c: Context) {
    const topicsXml = aws()
      .snsTopics.all()
      .map(
        (topic) => `      <member>
        <TopicArn>${escapeXml(topic.arn)}</TopicArn>
      </member>`,
      )
      .join("\n");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListTopicsResponse>
  <ListTopicsResult>
    <Topics>
${topicsXml}
    </Topics>
  </ListTopicsResult>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</ListTopicsResponse>`;
    return awsXmlResponse(c, xml);
  }

  function deleteTopic(c: Context, params: Record<string, string>) {
    const topicArn = params["TopicArn"] ?? "";
    const topic = aws().snsTopics.findOneBy("arn", topicArn);
    if (topic) {
      for (const subscription of aws().snsSubscriptions.findBy("topic_arn", topicArn)) {
        aws().snsSubscriptions.delete(subscription.id);
      }
      aws().snsTopics.delete(topic.id);
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DeleteTopicResponse>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</DeleteTopicResponse>`;
    return awsXmlResponse(c, xml);
  }

  function subscribe(c: Context, params: Record<string, string>) {
    const topicArn = params["TopicArn"] ?? "";
    const protocol = (params["Protocol"] ?? "").toLowerCase();
    const endpoint = params["Endpoint"] ?? "";
    if (!topicArn || !protocol || !endpoint) {
      return awsErrorXml(c, "MissingParameter", "TopicArn, Protocol, and Endpoint are required.", 400);
    }

    const topic = aws().snsTopics.findOneBy("arn", topicArn);
    if (!topic) {
      return awsErrorXml(c, "NotFound", "Topic does not exist.", 404);
    }

    const existing = aws()
      .snsSubscriptions.findBy("topic_arn", topicArn)
      .find((subscription) => subscription.protocol === protocol && subscription.endpoint === endpoint);
    if (existing) {
      return subscribeResponse(c, existing.subscription_arn);
    }

    const attributes = parseAttributeMap(params, "Attributes");
    const subscriptionArn = `${topicArn}:${generateMessageId()}`;
    aws().snsSubscriptions.insert({
      subscription_arn: subscriptionArn,
      topic_arn: topicArn,
      protocol,
      endpoint,
      attributes,
    });

    return subscribeResponse(c, subscriptionArn);
  }

  function subscribeResponse(c: Context, subscriptionArn: string) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SubscribeResponse>
  <SubscribeResult>
    <SubscriptionArn>${escapeXml(subscriptionArn)}</SubscriptionArn>
  </SubscribeResult>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</SubscribeResponse>`;
    return awsXmlResponse(c, xml);
  }

  function unsubscribe(c: Context, params: Record<string, string>) {
    const subscriptionArn = params["SubscriptionArn"] ?? "";
    const subscription = aws().snsSubscriptions.findOneBy("subscription_arn", subscriptionArn);
    if (subscription) {
      aws().snsSubscriptions.delete(subscription.id);
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<UnsubscribeResponse>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</UnsubscribeResponse>`;
    return awsXmlResponse(c, xml);
  }

  async function publish(c: Context, params: Record<string, string>) {
    const topicArn = params["TopicArn"] ?? "";
    const message = params["Message"] ?? "";
    if (!topicArn || !message) {
      return awsErrorXml(c, "MissingParameter", "TopicArn and Message are required.", 400);
    }

    const topic = aws().snsTopics.findOneBy("arn", topicArn);
    if (!topic) {
      return awsErrorXml(c, "NotFound", "Topic does not exist.", 404);
    }

    const messageId = await publishToSnsTopic(store, baseUrl, {
      topicArn,
      message,
      subject: params["Subject"],
      messageAttributes: parseMessageAttributes(params),
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<PublishResponse>
  <PublishResult>
    <MessageId>${messageId}</MessageId>
  </PublishResult>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</PublishResponse>`;
    return awsXmlResponse(c, xml);
  }

  function getTopicAttributes(c: Context, params: Record<string, string>) {
    const topicArn = params["TopicArn"] ?? "";
    const topic = aws().snsTopics.findOneBy("arn", topicArn);
    if (!topic) {
      return awsErrorXml(c, "NotFound", "Topic does not exist.", 404);
    }

    const subscriptions = aws().snsSubscriptions.findBy("topic_arn", topicArn);
    const attrs: Record<string, string> = {
      TopicArn: topic.arn,
      Owner: accountId,
      SubscriptionsPending: "0",
      SubscriptionsConfirmed: String(subscriptions.length),
      SubscriptionsDeleted: "0",
      DisplayName: topic.attributes["DisplayName"] ?? "",
      ...topic.attributes,
    };

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GetTopicAttributesResponse>
  <GetTopicAttributesResult>
    <Attributes>
${attributesXml(attrs)}
    </Attributes>
  </GetTopicAttributesResult>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</GetTopicAttributesResponse>`;
    return awsXmlResponse(c, xml);
  }

  function setTopicAttributes(c: Context, params: Record<string, string>) {
    const topicArn = params["TopicArn"] ?? "";
    const attributeName = params["AttributeName"] ?? "";
    const attributeValue = params["AttributeValue"] ?? "";
    const topic = aws().snsTopics.findOneBy("arn", topicArn);
    if (!topic) {
      return awsErrorXml(c, "NotFound", "Topic does not exist.", 404);
    }
    if (!attributeName) {
      return awsErrorXml(c, "MissingParameter", "AttributeName is required.", 400);
    }

    aws().snsTopics.update(topic.id, {
      attributes: {
        ...topic.attributes,
        [attributeName]: attributeValue,
      },
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SetTopicAttributesResponse>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</SetTopicAttributesResponse>`;
    return awsXmlResponse(c, xml);
  }

  function getSubscriptionAttributes(c: Context, params: Record<string, string>) {
    const subscriptionArn = params["SubscriptionArn"] ?? "";
    const subscription = aws().snsSubscriptions.findOneBy("subscription_arn", subscriptionArn);
    if (!subscription) {
      return awsErrorXml(c, "NotFound", "Subscription does not exist.", 404);
    }

    const attrs: Record<string, string> = {
      SubscriptionArn: subscription.subscription_arn,
      TopicArn: subscription.topic_arn,
      Protocol: subscription.protocol,
      Endpoint: subscription.endpoint,
      Owner: accountId,
      PendingConfirmation: "false",
      RawMessageDelivery: subscription.attributes["RawMessageDelivery"] ?? "false",
      ...subscription.attributes,
    };

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GetSubscriptionAttributesResponse>
  <GetSubscriptionAttributesResult>
    <Attributes>
${attributesXml(attrs)}
    </Attributes>
  </GetSubscriptionAttributesResult>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</GetSubscriptionAttributesResponse>`;
    return awsXmlResponse(c, xml);
  }

  function setSubscriptionAttributes(c: Context, params: Record<string, string>) {
    const subscriptionArn = params["SubscriptionArn"] ?? "";
    const attributeName = params["AttributeName"] ?? "";
    const attributeValue = params["AttributeValue"] ?? "";
    const subscription = aws().snsSubscriptions.findOneBy("subscription_arn", subscriptionArn);
    if (!subscription) {
      return awsErrorXml(c, "NotFound", "Subscription does not exist.", 404);
    }
    if (!attributeName) {
      return awsErrorXml(c, "MissingParameter", "AttributeName is required.", 400);
    }

    aws().snsSubscriptions.update(subscription.id, {
      attributes: {
        ...subscription.attributes,
        [attributeName]: attributeValue,
      },
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SetSubscriptionAttributesResponse>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</SetSubscriptionAttributesResponse>`;
    return awsXmlResponse(c, xml);
  }
}

export async function publishToSnsTopic(store: Store, baseUrl: string, input: SnsPublishInput): Promise<string> {
  const aws = getAwsStore(store);
  const topic = aws.snsTopics.findOneBy("arn", input.topicArn);
  const messageId = generateMessageId();
  if (!topic) {
    return messageId;
  }

  const envelope = buildEnvelope(baseUrl, {
    ...input,
    messageId,
  });

  const subscriptions = aws.snsSubscriptions.findBy("topic_arn", input.topicArn);
  for (const subscription of subscriptions) {
    await deliverToSubscription(store, subscription, envelope);
  }

  return messageId;
}

function buildEnvelope(
  baseUrl: string,
  input: SnsPublishInput & {
    messageId: string;
  },
): SnsEnvelope {
  const envelope: SnsEnvelope = {
    Type: "Notification",
    MessageId: input.messageId,
    TopicArn: input.topicArn,
    Message: input.message,
    Timestamp: new Date().toISOString(),
    SignatureVersion: "1",
    Signature: "emulate-fake-signature",
    SigningCertURL: `${baseUrl}/sns/fake-signing-cert.pem`,
    UnsubscribeURL: `${baseUrl}/sns/?Action=Unsubscribe&SubscriptionArn=emulate`,
  };

  if (input.subject) {
    envelope.Subject = input.subject;
  }
  if (input.messageAttributes && Object.keys(input.messageAttributes).length > 0) {
    envelope.MessageAttributes = input.messageAttributes;
  }

  return envelope;
}

async function deliverToSubscription(store: Store, subscription: SnsSubscription, envelope: SnsEnvelope): Promise<void> {
  switch (subscription.protocol) {
    case "sqs":
      deliverToSqs(store, subscription, envelope);
      return;
    case "http":
    case "https":
      await deliverToHttp(store, subscription, envelope);
      return;
    default:
      return;
  }
}

function deliverToSqs(store: Store, subscription: SnsSubscription, envelope: SnsEnvelope): void {
  const queue = findQueueByEndpoint(store, subscription.endpoint);
  if (!queue) {
    return;
  }

  const rawMessageDelivery = subscription.attributes["RawMessageDelivery"]?.toLowerCase() === "true";
  enqueueSqsMessage(store, queue, rawMessageDelivery ? envelope.Message : JSON.stringify(envelope));
}

async function deliverToHttp(store: Store, subscription: SnsSubscription, envelope: SnsEnvelope): Promise<void> {
  let delivered = false;
  try {
    const res = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain; charset=UTF-8",
        "x-amz-sns-message-type": envelope.Type,
        "x-amz-sns-topic-arn": envelope.TopicArn,
        "x-amz-sns-message-id": envelope.MessageId,
      },
      body: JSON.stringify(envelope),
    });
    delivered = res.ok;
  } catch {
    delivered = false;
  }

  if (!delivered) {
    deliverHttpFailureToDlq(store, subscription, envelope);
  }
}

function deliverHttpFailureToDlq(store: Store, subscription: SnsSubscription, envelope: SnsEnvelope): void {
  const redrivePolicy = subscription.attributes["RedrivePolicy"];
  if (!redrivePolicy) {
    return;
  }

  let deadLetterTargetArn: string | undefined;
  try {
    const parsed = JSON.parse(redrivePolicy) as { deadLetterTargetArn?: unknown };
    if (typeof parsed.deadLetterTargetArn === "string") {
      deadLetterTargetArn = parsed.deadLetterTargetArn;
    }
  } catch {
    return;
  }

  if (!deadLetterTargetArn) {
    return;
  }

  const queue = findQueueByEndpoint(store, deadLetterTargetArn);
  if (queue) {
    enqueueSqsMessage(store, queue, JSON.stringify(envelope));
  }
}

function findQueueByEndpoint(store: Store, endpoint: string): SqsQueue | undefined {
  const aws = getAwsStore(store);
  return aws.sqsQueues.findOneBy("arn", endpoint) ?? aws.sqsQueues.findOneBy("queue_url", endpoint);
}

function enqueueSqsMessage(store: Store, queue: SqsQueue, body: string): void {
  const aws = getAwsStore(store);
  const now = Date.now();
  aws.sqsMessages.insert({
    queue_name: queue.queue_name,
    message_id: generateMessageId(),
    receipt_handle: generateReceiptHandle(),
    body,
    md5_of_body: md5(body),
    attributes: {
      SentTimestamp: String(now),
      ApproximateReceiveCount: "0",
      ApproximateFirstReceiveTimestamp: "",
      SenderId: getAccountId(),
    },
    message_attributes: {},
    visible_after: now + queue.delay_seconds * 1000,
    sent_timestamp: now,
    receive_count: 0,
  });
}

function parseAttributeMap(params: Record<string, string>, prefix: string): Record<string, string> {
  const attrs: Record<string, string> = {};

  for (let i = 1; params[`Attribute.${i}.Name`]; i++) {
    const name = params[`Attribute.${i}.Name`];
    if (name) {
      attrs[name] = params[`Attribute.${i}.Value`] ?? "";
    }
  }

  for (let i = 1; params[`${prefix}.entry.${i}.key`] || params[`${prefix}.entry.${i}.Key`]; i++) {
    const key = params[`${prefix}.entry.${i}.key`] ?? params[`${prefix}.entry.${i}.Key`];
    if (key) {
      attrs[key] = params[`${prefix}.entry.${i}.value`] ?? params[`${prefix}.entry.${i}.Value`] ?? "";
    }
  }

  return attrs;
}

function parseMessageAttributes(params: Record<string, string>): Record<string, { Type: string; Value: string }> {
  const attrs: Record<string, { Type: string; Value: string }> = {};
  for (let i = 1; params[`MessageAttributes.entry.${i}.Name`]; i++) {
    const name = params[`MessageAttributes.entry.${i}.Name`];
    const type = params[`MessageAttributes.entry.${i}.Value.DataType`] ?? "String";
    const value =
      params[`MessageAttributes.entry.${i}.Value.StringValue`] ??
      params[`MessageAttributes.entry.${i}.Value.BinaryValue`] ??
      "";
    if (name) {
      attrs[name] = { Type: type, Value: value };
    }
  }
  return attrs;
}

function attributesXml(attrs: Record<string, string>): string {
  return Object.entries(attrs)
    .map(
      ([key, value]) => `      <entry>
        <key>${escapeXml(key)}</key>
        <value>${escapeXml(value)}</value>
      </entry>`,
    )
    .join("\n");
}
