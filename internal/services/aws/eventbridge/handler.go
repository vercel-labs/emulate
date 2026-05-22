package eventbridge

import (
	"crypto/md5"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	corestore "github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/services/aws/gateway"
	awslambda "github.com/vercel-labs/emulate/internal/services/aws/lambda"
	"github.com/vercel-labs/emulate/internal/services/aws/protocols"
)

const jsonContentType = "application/x-amz-json-1.1"

type eventBusRef struct {
	Raw       string
	Name      string
	Region    string
	AccountID string
	IsARN     bool
}

type Handler struct {
	EventBuses               *corestore.Collection
	EventRules               *corestore.Collection
	EventTargets             *corestore.Collection
	EventDeliveries          *corestore.Collection
	SQSQueues                *corestore.Collection
	SQSMessages              *corestore.Collection
	SNSTopics                *corestore.Collection
	SNSSubscriptions         *corestore.Collection
	SNSDeliveries            *corestore.Collection
	LambdaFunctions          *corestore.Collection
	LambdaVersions           *corestore.Collection
	LambdaAliases            *corestore.Collection
	LogGroups                *corestore.Collection
	LogStreams               *corestore.Collection
	LogEvents                *corestore.Collection
	LambdaLocalCodeExecution bool
	AccountID                string
	Region                   string
	Now                      func() time.Time
	IDGenerator              func(string) string
}

var fallbackIDCounter atomic.Uint64

func (h *Handler) Handle(req *http.Request, ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	requestID := ctx.RequestID
	if requestID == "" {
		requestID = h.generateID("req")
	}
	var response protocols.ErrorResponse
	switch ctx.Action {
	case "CreateEventBus":
		response = h.createEventBus(ctx, requestID)
	case "DeleteEventBus":
		response = h.deleteEventBus(ctx, requestID)
	case "ListEventBuses":
		response = h.listEventBuses(ctx, requestID)
	case "PutRule":
		response = h.putRule(ctx, requestID)
	case "DescribeRule":
		response = h.describeRule(ctx, requestID)
	case "ListRules":
		response = h.listRules(ctx, requestID)
	case "DeleteRule":
		response = h.deleteRule(ctx, requestID)
	case "EnableRule":
		response = h.setRuleState(ctx, requestID, "ENABLED")
	case "DisableRule":
		response = h.setRuleState(ctx, requestID, "DISABLED")
	case "PutTargets":
		response = h.putTargets(ctx, requestID)
	case "ListTargetsByRule":
		response = h.listTargetsByRule(ctx, requestID)
	case "RemoveTargets":
		response = h.removeTargets(ctx, requestID)
	case "PutEvents":
		response = h.putEvents(req, ctx, requestID)
	case "TagResource":
		response = h.tagResource(ctx, requestID)
	case "UntagResource":
		response = h.untagResource(ctx, requestID)
	case "ListTagsForResource":
		response = h.listTagsForResource(ctx, requestID)
	default:
		response = h.error("NotImplementedException", fmt.Sprintf("events.%s is not implemented in the native Go runtime yet.", ctx.Action), http.StatusNotImplemented, requestID)
	}
	return withRequestID(response, requestID)
}

func (h *Handler) createEventBus(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	name := strings.TrimSpace(stringInput(ctx.Input, "Name"))
	if name == "" {
		return h.validation("Name is required.", requestID)
	}
	if strings.Contains(name, ":event-bus/") {
		return h.validation("Name must be an event bus name, not an ARN.", requestID)
	}
	if name == "default" {
		return h.error("ResourceAlreadyExistsException", "Event bus default already exists.", http.StatusBadRequest, requestID)
	}
	if _, ok := h.findBus(ctx, name); ok {
		return h.error("ResourceAlreadyExistsException", "Event bus "+name+" already exists.", http.StatusBadRequest, requestID)
	}
	arn := busARN(h.region(ctx), h.accountID(ctx), name)
	bus := h.EventBuses.Insert(corestore.Record{
		"account_id": h.accountID(ctx),
		"region":     h.region(ctx),
		"name":       name,
		"arn":        arn,
		"tags":       tagsFromInput(ctx.Input["Tags"]),
	})
	return jsonResponse(http.StatusOK, map[string]any{"EventBusArn": stringField(bus, "arn")})
}

func (h *Handler) deleteEventBus(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	ref := eventBusReference(ctx.Input["Name"])
	if ref.Name == "" {
		return h.validation("Name is required.", requestID)
	}
	if ref.Name == "default" {
		return h.validation("Cannot delete default event bus.", requestID)
	}
	bus, response, ok := h.requireBus(ctx, ctx.Input["Name"], requestID)
	if !ok {
		return response
	}
	name := stringField(bus, "name")
	for _, rule := range h.EventRules.FindBy("event_bus_name", name) {
		if h.sameScope(ctx, rule) {
			h.deleteRuleTargets(ctx, stringField(rule, "event_bus_name"), stringField(rule, "name"))
			h.EventRules.Delete(intField(rule, "id"))
		}
	}
	h.EventBuses.Delete(intField(bus, "id"))
	return jsonResponse(http.StatusOK, map[string]any{})
}

