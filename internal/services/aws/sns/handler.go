package sns

import (
	"crypto/md5"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	corestore "github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/services/aws/gateway"
	"github.com/vercel-labs/emulate/internal/services/aws/protocols"
)

type Handler struct {
	Topics        *corestore.Collection
	Subscriptions *corestore.Collection
	Deliveries    *corestore.Collection
	SQSQueues     *corestore.Collection
	SQSMessages   *corestore.Collection
	AccountID     string
	Region        string
	Now           func() time.Time
	IDGenerator   func(string) string
}

var fallbackIDCounter atomic.Uint64

func (h *Handler) Handle(_ *http.Request, ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	requestID := ctx.RequestID
	if requestID == "" {
		requestID = h.generateID("req")
	}
	var response protocols.ErrorResponse
	switch ctx.Action {
	case "CreateTopic":
		response = h.createTopic(ctx, requestID)
	case "DeleteTopic":
		response = h.deleteTopic(ctx, requestID)
	case "ListTopics":
		response = h.listTopics(ctx, requestID)
	case "GetTopicAttributes":
		response = h.getTopicAttributes(ctx, requestID)
	case "SetTopicAttributes":
		response = h.setTopicAttributes(ctx, requestID)
	case "TagResource":
		response = h.tagResource(ctx, requestID)
	case "UntagResource":
		response = h.untagResource(ctx, requestID)
	case "ListTagsForResource":
		response = h.listTagsForResource(ctx, requestID)
	case "Subscribe":
		response = h.subscribe(ctx, requestID)
	case "Unsubscribe":
		response = h.unsubscribe(ctx, requestID)
	case "ListSubscriptions":
		response = h.listSubscriptions(ctx, requestID)
	case "ListSubscriptionsByTopic":
		response = h.listSubscriptionsByTopic(ctx, requestID)
	case "Publish":
		response = h.publish(ctx, requestID)
	case "ConfirmSubscription":
		response = h.confirmSubscription(ctx, requestID)
	case "AddPermission":
		response = h.addPermission(ctx, requestID)
	case "RemovePermission":
		response = h.removePermission(ctx, requestID)
	default:
		response = h.queryError("InvalidAction", "The action "+ctx.Action+" is not valid for this endpoint.", http.StatusBadRequest, requestID)
	}
	return withRequestID(response, requestID)
}

func (h *Handler) createTopic(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	name := strings.TrimSpace(ctx.Query["Name"])
	if name == "" {
		return h.queryError("InvalidParameter", "Topic Name is required.", http.StatusBadRequest, requestID)
	}
	if existing, ok := h.findTopicByName(ctx, name); ok {
		return h.topicArnResponse("CreateTopic", stringField(existing, "arn"), requestID)
	}
	region := h.region(ctx)
	accountID := h.accountID(ctx)
	attributes := indexedAttributes(ctx.Query, "Attribute")
	for key, value := range entryMap(ctx.Query, "Attributes") {
		attributes[key] = value
	}
	if strings.HasSuffix(name, ".fifo") && attributes["FifoTopic"] == "" {
		attributes["FifoTopic"] = "true"
	}
	topic := h.Topics.Insert(corestore.Record{
		"account_id":  accountID,
		"region":      region,
		"topic_name":  name,
		"arn":         topicARN(region, accountID, name),
		"attributes":  attributes,
		"tags":        indexedTags(ctx.Query),
		"permissions": []corestore.Record{},
		"created_at":  h.now().Format(time.RFC3339Nano),
	})
	return h.topicArnResponse("CreateTopic", stringField(topic, "arn"), requestID)
}

func (h *Handler) deleteTopic(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	topic, ok := h.findTopicByARN(ctx, ctx.Query["TopicArn"])
	if ok {
		topicID := intField(topic, "id")
		topicARN := stringField(topic, "arn")
		for _, subscription := range h.Subscriptions.FindBy("topic_arn", topicARN) {
			h.Subscriptions.Delete(intField(subscription, "id"))
		}
		for _, delivery := range h.Deliveries.FindBy("topic_arn", topicARN) {
			h.Deliveries.Delete(intField(delivery, "id"))
		}
		h.Topics.Delete(topicID)
	}
	body := `<?xml version="1.0" encoding="UTF-8"?>
<DeleteTopicResponse>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</DeleteTopicResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) listTopics(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	var rows strings.Builder
	topics := h.scopedTopics(ctx)
	sort.Slice(topics, func(i int, j int) bool {
		return stringField(topics[i], "arn") < stringField(topics[j], "arn")
	})
	for _, topic := range topics {
		rows.WriteString(`      <member><TopicArn>`)
		rows.WriteString(xmlEscape(stringField(topic, "arn")))
		rows.WriteString(`</TopicArn></member>
`)
	}
	body := `<?xml version="1.0" encoding="UTF-8"?>
<ListTopicsResponse>
  <ListTopicsResult>
    <Topics>
` + strings.TrimRight(rows.String(), "\n") + `
    </Topics>
  </ListTopicsResult>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</ListTopicsResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) getTopicAttributes(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	topic, ok := h.findTopicByARN(ctx, ctx.Query["TopicArn"])
	if !ok {
		return h.notFound("Topic", requestID)
	}
	return h.attributesResponse("GetTopicAttributes", h.topicAttributes(topic), requestID)
}