func (h *Handler) listEventBuses(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	h.ensureDefaultBus(ctx)
	prefix := stringInput(ctx.Input, "NamePrefix")
	buses := []corestore.Record{}
	for _, bus := range h.EventBuses.All() {
		if !h.sameScope(ctx, bus) {
			continue
		}
		if prefix != "" && !strings.HasPrefix(stringField(bus, "name"), prefix) {
			continue
		}
		buses = append(buses, bus)
	}
	sort.Slice(buses, func(i int, j int) bool {
		return stringField(buses[i], "name") < stringField(buses[j], "name")
	})
	start, end, nextToken, response, ok := h.pageBounds(ctx.Input, len(buses), requestID)
	if !ok {
		return response
	}
	out := make([]map[string]any, 0, end-start)
	for _, bus := range buses[start:end] {
		out = append(out, map[string]any{"Name": stringField(bus, "name"), "Arn": stringField(bus, "arn")})
	}
	body := map[string]any{"EventBuses": out}
	if nextToken != "" {
		body["NextToken"] = nextToken
	}
	return jsonResponse(http.StatusOK, body)
}

func (h *Handler) putRule(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	name := strings.TrimSpace(stringInput(ctx.Input, "Name"))
	if name == "" {
		return h.validation("Name is required.", requestID)
	}
	bus, response, ok := h.requireBus(ctx, eventBusValue(ctx.Input), requestID)
	if !ok {
		return response
	}
	busName := stringField(bus, "name")
	eventPattern := strings.TrimSpace(stringInput(ctx.Input, "EventPattern"))
	scheduleExpression := strings.TrimSpace(stringInput(ctx.Input, "ScheduleExpression"))
	if eventPattern == "" && scheduleExpression == "" {
		return h.validation("EventPattern or ScheduleExpression is required.", requestID)
	}
	if eventPattern != "" && !validJSONObject(eventPattern) {
		return h.validation("EventPattern must be a valid JSON object.", requestID)
	}
	state := strings.ToUpper(strings.TrimSpace(stringInput(ctx.Input, "State")))
	if state == "" {
		state = "ENABLED"
	}
	if state != "ENABLED" && state != "DISABLED" && state != "ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS" {
		return h.validation("State must be ENABLED, DISABLED, or ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS.", requestID)
	}
	arn := ruleARN(h.region(ctx), h.accountID(ctx), busName, name)
	record := corestore.Record{
		"account_id":           h.accountID(ctx),
		"region":               h.region(ctx),
		"name":                 name,
		"arn":                  arn,
		"event_bus_name":       busName,
		"event_pattern":        eventPattern,
		"schedule_expression":  scheduleExpression,
		"state":                state,
		"description":          stringInput(ctx.Input, "Description"),
		"role_arn":             stringInput(ctx.Input, "RoleArn"),
		"managed_by":           stringInput(ctx.Input, "ManagedBy"),
		"tags":                 tagsFromInput(ctx.Input["Tags"]),
		"event_pattern_parsed": parsePattern(eventPattern),
	}
	if existing, ok := h.findRule(ctx, busName, name); ok {
		record["tags"] = recordList(existing["tags"])
		h.EventRules.Update(intField(existing, "id"), record)
	} else {
		h.EventRules.Insert(record)
	}
	return jsonResponse(http.StatusOK, map[string]any{"RuleArn": arn})
}

func (h *Handler) describeRule(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	rule, response, ok := h.requireRule(ctx, eventBusValue(ctx.Input), stringInput(ctx.Input, "Name"), requestID)
	if !ok {
		return response
	}
	return jsonResponse(http.StatusOK, h.ruleResponse(rule))
}

func (h *Handler) listRules(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	bus, response, ok := h.requireBus(ctx, eventBusValue(ctx.Input), requestID)
	if !ok {
		return response
	}
	busName := stringField(bus, "name")
	prefix := stringInput(ctx.Input, "NamePrefix")
	rules := []corestore.Record{}
	for _, rule := range h.EventRules.FindBy("event_bus_name", busName) {
		if !h.sameScope(ctx, rule) {
			continue
		}
		if prefix != "" && !strings.HasPrefix(stringField(rule, "name"), prefix) {
			continue
		}
		rules = append(rules, rule)
	}
	sort.Slice(rules, func(i int, j int) bool {
		return stringField(rules[i], "name") < stringField(rules[j], "name")
	})
	start, end, nextToken, response, ok := h.pageBounds(ctx.Input, len(rules), requestID)
	if !ok {
		return response
	}
	out := make([]map[string]any, 0, end-start)
	for _, rule := range rules[start:end] {
		out = append(out, h.ruleResponse(rule))
	}
	body := map[string]any{"Rules": out}
	if nextToken != "" {
		body["NextToken"] = nextToken
	}
	return jsonResponse(http.StatusOK, body)
}

func (h *Handler) deleteRule(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	rule, response, ok := h.requireRule(ctx, eventBusValue(ctx.Input), stringInput(ctx.Input, "Name"), requestID)
	if !ok {
		return response
	}
	busName := stringField(rule, "event_bus_name")
	if len(h.targetsForRule(ctx, busName, stringField(rule, "name"))) > 0 {
		return h.validation("Rule can't be deleted since it has targets.", requestID)
	}
	h.EventRules.Delete(intField(rule, "id"))
	return jsonResponse(http.StatusOK, map[string]any{})
}

func (h *Handler) setRuleState(ctx gateway.AwsRequestContext, requestID string, state string) protocols.ErrorResponse {
	rule, response, ok := h.requireRule(ctx, eventBusValue(ctx.Input), stringInput(ctx.Input, "Name"), requestID)
	if !ok {
		return response
	}
	h.EventRules.Update(intField(rule, "id"), corestore.Record{"state": state})
	return jsonResponse(http.StatusOK, map[string]any{})
}