func (h *Handler) setTopicAttributes(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	topic, ok := h.findTopicByARN(ctx, ctx.Query["TopicArn"])
	if !ok {
		return h.notFound("Topic", requestID)
	}
	name := strings.TrimSpace(ctx.Query["AttributeName"])
	if name == "" {
		return h.queryError("InvalidParameter", "AttributeName is required.", http.StatusBadRequest, requestID)
	}
	attrs := cloneStringMap(stringMapField(topic, "attributes"))
	attrs[name] = ctx.Query["AttributeValue"]
	h.Topics.Update(intField(topic, "id"), corestore.Record{"attributes": attrs})
	body := `<?xml version="1.0" encoding="UTF-8"?>
<SetTopicAttributesResponse>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</SetTopicAttributesResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) tagResource(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	topic, ok := h.findTopicByARN(ctx, ctx.Query["ResourceArn"])
	if !ok {
		return h.notFound("Topic", requestID)
	}
	updated := mergeTags(recordList(topic["tags"]), indexedTags(ctx.Query))
	h.Topics.Update(intField(topic, "id"), corestore.Record{"tags": updated})
	return h.emptyResponse("TagResource", requestID)
}

func (h *Handler) untagResource(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	topic, ok := h.findTopicByARN(ctx, ctx.Query["ResourceArn"])
	if !ok {
		return h.notFound("Topic", requestID)
	}
	tagKeys := indexedNames(ctx.Query, "TagKeys")
	if len(tagKeys) == 0 {
		tagKeys = indexedNames(ctx.Query, "TagKey")
	}
	updated := removeTags(recordList(topic["tags"]), tagKeys)
	h.Topics.Update(intField(topic, "id"), corestore.Record{"tags": updated})
	return h.emptyResponse("UntagResource", requestID)
}

func (h *Handler) listTagsForResource(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	topic, ok := h.findTopicByARN(ctx, ctx.Query["ResourceArn"])
	if !ok {
		return h.notFound("Topic", requestID)
	}
	var rows strings.Builder
	for _, tag := range recordList(topic["tags"]) {
		rows.WriteString(`      <member><Key>`)
		rows.WriteString(xmlEscape(stringField(tag, "Key")))
		rows.WriteString(`</Key><Value>`)
		rows.WriteString(xmlEscape(stringField(tag, "Value")))
		rows.WriteString(`</Value></member>
`)
	}
	body := `<?xml version="1.0" encoding="UTF-8"?>
<ListTagsForResourceResponse>
  <ListTagsForResourceResult>
    <Tags>
` + strings.TrimRight(rows.String(), "\n") + `
    </Tags>
  </ListTagsForResourceResult>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</ListTagsForResourceResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) subscribe(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	topic, ok := h.findTopicByARN(ctx, ctx.Query["TopicArn"])
	if !ok {
		return h.notFound("Topic", requestID)
	}
	protocol := strings.ToLower(strings.TrimSpace(ctx.Query["Protocol"]))
	endpoint := strings.TrimSpace(ctx.Query["Endpoint"])
	if protocol == "" || endpoint == "" {
		return h.queryError("InvalidParameter", "Protocol and Endpoint are required.", http.StatusBadRequest, requestID)
	}
	for _, subscription := range h.Subscriptions.FindBy("topic_arn", stringField(topic, "arn")) {
		if stringField(subscription, "protocol") == protocol && stringField(subscription, "endpoint") == endpoint {
			return h.subscriptionArnResponse("Subscribe", stringField(subscription, "subscription_arn"), requestID)
		}
	}
	subscriptionID := h.generateID("")
	subscriptionARN := stringField(topic, "arn") + ":" + subscriptionID
	subscription := h.Subscriptions.Insert(corestore.Record{
		"account_id":         h.accountID(ctx),
		"region":             h.region(ctx),
		"topic_arn":          stringField(topic, "arn"),
		"subscription_arn":   subscriptionARN,
		"subscription_id":    subscriptionID,
		"protocol":           protocol,
		"endpoint":           endpoint,
		"attributes":         subscriptionAttributes(ctx.Query),
		"confirmation_token": h.generateID("token"),
		"confirmed":          true,
		"created_at":         h.now().Format(time.RFC3339Nano),
	})
	return h.subscriptionArnResponse("Subscribe", stringField(subscription, "subscription_arn"), requestID)
}

func (h *Handler) unsubscribe(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	if subscription, ok := h.findSubscriptionByARN(ctx, ctx.Query["SubscriptionArn"]); ok {
		h.Subscriptions.Delete(intField(subscription, "id"))
	}
	return h.emptyResponse("Unsubscribe", requestID)
}

func (h *Handler) listSubscriptions(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	return h.subscriptionsResponse("ListSubscriptions", h.scopedSubscriptions(ctx), requestID)
}

func (h *Handler) listSubscriptionsByTopic(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	topic, ok := h.findTopicByARN(ctx, ctx.Query["TopicArn"])
	if !ok {
		return h.notFound("Topic", requestID)
	}
	subscriptions := h.Subscriptions.FindBy("topic_arn", stringField(topic, "arn"))
	return h.subscriptionsResponse("ListSubscriptionsByTopic", subscriptions, requestID)
}

func (h *Handler) publish(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	topic, ok := h.findTopicByARN(ctx, firstNonEmpty(ctx.Query["TopicArn"], ctx.Query["TargetArn"]))
	if !ok {
		return h.notFound("Topic", requestID)
	}
	message := ctx.Query["Message"]
	if message == "" {
		return h.queryError("InvalidParameter", "Message is required.", http.StatusBadRequest, requestID)
	}
	messageStructure := ctx.Query["MessageStructure"]
	if messageStructure != "" {
		if !strings.EqualFold(messageStructure, "json") {
			return h.queryError("InvalidParameter", "MessageStructure must be json.", http.StatusBadRequest, requestID)
		}
		if _, err := parseJSONMessage(message); err != nil {
			return h.queryError("InvalidParameter", err.Error(), http.StatusBadRequest, requestID)
		}
	}
	messageID := h.generateID("")
	subject := ctx.Query["Subject"]
	attrs := parseMessageAttributes(ctx.Query)
	delivered := 0
	for _, subscription := range h.Subscriptions.FindBy("topic_arn", stringField(topic, "arn")) {
		if !boolField(subscription, "confirmed") {
			continue
		}
		if h.deliverToSubscription(ctx, topic, subscription, messageID, subject, message, messageStructure, attrs) {
			delivered++
		}
	}
	h.Deliveries.Insert(corestore.Record{
		"account_id": h.accountID(ctx),
		"region":     h.region(ctx),
		"topic_arn":  stringField(topic, "arn"),
		"message_id": messageID,
		"delivered":  delivered,
		"created_at": h.now().Format(time.RFC3339Nano),
	})
	body := `<?xml version="1.0" encoding="UTF-8"?>
<PublishResponse>
  <PublishResult><MessageId>` + xmlEscape(messageID) + `</MessageId></PublishResult>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</PublishResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) confirmSubscription(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	topic, ok := h.findTopicByARN(ctx, ctx.Query["TopicArn"])
	if !ok {
		return h.notFound("Topic", requestID)
	}
	token := ctx.Query["Token"]
	if strings.TrimSpace(token) == "" {
		return h.queryError("InvalidParameter", "Token is required.", http.StatusBadRequest, requestID)
	}
	var selected corestore.Record
	for _, subscription := range h.Subscriptions.FindBy("topic_arn", stringField(topic, "arn")) {
		if stringField(subscription, "confirmation_token") == token {
			selected = subscription
			break
		}
	}
	if selected == nil {
		return h.notFound("Subscription", requestID)
	}
	updated, _ := h.Subscriptions.Update(intField(selected, "id"), corestore.Record{"confirmed": true})
	return h.subscriptionArnResponse("ConfirmSubscription", stringField(updated, "subscription_arn"), requestID)
}

func (h *Handler) addPermission(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	topic, ok := h.findTopicByARN(ctx, ctx.Query["TopicArn"])
	if !ok {
		return h.notFound("Topic", requestID)
	}
	label := strings.TrimSpace(ctx.Query["Label"])
	if label == "" {
		return h.queryError("InvalidParameter", "Label is required.", http.StatusBadRequest, requestID)
	}
	permissions := removePermission(recordList(topic["permissions"]), label)
	permissions = append(permissions, corestore.Record{
		"Label":        label,
		"AWSAccountId": indexedNames(ctx.Query, "AWSAccountId"),
		"ActionName":   indexedNames(ctx.Query, "ActionName"),
	})
	h.Topics.Update(intField(topic, "id"), corestore.Record{"permissions": permissions})
	return h.emptyResponse("AddPermission", requestID)
}

func (h *Handler) removePermission(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	topic, ok := h.findTopicByARN(ctx, ctx.Query["TopicArn"])
	if !ok {
		return h.notFound("Topic", requestID)
	}
	h.Topics.Update(intField(topic, "id"), corestore.Record{"permissions": removePermission(recordList(topic["permissions"]), ctx.Query["Label"])})
	return h.emptyResponse("RemovePermission", requestID)
}

func (h *Handler) deliverToSubscription(ctx gateway.AwsRequestContext, topic corestore.Record, subscription corestore.Record, messageID string, subject string, message string, messageStructure string, attrs corestore.Record) bool {
	switch stringField(subscription, "protocol") {
	case "sqs":
		queue, ok := h.findSQSQueue(stringField(subscription, "endpoint"))
		if !ok {
			return false
		}
		envelopeAttrs := attrs
		if strings.EqualFold(messageStructure, "json") {
			envelopeAttrs = corestore.Record{}
		}
		sqsAttrs := corestore.Record{}
		if strings.EqualFold(stringMapField(subscription, "attributes")["RawMessageDelivery"], "true") {
			sqsAttrs = envelopeAttrs
		}
		body := h.sqsBody(topic, subscription, messageID, subject, message, messageStructure, envelopeAttrs)
		now := h.nowMillis()
		sqsMessageID := h.generateID("")
		h.SQSMessages.Insert(corestore.Record{
			"queue_name":                stringField(queue, "queue_name"),
			"message_id":                sqsMessageID,
			"receipt_handle":            h.generateReceiptHandle(),
			"body":                      body,
			"md5_of_body":               md5Hex(body),
			"md5_of_message_attributes": md5OfMessageAttributes(sqsAttrs),
			"first_receive_timestamp":   int64(0),
			"attributes": corestore.Record{
				"SentTimestamp":                    strconv.FormatInt(now, 10),
				"ApproximateReceiveCount":          "0",
				"ApproximateFirstReceiveTimestamp": "",
				"SenderId":                         h.accountID(ctx),
			},
			"message_attributes": sqsAttrs,
			"visible_after":      now,
			"sent_timestamp":     now,
			"receive_count":      0,
		})
		h.Deliveries.Insert(corestore.Record{
			"account_id":       h.accountID(ctx),
			"region":           h.region(ctx),
			"topic_arn":        stringField(topic, "arn"),
			"subscription_arn": stringField(subscription, "subscription_arn"),
			"message_id":       messageID,
			"sqs_message_id":   sqsMessageID,
			"protocol":         "sqs",
			"endpoint":         stringField(subscription, "endpoint"),
			"created_at":       h.now().Format(time.RFC3339Nano),
		})
		return true
	default:
		h.Deliveries.Insert(corestore.Record{
			"account_id":       h.accountID(ctx),
			"region":           h.region(ctx),
			"topic_arn":        stringField(topic, "arn"),
			"subscription_arn": stringField(subscription, "subscription_arn"),
			"message_id":       messageID,
			"protocol":         stringField(subscription, "protocol"),
			"endpoint":         stringField(subscription, "endpoint"),
			"stubbed":          true,
			"created_at":       h.now().Format(time.RFC3339Nano),
		})
		return true
	}
}

func (h *Handler) sqsBody(topic corestore.Record, subscription corestore.Record, messageID string, subject string, message string, messageStructure string, attrs corestore.Record) string {
	if strings.EqualFold(stringMapField(subscription, "attributes")["RawMessageDelivery"], "true") {
		if strings.EqualFold(messageStructure, "json") {
			return jsonMessageForProtocol(message, "sqs")
		}
		return message
	}
	if strings.EqualFold(messageStructure, "json") {
		message = jsonMessageForProtocol(message, "sqs")
	}
	envelope := map[string]any{
		"Type":             "Notification",
		"MessageId":        messageID,
		"TopicArn":         stringField(topic, "arn"),
		"Message":          message,
		"Timestamp":        h.now().Format(time.RFC3339Nano),
		"SignatureVersion": "1",
		"Signature":        "",
		"SigningCertURL":   "",
		"UnsubscribeURL":   "",
	}
	if len(attrs) > 0 {
		envelope["MessageAttributes"] = snsEnvelopeMessageAttributes(attrs)
	}
	if subject != "" {
		envelope["Subject"] = subject
	}
	raw, _ := json.Marshal(envelope)
	return string(raw)
}

func snsEnvelopeMessageAttributes(attrs corestore.Record) corestore.Record {
	out := corestore.Record{}
	for name, rawValue := range attrs {
		value := recordValue(rawValue)
		dataType := stringField(value, "DataType")
		if dataType == "" {
			dataType = "String"
		}
		out[name] = corestore.Record{
			"Type":  dataType,
			"Value": firstNonEmpty(stringField(value, "StringValue"), stringField(value, "BinaryValue")),
		}
	}
	return out
}

func (h *Handler) topicAttributes(topic corestore.Record) map[string]string {
	attrs := cloneStringMap(stringMapField(topic, "attributes"))
	arn := stringField(topic, "arn")
	attrs["TopicArn"] = arn
	attrs["Owner"] = stringField(topic, "account_id")
	attrs["SubscriptionsConfirmed"] = strconv.Itoa(h.confirmedSubscriptionCount(arn))
	attrs["SubscriptionsPending"] = "0"
	attrs["SubscriptionsDeleted"] = "0"
	if attrs["Policy"] == "" {
		attrs["Policy"] = h.policyDocument(topic)
	}
	return attrs
}

func (h *Handler) confirmedSubscriptionCount(topicARN string) int {
	count := 0
	for _, subscription := range h.Subscriptions.FindBy("topic_arn", topicARN) {
		if boolField(subscription, "confirmed") {
			count++
		}
	}
	return count
}

func (h *Handler) policyDocument(topic corestore.Record) string {
	statements := []map[string]any{}
	for _, permission := range recordList(topic["permissions"]) {
		statements = append(statements, map[string]any{
			"Sid":       stringField(permission, "Label"),
			"Effect":    "Allow",
			"Principal": map[string]any{"AWS": stringSlice(permission["AWSAccountId"])},
			"Action":    stringSlice(permission["ActionName"]),
			"Resource":  stringField(topic, "arn"),
		})
	}
	body := map[string]any{
		"Version":   "2008-10-17",
		"Id":        stringField(topic, "arn") + "/policy",
		"Statement": statements,
	}
	raw, _ := json.Marshal(body)
	return string(raw)
}

func (h *Handler) findTopicByName(ctx gateway.AwsRequestContext, name string) (corestore.Record, bool) {
	for _, topic := range h.Topics.FindBy("topic_name", name) {
		if h.sameScope(ctx, topic) {
			return topic, true
		}
	}
	return nil, false
}

func (h *Handler) findTopicByARN(ctx gateway.AwsRequestContext, arn string) (corestore.Record, bool) {
	for _, topic := range h.Topics.FindBy("arn", arn) {
		if h.sameScope(ctx, topic) {
			return topic, true
		}
	}
	return nil, false
}

func (h *Handler) findSubscriptionByARN(ctx gateway.AwsRequestContext, arn string) (corestore.Record, bool) {
	for _, subscription := range h.Subscriptions.FindBy("subscription_arn", arn) {
		if stringField(subscription, "account_id") == h.accountID(ctx) && stringField(subscription, "region") == h.region(ctx) {
			return subscription, true
		}
	}
	return nil, false
}

func (h *Handler) findSQSQueue(endpoint string) (corestore.Record, bool) {
	for _, queue := range h.SQSQueues.All() {
		if stringField(queue, "arn") == endpoint || stringField(queue, "queue_url") == endpoint {
			return queue, true
		}
	}
	return nil, false
}

func (h *Handler) scopedTopics(ctx gateway.AwsRequestContext) []corestore.Record {
	topics := []corestore.Record{}
	for _, topic := range h.Topics.All() {
		if h.sameScope(ctx, topic) {
			topics = append(topics, topic)
		}
	}
	return topics
}

func (h *Handler) scopedSubscriptions(ctx gateway.AwsRequestContext) []corestore.Record {
	subscriptions := []corestore.Record{}
	for _, subscription := range h.Subscriptions.All() {
		if stringField(subscription, "account_id") == h.accountID(ctx) && stringField(subscription, "region") == h.region(ctx) {
			subscriptions = append(subscriptions, subscription)
		}
	}
	return subscriptions
}

func (h *Handler) sameScope(ctx gateway.AwsRequestContext, record corestore.Record) bool {
	return stringField(record, "account_id") == h.accountID(ctx) && stringField(record, "region") == h.region(ctx)
}

func (h *Handler) accountID(ctx gateway.AwsRequestContext) string {
	if ctx.AccountID != "" {
		return ctx.AccountID
	}
	if h.AccountID != "" {
		return h.AccountID
	}
	return gateway.DefaultAccountID
}

func (h *Handler) region(ctx gateway.AwsRequestContext) string {
	if ctx.Region != "" {
		return ctx.Region
	}
	if h.Region != "" {
		return h.Region
	}
	return gateway.DefaultRegion
}

func (h *Handler) now() time.Time {
	if h.Now != nil {
		return h.Now().UTC()
	}
	return time.Now().UTC()
}

func (h *Handler) nowMillis() int64 {
	return h.now().UnixNano() / int64(time.Millisecond)
}

func (h *Handler) generateID(prefix string) string {
	if h.IDGenerator != nil {
		return h.IDGenerator(prefix)
	}
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err == nil {
		return prefix + hex.EncodeToString(bytes[0:4]) + "-" + hex.EncodeToString(bytes[4:6]) + "-" + hex.EncodeToString(bytes[6:8]) + "-" + hex.EncodeToString(bytes[8:10]) + "-" + hex.EncodeToString(bytes[10:16])
	}
	return fmt.Sprintf("%s%d", prefix, fallbackIDCounter.Add(1))
}

func (h *Handler) generateReceiptHandle() string {
	var bytes [48]byte
	if _, err := rand.Read(bytes[:]); err == nil {
		return base64.RawURLEncoding.EncodeToString(bytes[:])
	}
	return fmt.Sprintf("receipt-%d", fallbackIDCounter.Add(1))
}

func topicARN(region string, accountID string, name string) string {
	return "arn:aws:sns:" + region + ":" + accountID + ":" + name
}

func (h *Handler) topicArnResponse(action string, arn string, requestID string) protocols.ErrorResponse {
	body := `<?xml version="1.0" encoding="UTF-8"?>
<` + action + `Response>
  <` + action + `Result><TopicArn>` + xmlEscape(arn) + `</TopicArn></` + action + `Result>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</` + action + `Response>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) subscriptionArnResponse(action string, arn string, requestID string) protocols.ErrorResponse {
	body := `<?xml version="1.0" encoding="UTF-8"?>
<` + action + `Response>
  <` + action + `Result><SubscriptionArn>` + xmlEscape(arn) + `</SubscriptionArn></` + action + `Result>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</` + action + `Response>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) attributesResponse(action string, attrs map[string]string, requestID string) protocols.ErrorResponse {
	keys := make([]string, 0, len(attrs))
	for key := range attrs {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var rows strings.Builder
	for _, key := range keys {
		rows.WriteString(`      <entry><key>`)
		rows.WriteString(xmlEscape(key))
		rows.WriteString(`</key><value>`)
		rows.WriteString(xmlEscape(attrs[key]))
		rows.WriteString(`</value></entry>
`)
	}
	body := `<?xml version="1.0" encoding="UTF-8"?>
<` + action + `Response>
  <` + action + `Result>
    <Attributes>
` + strings.TrimRight(rows.String(), "\n") + `
    </Attributes>
  </` + action + `Result>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</` + action + `Response>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) subscriptionsResponse(action string, subscriptions []corestore.Record, requestID string) protocols.ErrorResponse {
	sort.Slice(subscriptions, func(i int, j int) bool {
		return stringField(subscriptions[i], "subscription_arn") < stringField(subscriptions[j], "subscription_arn")
	})
	var rows strings.Builder
	for _, subscription := range subscriptions {
		rows.WriteString(`      <member>`)
		rows.WriteString(`<SubscriptionArn>` + xmlEscape(stringField(subscription, "subscription_arn")) + `</SubscriptionArn>`)
		rows.WriteString(`<Owner>` + xmlEscape(stringField(subscription, "account_id")) + `</Owner>`)
		rows.WriteString(`<Protocol>` + xmlEscape(stringField(subscription, "protocol")) + `</Protocol>`)
		rows.WriteString(`<Endpoint>` + xmlEscape(stringField(subscription, "endpoint")) + `</Endpoint>`)
		rows.WriteString(`<TopicArn>` + xmlEscape(stringField(subscription, "topic_arn")) + `</TopicArn>`)
		rows.WriteString(`</member>
`)
	}
	body := `<?xml version="1.0" encoding="UTF-8"?>
<` + action + `Response>
  <` + action + `Result>
    <Subscriptions>
` + strings.TrimRight(rows.String(), "\n") + `
    </Subscriptions>
  </` + action + `Result>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</` + action + `Response>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) emptyResponse(action string, requestID string) protocols.ErrorResponse {
	body := `<?xml version="1.0" encoding="UTF-8"?>
<` + action + `Response>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</` + action + `Response>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) notFound(kind string, requestID string) protocols.ErrorResponse {
	return h.queryError("NotFound", kind+" does not exist.", http.StatusNotFound, requestID)
}