func (h *Handler) putTargets(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	rule, response, ok := h.requireRule(ctx, eventBusValue(ctx.Input), stringInput(ctx.Input, "Rule"), requestID)
	if !ok {
		return response
	}
	busName := stringField(rule, "event_bus_name")
	targets := mapSlice(ctx.Input["Targets"])
	if len(targets) == 0 {
		return h.validation("Targets is required.", requestID)
	}
	for _, target := range targets {
		targetID := strings.TrimSpace(stringValue(target["Id"]))
		targetARN := strings.TrimSpace(stringValue(target["Arn"]))
		if targetID == "" || targetARN == "" {
			return h.validation("Target Id and Arn are required.", requestID)
		}
		if strings.TrimSpace(stringValue(target["InputPath"])) != "" {
			return h.validation("Target InputPath is not supported in the native Go runtime yet.", requestID)
		}
		if _, ok := target["InputTransformer"]; ok {
			return h.validation("Target InputTransformer is not supported in the native Go runtime yet.", requestID)
		}
		record := corestore.Record{
			"account_id":     h.accountID(ctx),
			"region":         h.region(ctx),
			"event_bus_name": busName,
			"rule_name":      stringField(rule, "name"),
			"target_id":      targetID,
			"arn":            targetARN,
			"input":          stringValue(target["Input"]),
			"role_arn":       stringValue(target["RoleArn"]),
		}
		if existing, ok := h.findTarget(ctx, busName, stringField(rule, "name"), targetID); ok {
			h.EventTargets.Update(intField(existing, "id"), record)
		} else {
			h.EventTargets.Insert(record)
		}
	}
	return jsonResponse(http.StatusOK, map[string]any{"FailedEntryCount": 0, "FailedEntries": []any{}})
}

func (h *Handler) listTargetsByRule(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	rule, response, ok := h.requireRule(ctx, eventBusValue(ctx.Input), stringInput(ctx.Input, "Rule"), requestID)
	if !ok {
		return response
	}
	busName := stringField(rule, "event_bus_name")
	targets := []map[string]any{}
	for _, target := range h.targetsForRule(ctx, busName, stringField(rule, "name")) {
		item := map[string]any{"Id": stringField(target, "target_id"), "Arn": stringField(target, "arn")}
		if input := stringField(target, "input"); input != "" {
			item["Input"] = input
		}
		if roleARN := stringField(target, "role_arn"); roleARN != "" {
			item["RoleArn"] = roleARN
		}
		targets = append(targets, item)
	}
	sort.Slice(targets, func(i int, j int) bool {
		return stringValue(targets[i]["Id"]) < stringValue(targets[j]["Id"])
	})
	start, end, nextToken, pageResponse, ok := h.pageBounds(ctx.Input, len(targets), requestID)
	if !ok {
		return pageResponse
	}
	body := map[string]any{"Targets": targets[start:end]}
	if nextToken != "" {
		body["NextToken"] = nextToken
	}
	return jsonResponse(http.StatusOK, body)
}

func (h *Handler) removeTargets(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	rule, response, ok := h.requireRule(ctx, eventBusValue(ctx.Input), stringInput(ctx.Input, "Rule"), requestID)
	if !ok {
		return response
	}
	busName := stringField(rule, "event_bus_name")
	for _, id := range stringSlice(ctx.Input["Ids"]) {
		if target, ok := h.findTarget(ctx, busName, stringField(rule, "name"), id); ok {
			h.EventTargets.Delete(intField(target, "id"))
		}
	}
	return jsonResponse(http.StatusOK, map[string]any{"FailedEntryCount": 0, "FailedEntries": []any{}})
}

func (h *Handler) putEvents(req *http.Request, ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	entries := mapSlice(ctx.Input["Entries"])
	if len(entries) == 0 {
		return h.validation("Entries is required.", requestID)
	}
	if len(entries) > 10 {
		return h.validation("Entries can contain at most 10 items.", requestID)
	}
	out := make([]map[string]any, 0, len(entries))
	failed := 0
	for _, entry := range entries {
		busValue := firstNonEmpty(stringValue(entry["EventBusName"]), "default")
		ref := eventBusReference(busValue)
		if ref.Name == "default" && h.eventBusReferenceMatchesCaller(ctx, ref) {
			h.ensureDefaultBus(ctx)
		}
		bus, ok := h.findBus(ctx, busValue)
		if !ok {
			failed++
			out = append(out, map[string]any{"ErrorCode": "ResourceNotFoundException", "ErrorMessage": "Event bus " + eventBusDisplayName(ref) + " does not exist."})
			continue
		}
		busName := stringField(bus, "name")
		source := stringValue(entry["Source"])
		detailType := stringValue(entry["DetailType"])
		detailText := stringValue(entry["Detail"])
		if strings.TrimSpace(source) == "" || strings.TrimSpace(detailType) == "" || strings.TrimSpace(detailText) == "" {
			failed++
			out = append(out, map[string]any{"ErrorCode": "InvalidArgument", "ErrorMessage": "Detail, DetailType, and Source are required."})
			continue
		}
		detail, ok := parseDetail(detailText)
		if !ok {
			failed++
			out = append(out, map[string]any{"ErrorCode": "MalformedDetail", "ErrorMessage": "Detail is not valid JSON."})
			continue
		}
		eventID := h.generateID("evt")
		event := map[string]any{
			"version":     "0",
			"id":          eventID,
			"detail-type": detailType,
			"source":      source,
			"account":     h.accountID(ctx),
			"time":        eventTime(entry["Time"], h.now()).UTC().Format(time.RFC3339),
			"region":      h.region(ctx),
			"resources":   stringSlice(entry["Resources"]),
			"detail":      detail,
		}
		h.deliverEvent(req, ctx, busName, eventID, event)
		out = append(out, map[string]any{"EventId": eventID})
	}
	return jsonResponse(http.StatusOK, map[string]any{"FailedEntryCount": failed, "Entries": out})
}