func (h *Handler) queryError(code string, message string, status int, requestID string) protocols.ErrorResponse {
	return protocols.SerializeXMLError(protocols.AWSError{
		Code:       code,
		Message:    message,
		RequestID:  requestID,
		StatusCode: status,
	})
}

func xmlResponse(status int, body string) protocols.ErrorResponse {
	return protocols.ErrorResponse{
		StatusCode:  status,
		ContentType: "application/xml",
		Headers:     map[string]string{"Content-Type": "application/xml"},
		Body:        []byte(body),
	}
}

func withRequestID(response protocols.ErrorResponse, requestID string) protocols.ErrorResponse {
	if requestID == "" {
		return response
	}
	if response.Headers == nil {
		response.Headers = map[string]string{}
	}
	if response.Headers["x-amzn-requestid"] == "" {
		response.Headers["x-amzn-requestid"] = requestID
	}
	return response
}

func indexedAttributes(params map[string]string, prefix string) map[string]string {
	attrs := map[string]string{}
	for index := 1; ; index++ {
		name := params[prefix+"."+strconv.Itoa(index)+".Name"]
		if name == "" {
			break
		}
		attrs[name] = params[prefix+"."+strconv.Itoa(index)+".Value"]
	}
	return attrs
}

func indexedTags(params map[string]string) []corestore.Record {
	tags := []corestore.Record{}
	for _, prefix := range []string{"Tag", "Tags.member", "Tag.member"} {
		for index := 1; ; index++ {
			base := prefix + "." + strconv.Itoa(index)
			key := params[base+".Key"]
			if key == "" {
				break
			}
			tags = append(tags, corestore.Record{"Key": key, "Value": params[base+".Value"]})
		}
		if len(tags) > 0 {
			break
		}
	}
	return tags
}