func (h *Handler) tagResource(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	record, response, ok := h.requireTaggableResource(ctx, stringInput(ctx.Input, "ResourceARN"), requestID)
	if !ok {
		return response
	}
	collection := h.collectionForResource(record)
	tags := mergeTags(recordList(record["tags"]), tagsFromInput(ctx.Input["Tags"]))
	collection.Update(intField(record, "id"), corestore.Record{"tags": tags})
	return jsonResponse(http.StatusOK, map[string]any{})
}

func (h *Handler) untagResource(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	record, response, ok := h.requireTaggableResource(ctx, stringInput(ctx.Input, "ResourceARN"), requestID)
	if !ok {
		return response
	}
	collection := h.collectionForResource(record)
	tags := removeTags(recordList(record["tags"]), stringSlice(ctx.Input["TagKeys"]))
	collection.Update(intField(record, "id"), corestore.Record{"tags": tags})
	return jsonResponse(http.StatusOK, map[string]any{})
}

func (h *Handler) listTagsForResource(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	record, response, ok := h.requireTaggableResource(ctx, stringInput(ctx.Input, "ResourceARN"), requestID)
	if !ok {
		return response
	}
	return jsonResponse(http.StatusOK, map[string]any{"Tags": recordList(record["tags"])})
}

func (h *Handler) deliverEvent(req *http.Request, ctx gateway.AwsRequestContext, busName string, eventID string, event map[string]any) {
	for _, rule := range h.EventRules.FindBy("event_bus_name", busName) {
		if !h.sameScope(ctx, rule) || stringField(rule, "state") == "DISABLED" || !matchesPattern(rule, event) {
			continue
		}
		for _, target := range h.EventTargets.FindBy("rule_name", stringField(rule, "name")) {
			if !h.sameScope(ctx, target) || stringField(target, "event_bus_name") != busName {
				continue
			}
			body := h.targetBody(target, event)
			status := "NO_TARGET"
			switch {
			case h.deliverToSQS(ctx, target, body):
				status = "DELIVERED"
			case h.deliverToSNS(ctx, target, body):
				status = "DELIVERED"
			case h.deliverToLambda(req, ctx, target, body):
				status = "DELIVERED"
			}
			h.EventDeliveries.Insert(corestore.Record{
				"account_id":      h.accountID(ctx),
				"region":          h.region(ctx),
				"event_bus_name":  busName,
				"rule_name":       stringField(rule, "name"),
				"target_id":       stringField(target, "target_id"),
				"target_arn":      stringField(target, "arn"),
				"event_id":        eventID,
				"status":          status,
				"body":            body,
				"delivered_at_ms": h.now().UnixMilli(),
			})
		}
	}
}

func (h *Handler) deliverToSQS(ctx gateway.AwsRequestContext, target corestore.Record, body string) bool {
	queue, ok := h.findSQSQueue(stringField(target, "arn"))
	if !ok || len([]byte(body)) > intField(queue, "max_message_size") {
		return false
	}
	now := h.now().UnixMilli()
	h.SQSMessages.Insert(corestore.Record{
		"queue_name":                stringField(queue, "queue_name"),
		"message_id":                h.generateID("msg"),
		"receipt_handle":            h.generateID("receipt"),
		"body":                      body,
		"md5_of_body":               md5Hex(body),
		"md5_of_message_attributes": "",
		"first_receive_timestamp":   int64(0),
		"attributes": corestore.Record{
			"SentTimestamp":                    strconv.FormatInt(now, 10),
			"ApproximateReceiveCount":          "0",
			"ApproximateFirstReceiveTimestamp": "",
			"SenderId":                         h.accountID(ctx),
		},
		"message_attributes": corestore.Record{},
		"visible_after":      now + int64(intField(queue, "delay_seconds"))*1000,
		"sent_timestamp":     now,
		"receive_count":      0,
	})
	return true
}