func mergeTags(existing []corestore.Record, incoming []corestore.Record) []corestore.Record {
	values := map[string]string{}
	for _, tag := range existing {
		values[stringField(tag, "Key")] = stringField(tag, "Value")
	}
	for _, tag := range incoming {
		key := stringField(tag, "Key")
		if key != "" {
			values[key] = stringField(tag, "Value")
		}
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]corestore.Record, 0, len(keys))
	for _, key := range keys {
		out = append(out, corestore.Record{"Key": key, "Value": values[key]})
	}
	return out
}

func removeTags(existing []corestore.Record, keys []string) []corestore.Record {
	remove := map[string]bool{}
	for _, key := range keys {
		remove[key] = true
	}
	out := []corestore.Record{}
	for _, tag := range existing {
		if !remove[stringField(tag, "Key")] {
			out = append(out, tag)
		}
	}
	return out
}

func removePermission(existing []corestore.Record, label string) []corestore.Record {
	out := []corestore.Record{}
	for _, permission := range existing {
		if stringField(permission, "Label") != label {
			out = append(out, permission)
		}
	}
	return out
}

func subscriptionAttributes(params map[string]string) map[string]string {
	attrs := map[string]string{}
	for key, value := range entryMap(params, "Attributes") {
		attrs[key] = value
	}
	for key, value := range indexedAttributes(params, "Attribute") {
		attrs[key] = value
	}
	return attrs
}

func entryMap(params map[string]string, prefix string) map[string]string {
	attrs := map[string]string{}
	for _, entryPrefix := range []string{prefix + ".entry", prefix + ".Entry"} {
		for index := 1; ; index++ {
			base := entryPrefix + "." + strconv.Itoa(index)
			key := firstNonEmpty(params[base+".key"], params[base+".Key"], params[base+".Name"])
			if key == "" {
				break
			}
			attrs[key] = firstNonEmpty(params[base+".value"], params[base+".Value"])
		}
	}
	return attrs
}

func parseMessageAttributes(params map[string]string) corestore.Record {
	attrs := corestore.Record{}
	for _, prefix := range []string{"MessageAttributes.entry", "MessageAttribute"} {
		for index := 1; ; index++ {
			base := prefix + "." + strconv.Itoa(index)
			name := firstNonEmpty(params[base+".Name"], params[base+".key"])
			if name == "" {
				break
			}
			valuePrefix := base + ".Value"
			if strings.HasSuffix(prefix, ".entry") {
				valuePrefix = base + ".Value"
			}
			value := corestore.Record{
				"DataType": firstNonEmpty(params[valuePrefix+".DataType"], params[base+".value.DataType"]),
			}
			if stringValue := firstNonEmpty(params[valuePrefix+".StringValue"], params[base+".value.StringValue"]); stringValue != "" {
				value["StringValue"] = stringValue
			}
			if binaryValue := firstNonEmpty(params[valuePrefix+".BinaryValue"], params[base+".value.BinaryValue"]); binaryValue != "" {
				value["BinaryValue"] = binaryValue
			}
			attrs[name] = value
		}
	}
	return attrs
}