func (h *Handler) deliverToSNS(ctx gateway.AwsRequestContext, target corestore.Record, body string) bool {
	topic, ok := h.findSNSTopic(ctx, stringField(target, "arn"))
	if !ok {
		return false
	}
	messageID := h.generateID("sns")
	delivered := false
	for _, subscription := range h.SNSSubscriptions.FindBy("topic_arn", stringField(topic, "arn")) {
		if strings.ToLower(stringField(subscription, "protocol")) != "sqs" {
			continue
		}
		queue, ok := h.findSQSQueue(stringField(subscription, "endpoint"))
		if !ok {
			continue
		}
		sqsBody := h.snsSQSBody(topic, subscription, messageID, body)
		if len([]byte(sqsBody)) > intField(queue, "max_message_size") {
			continue
		}
		now := h.now().UnixMilli()
		sqsMessageID := h.generateID("msg")
		h.SQSMessages.Insert(corestore.Record{
			"queue_name":                stringField(queue, "queue_name"),
			"message_id":                sqsMessageID,
			"receipt_handle":            h.generateID("receipt"),
			"body":                      sqsBody,
			"md5_of_body":               md5Hex(sqsBody),
			"md5_of_message_attributes": "",
			"first_receive_timestamp":   int64(0),
			"attributes": corestore.Record{
				"SentTimestamp":                    strconv.FormatInt(now, 10),
				"ApproximateReceiveCount":          "0",
				"ApproximateFirstReceiveTimestamp": "",
				"SenderId":                         h.accountID(ctx),
			},
			"message_attributes": corestore.Record{},
			"visible_after":      now + int64(intField(queue, "delay_seconds"))*1000,
			"sent_timestamp":     now,
			"receive_count":      0,
		})
		h.SNSDeliveries.Insert(corestore.Record{
			"message_id":       messageID,
			"sqs_message_id":   sqsMessageID,
			"topic_arn":        stringField(topic, "arn"),
			"subscription_arn": stringField(subscription, "subscription_arn"),
			"protocol":         "sqs",
			"endpoint":         stringField(subscription, "endpoint"),
			"status":           "SUCCESS",
		})
		delivered = true
	}
	return delivered
}

func (h *Handler) deliverToLambda(req *http.Request, ctx gateway.AwsRequestContext, target corestore.Record, body string) bool {
	if h.LambdaFunctions == nil {
		return false
	}
	lambdaHandler := awslambda.Handler{
		Functions:               h.LambdaFunctions,
		Versions:                h.LambdaVersions,
		Aliases:                 h.LambdaAliases,
		LogGroups:               h.LogGroups,
		LogStreams:              h.LogStreams,
		LogEvents:               h.LogEvents,
		AccountID:               h.AccountID,
		Region:                  h.Region,
		AllowLocalCodeExecution: h.LambdaLocalCodeExecution,
		Now:                     h.Now,
		IDGenerator:             h.IDGenerator,
	}
	_, ok := lambdaHandler.InvokeFromEventSource(req, ctx, stringField(target, "arn"), []byte(body), h.generateID("req"), "EventBridge")
	return ok
}

func (h *Handler) snsSQSBody(topic corestore.Record, subscription corestore.Record, messageID string, message string) string {
	if strings.EqualFold(stringMapField(subscription, "attributes")["RawMessageDelivery"], "true") {
		return message
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
	raw, _ := json.Marshal(envelope)
	return string(raw)
}

func (h *Handler) targetBody(target corestore.Record, event map[string]any) string {
	if input := stringField(target, "input"); input != "" {
		return input
	}
	raw, _ := json.Marshal(event)
	return string(raw)
}

func (h *Handler) ruleResponse(rule corestore.Record) map[string]any {
	out := map[string]any{
		"Name":         stringField(rule, "name"),
		"Arn":          stringField(rule, "arn"),
		"EventBusName": stringField(rule, "event_bus_name"),
		"State":        stringField(rule, "state"),
	}
	if value := stringField(rule, "event_pattern"); value != "" {
		out["EventPattern"] = value
	}
	if value := stringField(rule, "schedule_expression"); value != "" {
		out["ScheduleExpression"] = value
	}
	if value := stringField(rule, "description"); value != "" {
		out["Description"] = value
	}
	if value := stringField(rule, "role_arn"); value != "" {
		out["RoleArn"] = value
	}
	if value := stringField(rule, "managed_by"); value != "" {
		out["ManagedBy"] = value
	}
	return out
}

func (h *Handler) requireBus(ctx gateway.AwsRequestContext, value any, requestID string) (corestore.Record, protocols.ErrorResponse, bool) {
	ref := eventBusReference(value)
	if ref.Name == "" {
		ref = eventBusReference("default")
	}
	bus, ok := h.findBus(ctx, ref.Raw)
	if !ok {
		if ref.Name == "default" && h.eventBusReferenceMatchesCaller(ctx, ref) {
			return h.insertDefaultBus(ctx), protocols.ErrorResponse{}, true
		}
		return nil, h.notFound("Event bus "+eventBusDisplayName(ref)+" does not exist.", requestID), false
	}
	return bus, protocols.ErrorResponse{}, true
}

func (h *Handler) requireRule(ctx gateway.AwsRequestContext, busName string, ruleName string, requestID string) (corestore.Record, protocols.ErrorResponse, bool) {
	ruleName = strings.TrimSpace(ruleName)
	if ruleName == "" {
		return nil, h.validation("Name or Rule is required.", requestID), false
	}
	rule, ok := h.findRule(ctx, busName, ruleName)
	if !ok {
		return nil, h.notFound("Rule "+ruleName+" does not exist on event bus "+eventBusDisplayName(eventBusReference(busName))+".", requestID), false
	}
	return rule, protocols.ErrorResponse{}, true
}

func (h *Handler) pageBounds(input map[string]any, total int, requestID string) (int, int, string, protocols.ErrorResponse, bool) {
	limit := intInput(input, "Limit", total)
	if limit <= 0 {
		limit = total
	}
	if limit > 100 {
		limit = 100
	}
	start := 0
	if raw := strings.TrimSpace(stringInput(input, "NextToken")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 0 || parsed > total {
			return 0, 0, "", h.error("InvalidToken", "NextToken is invalid.", http.StatusBadRequest, requestID), false
		}
		start = parsed
	}
	end := start + limit
	if end > total {
		end = total
	}
	nextToken := ""
	if end < total {
		nextToken = strconv.Itoa(end)
	}
	return start, end, nextToken, protocols.ErrorResponse{}, true
}

func (h *Handler) findBus(ctx gateway.AwsRequestContext, value any) (corestore.Record, bool) {
	ref := eventBusReference(value)
	if ref.Name == "" || !h.eventBusReferenceMatchesCaller(ctx, ref) {
		return nil, false
	}
	for _, bus := range h.EventBuses.FindBy("name", ref.Name) {
		if h.sameScope(ctx, bus) {
			return bus, true
		}
	}
	return nil, false
}

func (h *Handler) ensureDefaultBus(ctx gateway.AwsRequestContext) corestore.Record {
	if bus, ok := h.findBus(ctx, "default"); ok {
		return bus
	}
	return h.insertDefaultBus(ctx)
}

func (h *Handler) insertDefaultBus(ctx gateway.AwsRequestContext) corestore.Record {
	return h.EventBuses.Insert(corestore.Record{
		"account_id": h.accountID(ctx),
		"region":     h.region(ctx),
		"name":       "default",
		"arn":        busARN(h.region(ctx), h.accountID(ctx), "default"),
		"tags":       []corestore.Record{},
	})
}

func (h *Handler) findRule(ctx gateway.AwsRequestContext, busName string, ruleName string) (corestore.Record, bool) {
	ref := eventBusReference(firstNonEmpty(busName, "default"))
	if ref.Name == "" || !h.eventBusReferenceMatchesCaller(ctx, ref) {
		return nil, false
	}
	for _, rule := range h.EventRules.FindBy("name", ruleName) {
		if stringField(rule, "event_bus_name") == ref.Name && h.sameScope(ctx, rule) {
			return rule, true
		}
	}
	return nil, false
}

func (h *Handler) findTarget(ctx gateway.AwsRequestContext, busName string, ruleName string, targetID string) (corestore.Record, bool) {
	for _, target := range h.EventTargets.FindBy("target_id", targetID) {
		if stringField(target, "event_bus_name") == busName && stringField(target, "rule_name") == ruleName && h.sameScope(ctx, target) {
			return target, true
		}
	}
	return nil, false
}

func (h *Handler) findSQSQueue(arn string) (corestore.Record, bool) {
	for _, queue := range h.SQSQueues.All() {
		if stringField(queue, "arn") == arn || stringField(queue, "queue_url") == arn {
			return queue, true
		}
	}
	return nil, false
}

func (h *Handler) findSNSTopic(ctx gateway.AwsRequestContext, arn string) (corestore.Record, bool) {
	for _, topic := range h.SNSTopics.FindBy("arn", arn) {
		if h.sameScope(ctx, topic) {
			return topic, true
		}
	}
	return nil, false
}

func (h *Handler) deleteRuleTargets(ctx gateway.AwsRequestContext, busName string, ruleName string) {
	for _, target := range h.EventTargets.FindBy("rule_name", ruleName) {
		if stringField(target, "event_bus_name") == busName && h.sameScope(ctx, target) {
			h.EventTargets.Delete(intField(target, "id"))
		}
	}
}

func (h *Handler) targetsForRule(ctx gateway.AwsRequestContext, busName string, ruleName string) []corestore.Record {
	targets := []corestore.Record{}
	for _, target := range h.EventTargets.FindBy("rule_name", ruleName) {
		if stringField(target, "event_bus_name") == busName && h.sameScope(ctx, target) {
			targets = append(targets, target)
		}
	}
	return targets
}

func (h *Handler) requireTaggableResource(ctx gateway.AwsRequestContext, arn string, requestID string) (corestore.Record, protocols.ErrorResponse, bool) {
	if arn == "" {
		return nil, h.validation("ResourceARN is required.", requestID), false
	}
	if arn == busARN(h.region(ctx), h.accountID(ctx), "default") {
		h.ensureDefaultBus(ctx)
	}
	for _, bus := range h.EventBuses.FindBy("arn", arn) {
		if h.sameScope(ctx, bus) {
			return bus, protocols.ErrorResponse{}, true
		}
	}
	for _, rule := range h.EventRules.FindBy("arn", arn) {
		if h.sameScope(ctx, rule) {
			return rule, protocols.ErrorResponse{}, true
		}
	}
	return nil, h.notFound("Resource "+arn+" does not exist.", requestID), false
}

func (h *Handler) collectionForResource(record corestore.Record) *corestore.Collection {
	if strings.Contains(stringField(record, "arn"), ":event-bus/") {
		return h.EventBuses
	}
	return h.EventRules
}

func matchesPattern(rule corestore.Record, event map[string]any) bool {
	if strings.TrimSpace(stringField(rule, "event_pattern")) == "" {
		return false
	}
	pattern := mapField(rule, "event_pattern_parsed")
	if len(pattern) == 0 {
		return true
	}
	for key, expected := range pattern {
		switch key {
		case "detail":
			detail, _ := event["detail"].(map[string]any)
			if !matchesDetailPattern(detail, mapValue(expected)) {
				return false
			}
		case "resources":
			if !matchesAnyString(stringSlice(event["resources"]), expected) {
				return false
			}
		default:
			if !matchesScalar(event[key], expected) {
				return false
			}
		}
	}
	return true
}

func matchesDetailPattern(detail map[string]any, pattern map[string]any) bool {
	for key, expected := range pattern {
		actual, ok := detail[key]
		if !ok {
			return false
		}
		if nested := mapValue(expected); len(nested) > 0 && !isPatternValues(expected) {
			actualMap, _ := actual.(map[string]any)
			if !matchesDetailPattern(actualMap, nested) {
				return false
			}
			continue
		}
		if !matchesScalar(actual, expected) {
			return false
		}
	}
	return true
}

func matchesScalar(actual any, expected any) bool {
	values := arrayValues(expected)
	if len(values) == 0 {
		values = []any{expected}
	}
	for _, value := range values {
		if stringValue(actual) == stringValue(value) {
			return true
		}
	}
	return false
}

func matchesAnyString(actual []string, expected any) bool {
	values := arrayValues(expected)
	if len(values) == 0 {
		values = []any{expected}
	}
	for _, actualValue := range actual {
		for _, value := range values {
			if actualValue == stringValue(value) {
				return true
			}
		}
	}
	return false
}

func parsePattern(raw string) map[string]any {
	if raw == "" {
		return map[string]any{}
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return map[string]any{}
	}
	return out
}

func validJSONObject(raw string) bool {
	var out map[string]any
	return json.Unmarshal([]byte(raw), &out) == nil && out != nil
}

func parseDetail(raw string) (map[string]any, bool) {
	if strings.TrimSpace(raw) == "" {
		return map[string]any{}, true
	}
	var detail map[string]any
	if err := json.Unmarshal([]byte(raw), &detail); err != nil {
		return nil, false
	}
	if detail == nil {
		return nil, false
	}
	return detail, true
}

func eventBusValue(input map[string]any) string {
	return firstNonEmpty(stringInput(input, "EventBusName"), "default")
}

func eventBusReference(value any) eventBusRef {
	text := strings.TrimSpace(stringValue(value))
	if text == "" {
		return eventBusRef{}
	}
	parts := strings.SplitN(text, ":", 6)
	if len(parts) == 6 && parts[0] == "arn" && parts[2] == "events" && strings.HasPrefix(parts[5], "event-bus/") {
		return eventBusRef{
			Raw:       text,
			Name:      strings.TrimPrefix(parts[5], "event-bus/"),
			Region:    parts[3],
			AccountID: parts[4],
			IsARN:     true,
		}
	}
	if strings.Contains(text, ":event-bus/") {
		return eventBusRef{Raw: text, Name: text, IsARN: true}
	}
	return eventBusRef{Raw: text, Name: text}
}

func eventBusDisplayName(ref eventBusRef) string {
	if ref.Raw != "" {
		return ref.Raw
	}
	return ref.Name
}

func busARN(region string, accountID string, name string) string {
	return "arn:aws:events:" + region + ":" + accountID + ":event-bus/" + name
}

func ruleARN(region string, accountID string, busName string, name string) string {
	if busName == "" || busName == "default" {
		return "arn:aws:events:" + region + ":" + accountID + ":rule/" + name
	}
	return "arn:aws:events:" + region + ":" + accountID + ":rule/" + busName + "/" + name
}

func (h *Handler) eventBusReferenceMatchesCaller(ctx gateway.AwsRequestContext, ref eventBusRef) bool {
	if !ref.IsARN {
		return true
	}
	return ref.AccountID == h.accountID(ctx) && ref.Region == h.region(ctx)
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
		return h.Now()
	}
	return time.Now().UTC()
}