func indexedNames(params map[string]string, prefix string) []string {
	names := []string{}
	for _, format := range []string{prefix + ".member.", prefix + "."} {
		for index := 1; ; index++ {
			name := params[format+strconv.Itoa(index)]
			if name == "" {
				break
			}
			names = append(names, name)
		}
		if len(names) > 0 {
			break
		}
	}
	return names
}

func jsonMessageForProtocol(raw string, protocol string) string {
	body, err := parseJSONMessage(raw)
	if err != nil {
		return raw
	}
	if value, ok := body[protocol]; ok {
		return value
	}
	if value, ok := body["default"]; ok {
		return value
	}
	return raw
}

func parseJSONMessage(raw string) (map[string]string, error) {
	var body map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &body); err != nil {
		return nil, fmt.Errorf("MessageStructure json requires a valid JSON object.")
	}
	defaultRaw, ok := body["default"]
	if !ok {
		return nil, fmt.Errorf("MessageStructure json requires a default message.")
	}
	defaultValue, ok := jsonString(defaultRaw)
	if !ok {
		return nil, fmt.Errorf("MessageStructure json requires default to be a string.")
	}
	out := map[string]string{"default": defaultValue}
	for key, rawValue := range body {
		if key == "default" {
			continue
		}
		if value, ok := jsonString(rawValue); ok {
			out[key] = value
		}
	}
	return out, nil
}