func (h *Handler) generateID(prefix string) string {
	if h.IDGenerator != nil {
		return h.IDGenerator(prefix)
	}
	var bytes [8]byte
	if _, err := rand.Read(bytes[:]); err == nil {
		if prefix == "" {
			return hex.EncodeToString(bytes[:])
		}
		return prefix + "-" + hex.EncodeToString(bytes[:])
	}
	id := fallbackIDCounter.Add(1)
	if prefix == "" {
		return fmt.Sprintf("%016x", id)
	}
	return fmt.Sprintf("%s-%016x", prefix, id)
}

func hError(code string, message string, status int, requestID string) protocols.ErrorResponse {
	return protocols.SerializeJSONError(protocols.AWSError{
		Code:       code,
		Message:    message,
		RequestID:  requestID,
		Service:    "com.amazonaws.events",
		StatusCode: status,
	})
}

func (h *Handler) error(code string, message string, status int, requestID string) protocols.ErrorResponse {
	return hError(code, message, status, requestID)
}

func (h *Handler) validation(message string, requestID string) protocols.ErrorResponse {
	return h.error("ValidationException", message, http.StatusBadRequest, requestID)
}

func (h *Handler) notFound(message string, requestID string) protocols.ErrorResponse {
	return h.error("ResourceNotFoundException", message, http.StatusBadRequest, requestID)
}

func jsonResponse(status int, value map[string]any) protocols.ErrorResponse {
	body, _ := json.Marshal(value)
	return protocols.ErrorResponse{
		StatusCode:  status,
		ContentType: jsonContentType,
		Headers:     map[string]string{"Content-Type": jsonContentType},
		Body:        body,
	}
}

func withRequestID(response protocols.ErrorResponse, requestID string) protocols.ErrorResponse {
	if response.Headers == nil {
		response.Headers = map[string]string{}
	}
	if requestID != "" {
		response.Headers["x-amzn-requestid"] = requestID
	}
	return response
}

func stringInput(input map[string]any, key string) string {
	return stringValue(input[key])
}

func intInput(input map[string]any, key string, fallback int) int {
	value := input[key]
	switch v := value.(type) {
	case int:
		return v
	case float64:
		return int(v)
	case json.Number:
		n, err := v.Int64()
		if err == nil {
			return int(n)
		}
	case string:
		n, err := strconv.Atoi(v)
		if err == nil {
			return n
		}
	}
	return fallback
}

func stringValue(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case json.Number:
		return v.String()
	case fmt.Stringer:
		return v.String()
	case nil:
		return ""
	default:
		return fmt.Sprint(v)
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func stringField(record corestore.Record, field string) string {
	if record == nil {
		return ""
	}
	return stringValue(record[field])
}

func intField(record corestore.Record, field string) int {
	if record == nil {
		return 0
	}
	switch v := record[field].(type) {
	case int:
		return v
	case float64:
		return int(v)
	default:
		return 0
	}
}

func stringMapField(record corestore.Record, field string) map[string]string {
	if record == nil {
		return map[string]string{}
	}
	if values, ok := record[field].(map[string]string); ok {
		out := map[string]string{}
		for key, value := range values {
			out[key] = value
		}
		return out
	}
	if values, ok := record[field].(corestore.Record); ok {
		out := map[string]string{}
		for key, value := range values {
			out[key] = stringValue(value)
		}
		return out
	}
	return map[string]string{}
}

func mapField(record corestore.Record, field string) map[string]any {
	if record == nil {
		return map[string]any{}
	}
	return mapValue(record[field])
}

func mapValue(value any) map[string]any {
	if m, ok := value.(map[string]any); ok {
		out := map[string]any{}
		for key, item := range m {
			out[key] = item
		}
		return out
	}
	if m, ok := value.(corestore.Record); ok {
		out := map[string]any{}
		for key, item := range m {
			out[key] = item
		}
		return out
	}
	return map[string]any{}
}

func mapSlice(value any) []map[string]any {
	if items, ok := value.([]any); ok {
		out := make([]map[string]any, 0, len(items))
		for _, item := range items {
			if m := mapValue(item); len(m) > 0 {
				out = append(out, m)
			}
		}
		return out
	}
	if items, ok := value.([]map[string]any); ok {
		return append([]map[string]any(nil), items...)
	}
	return nil
}

func arrayValues(value any) []any {
	if items, ok := value.([]any); ok {
		return append([]any(nil), items...)
	}
	if items, ok := value.([]string); ok {
		out := make([]any, 0, len(items))
		for _, item := range items {
			out = append(out, item)
		}
		return out
	}
	return nil
}

func stringSlice(value any) []string {
	switch v := value.(type) {
	case []string:
		return append([]string(nil), v...)
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			if text := stringValue(item); text != "" {
				out = append(out, text)
			}
		}
		return out
	default:
		return nil
	}
}

func isPatternValues(value any) bool {
	_, ok := value.([]any)
	return ok
}

func tagsFromInput(value any) []corestore.Record {
	tags := []corestore.Record{}
	for _, item := range mapSlice(value) {
		key := stringValue(item["Key"])
		if key == "" {
			continue
		}
		tags = append(tags, corestore.Record{"Key": key, "Value": stringValue(item["Value"])})
	}
	return tags
}

func recordList(value any) []corestore.Record {
	if records, ok := value.([]corestore.Record); ok {
		out := make([]corestore.Record, 0, len(records))
		for _, record := range records {
			out = append(out, corestore.Record(record))
		}
		return out
	}
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]corestore.Record, 0, len(items))
	for _, item := range items {
		if m := mapValue(item); len(m) > 0 {
			out = append(out, corestore.Record(m))
		}
	}
	return out
}

func mergeTags(existing []corestore.Record, incoming []corestore.Record) []corestore.Record {
	byKey := map[string]corestore.Record{}
	for _, tag := range existing {
		byKey[stringField(tag, "Key")] = tag
	}
	for _, tag := range incoming {
		byKey[stringField(tag, "Key")] = tag
	}
	keys := make([]string, 0, len(byKey))
	for key := range byKey {
		if key != "" {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	out := make([]corestore.Record, 0, len(keys))
	for _, key := range keys {
		out = append(out, byKey[key])
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

func eventTime(value any, fallback time.Time) time.Time {
	switch v := value.(type) {
	case time.Time:
		return v
	case json.Number:
		if parsed, ok := timeFromJSONNumber(v); ok {
			return parsed
		}
	case int:
		return time.Unix(int64(v), 0).UTC()
	case int64:
		return time.Unix(v, 0).UTC()
	case float64:
		if parsed, ok := timeFromUnixSeconds(v); ok {
			return parsed
		}
	case string:
		if parsed, err := time.Parse(time.RFC3339, v); err == nil {
			return parsed
		}
	}
	return fallback
}

func timeFromJSONNumber(value json.Number) (time.Time, bool) {
	if seconds, err := value.Int64(); err == nil {
		return time.Unix(seconds, 0).UTC(), true
	}
	seconds, err := strconv.ParseFloat(value.String(), 64)
	if err != nil {
		return time.Time{}, false
	}
	return timeFromUnixSeconds(seconds)
}

func timeFromUnixSeconds(seconds float64) (time.Time, bool) {
	if math.IsNaN(seconds) || math.IsInf(seconds, 0) {
		return time.Time{}, false
	}
	whole, fraction := math.Modf(seconds)
	return time.Unix(int64(whole), int64(fraction*1e9)).UTC(), true
}

func md5Hex(value string) string {
	sum := md5.Sum([]byte(value))
	return hex.EncodeToString(sum[:])
}