func jsonString(raw json.RawMessage) (string, bool) {
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return value, true
}

func stringMapField(record corestore.Record, name string) map[string]string {
	out := map[string]string{}
	switch values := record[name].(type) {
	case map[string]string:
		for key, value := range values {
			out[key] = value
		}
	case map[string]any:
		for key, value := range values {
			out[key] = scalarString(value)
		}
	case corestore.Record:
		for key, value := range values {
			out[key] = scalarString(value)
		}
	}
	return out
}

func cloneStringMap(values map[string]string) map[string]string {
	out := map[string]string{}
	for key, value := range values {
		out[key] = value
	}
	return out
}

func recordList(raw any) []corestore.Record {
	switch values := raw.(type) {
	case []corestore.Record:
		return append([]corestore.Record(nil), values...)
	case []any:
		out := make([]corestore.Record, 0, len(values))
		for _, value := range values {
			if record := recordValue(value); len(record) > 0 {
				out = append(out, record)
			}
		}
		return out
	default:
		return nil
	}
}

func recordValue(value any) corestore.Record {
	switch typed := value.(type) {
	case corestore.Record:
		return typed
	case map[string]any:
		return corestore.Record(typed)
	default:
		return corestore.Record{}
	}
}

func stringSlice(value any) []string {
	switch typed := value.(type) {
	case []string:
		return append([]string(nil), typed...)
	case []any:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			out = append(out, scalarString(item))
		}
		return out
	default:
		return nil
	}
}

func scalarString(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case json.Number:
		return typed.String()
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(typed)
	default:
		return fmt.Sprint(typed)
	}
}

func stringField(record corestore.Record, name string) string {
	return scalarString(record[name])
}

func intField(record corestore.Record, name string) int {
	switch value := record[name].(type) {
	case int:
		return value
	case int64:
		return int(value)
	case float64:
		return int(value)
	default:
		return 0
	}
}

func boolField(record corestore.Record, name string) bool {
	value, _ := record[name].(bool)
	return value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func md5Hex(value string) string {
	sum := md5.Sum([]byte(value))
	return hex.EncodeToString(sum[:])
}

func md5OfMessageAttributes(attrs corestore.Record) string {
	if len(attrs) == 0 {
		return ""
	}
	hasher := md5.New()
	keys := make([]string, 0, len(attrs))
	for key := range attrs {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, name := range keys {
		value := recordValue(attrs[name])
		dataType := stringField(value, "DataType")
		if dataType == "" {
			dataType = "String"
		}
		writeMD5LengthPrefixedString(hasher, name)
		writeMD5LengthPrefixedString(hasher, dataType)
		if strings.HasPrefix(dataType, "Binary") {
			hasher.Write([]byte{2})
			writeMD5LengthPrefixedBytes(hasher, messageAttributeBinaryBytes(stringField(value, "BinaryValue")))
			continue
		}
		hasher.Write([]byte{1})
		writeMD5LengthPrefixedString(hasher, stringField(value, "StringValue"))
	}
	return hex.EncodeToString(hasher.Sum(nil))
}

func writeMD5LengthPrefixedString(hasher hash.Hash, value string) {
	writeMD5LengthPrefixedBytes(hasher, []byte(value))
}

func writeMD5LengthPrefixedBytes(hasher hash.Hash, value []byte) {
	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(value)))
	hasher.Write(length[:])
	hasher.Write(value)
}

func messageAttributeBinaryBytes(value string) []byte {
	if value == "" {
		return nil
	}
	for _, encoding := range []*base64.Encoding{
		base64.StdEncoding,
		base64.RawStdEncoding,
		base64.URLEncoding,
		base64.RawURLEncoding,
	} {
		if decoded, err := encoding.DecodeString(value); err == nil {
			return decoded
		}
	}
	return []byte(value)
}

func xmlEscape(value string) string {
	replacer := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		`"`, "&quot;",
		"'", "&apos;",
	)
	return replacer.Replace(value)
}
