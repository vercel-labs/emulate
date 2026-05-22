package logs

import (
	"encoding/json"
	"fmt"
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

const jsonContentType = "application/x-amz-json-1.1"

type Handler struct {
	LogGroups   *corestore.Collection
	LogStreams  *corestore.Collection
	LogEvents   *corestore.Collection
	AccountID   string
	Region      string
	Now         func() time.Time
	IDGenerator func(string) string
}

var fallbackIDCounter atomic.Uint64

func (h *Handler) Handle(_ *http.Request, ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	requestID := ctx.RequestID
	if requestID == "" {
		requestID = h.generateID("req")
	}
	var response protocols.ErrorResponse
	switch ctx.Action {
	case "CreateLogGroup":
		response = h.createLogGroup(ctx, requestID)
	case "DeleteLogGroup":
		response = h.deleteLogGroup(ctx, requestID)
	case "DescribeLogGroups":
		response = h.describeLogGroups(ctx, requestID)
	case "CreateLogStream":
		response = h.createLogStream(ctx, requestID)
	case "DeleteLogStream":
		response = h.deleteLogStream(ctx, requestID)
	case "DescribeLogStreams":
		response = h.describeLogStreams(ctx, requestID)
	case "PutLogEvents":
		response = h.putLogEvents(ctx, requestID)
	case "GetLogEvents":
		response = h.getLogEvents(ctx, requestID)
	case "FilterLogEvents":
		response = h.filterLogEvents(ctx, requestID)
	case "PutRetentionPolicy":
		response = h.putRetentionPolicy(ctx, requestID)
	case "DeleteRetentionPolicy":
		response = h.deleteRetentionPolicy(ctx, requestID)
	case "TagResource":
		response = h.tagResource(ctx, requestID)
	case "UntagResource":
		response = h.untagResource(ctx, requestID)
	case "ListTagsForResource":
		response = h.listTagsForResource(ctx, requestID)
	default:
		response = h.error("NotImplementedException", fmt.Sprintf("logs.%s is not implemented in the native Go runtime yet.", ctx.Action), http.StatusNotImplemented, requestID)
	}
	return withRequestID(response, requestID)
}

func (h *Handler) createLogGroup(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	name := strings.TrimSpace(stringInput(ctx.Input, "logGroupName", "LogGroupName"))
	if name == "" {
		return h.validation("logGroupName is required.", requestID)
	}
	if _, ok := h.findGroup(ctx, name); ok {
		return h.error("ResourceAlreadyExistsException", "The specified log group already exists.", http.StatusBadRequest, requestID)
	}
	h.LogGroups.Insert(corestore.Record{
		"account_id":        h.accountID(ctx),
		"region":            h.region(ctx),
		"log_group_name":    name,
		"arn":               logGroupARN(h.region(ctx), h.accountID(ctx), name),
		"creation_time":     h.now().UnixMilli(),
		"retention_in_days": 0,
		"kms_key_id":        stringInput(ctx.Input, "kmsKeyId", "KmsKeyId"),
		"tags":              tagsMap(ctx.Input["tags"], ctx.Input["Tags"]),
	})
	return jsonResponse(http.StatusOK, map[string]any{})
}

func (h *Handler) deleteLogGroup(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	group, response, ok := h.requireGroup(ctx, stringInput(ctx.Input, "logGroupName", "LogGroupName"), requestID)
	if !ok {
		return response
	}
	groupName := stringField(group, "log_group_name")
	for _, stream := range h.LogStreams.FindBy("log_group_name", groupName) {
		if !sameRecordScope(group, stream) {
			continue
		}
		h.deleteStreamEvents(group, stringField(stream, "log_stream_name"))
		h.LogStreams.Delete(intField(stream, "id"))
	}
	h.LogGroups.Delete(intField(group, "id"))
	return jsonResponse(http.StatusOK, map[string]any{})
}

func (h *Handler) describeLogGroups(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	prefix := stringInput(ctx.Input, "logGroupNamePrefix", "LogGroupNamePrefix")
	pattern := stringInput(ctx.Input, "logGroupNamePattern", "LogGroupNamePattern")
	if prefix != "" && pattern != "" {
		return h.validation("logGroupNamePrefix and logGroupNamePattern cannot both be specified.", requestID)
	}
	identifierKeys, hasIdentifierFilter, response, ok := h.logGroupIdentifierKeys(ctx, inputValue(ctx.Input, "logGroupIdentifiers", "LogGroupIdentifiers"), requestID)
	if !ok {
		return response
	}
	if hasIdentifierFilter && (prefix != "" || pattern != "") {
		return h.validation("logGroupIdentifiers cannot be specified with logGroupNamePrefix or logGroupNamePattern.", requestID)
	}
	groups := []corestore.Record{}
	for _, group := range h.LogGroups.All() {
		if !h.sameScope(ctx, group) {
			continue
		}
		if hasIdentifierFilter && !identifierKeys[logGroupRecordKey(group)] {
			continue
		}
		if prefix != "" && !strings.HasPrefix(stringField(group, "log_group_name"), prefix) {
			continue
		}
		if pattern != "" && !strings.Contains(stringField(group, "log_group_name"), pattern) {
			continue
		}
		groups = append(groups, group)
	}
	sort.Slice(groups, func(i int, j int) bool {
		return stringField(groups[i], "log_group_name") < stringField(groups[j], "log_group_name")
	})
	start, end, nextToken, response, ok := h.pageBounds(ctx.Input, len(groups), 50, requestID)
	if !ok {
		return response
	}
	out := make([]map[string]any, 0, end-start)
	for _, group := range groups[start:end] {
		if pattern != "" {
			out = append(out, h.groupPatternResponse(group))
		} else {
			out = append(out, h.groupResponse(group))
		}
	}
	body := map[string]any{"logGroups": out}
	if nextToken != "" {
		body["nextToken"] = nextToken
	}
	return jsonResponse(http.StatusOK, body)
}

func (h *Handler) createLogStream(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	group, response, ok := h.requireGroup(ctx, stringInput(ctx.Input, "logGroupName", "LogGroupName"), requestID)
	if !ok {
		return response
	}
	streamName := strings.TrimSpace(stringInput(ctx.Input, "logStreamName", "LogStreamName"))
	if streamName == "" {
		return h.validation("logStreamName is required.", requestID)
	}
	groupName := stringField(group, "log_group_name")
	if _, ok := h.findStream(group, streamName); ok {
		return h.error("ResourceAlreadyExistsException", "The specified log stream already exists.", http.StatusBadRequest, requestID)
	}
	h.LogStreams.Insert(corestore.Record{
		"account_id":            h.accountID(ctx),
		"region":                h.region(ctx),
		"log_group_name":        groupName,
		"log_stream_name":       streamName,
		"arn":                   logStreamARN(h.region(ctx), h.accountID(ctx), groupName, streamName),
		"creation_time":         h.now().UnixMilli(),
		"first_event_timestamp": int64(0),
		"last_event_timestamp":  int64(0),
		"last_ingestion_time":   int64(0),
		"upload_sequence_token": "0",
		"stored_bytes":          0,
	})
	return jsonResponse(http.StatusOK, map[string]any{})
}

func (h *Handler) deleteLogStream(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	group, response, ok := h.requireGroup(ctx, stringInput(ctx.Input, "logGroupName", "LogGroupName"), requestID)
	if !ok {
		return response
	}
	stream, response, ok := h.requireStream(group, stringInput(ctx.Input, "logStreamName", "LogStreamName"), requestID)
	if !ok {
		return response
	}
	h.deleteStreamEvents(group, stringField(stream, "log_stream_name"))
	h.LogStreams.Delete(intField(stream, "id"))
	return jsonResponse(http.StatusOK, map[string]any{})
}

func (h *Handler) describeLogStreams(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	group, response, ok := h.requireGroupInput(ctx, requestID)
	if !ok {
		return response
	}
	groupName := stringField(group, "log_group_name")
	prefix := stringInput(ctx.Input, "logStreamNamePrefix", "LogStreamNamePrefix")
	orderBy := strings.TrimSpace(stringInput(ctx.Input, "orderBy", "OrderBy"))
	if orderBy != "" && orderBy != "LogStreamName" && orderBy != "LastEventTime" {
		return h.validation("orderBy must be LogStreamName or LastEventTime.", requestID)
	}
	if orderBy == "LastEventTime" && prefix != "" {
		return h.validation("logStreamNamePrefix cannot be specified when orderBy is LastEventTime.", requestID)
	}
	streams := []corestore.Record{}
	for _, stream := range h.LogStreams.FindBy("log_group_name", groupName) {
		if !sameRecordScope(group, stream) {
			continue
		}
		if prefix != "" && !strings.HasPrefix(stringField(stream, "log_stream_name"), prefix) {
			continue
		}
		streams = append(streams, stream)
	}
	descending := boolInput(ctx.Input, "descending", "Descending")
	sort.Slice(streams, func(i int, j int) bool {
		var compare int
		if orderBy == "LastEventTime" {
			left := int64Field(streams[i], "last_event_timestamp")
			right := int64Field(streams[j], "last_event_timestamp")
			if left < right {
				compare = -1
			} else if left > right {
				compare = 1
			}
		} else {
			compare = strings.Compare(stringField(streams[i], "log_stream_name"), stringField(streams[j], "log_stream_name"))
		}
		if compare == 0 {
			compare = intField(streams[i], "id") - intField(streams[j], "id")
		}
		if descending {
			return compare > 0
		}
		return compare < 0
	})
	start, end, nextToken, pageResponse, ok := h.pageBounds(ctx.Input, len(streams), 50, requestID)
	if !ok {
		return pageResponse
	}
	out := make([]map[string]any, 0, end-start)
	for _, stream := range streams[start:end] {
		out = append(out, h.streamResponse(stream))
	}
	body := map[string]any{"logStreams": out}
	if nextToken != "" {
		body["nextToken"] = nextToken
	}
	return jsonResponse(http.StatusOK, body)
}

func (h *Handler) putLogEvents(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	group, response, ok := h.requireGroup(ctx, stringInput(ctx.Input, "logGroupName", "LogGroupName"), requestID)
	if !ok {
		return response
	}
	groupName := stringField(group, "log_group_name")
	stream, response, ok := h.requireStream(group, stringInput(ctx.Input, "logStreamName", "LogStreamName"), requestID)
	if !ok {
		return response
	}
	rawEvents := mapSlice(inputValue(ctx.Input, "logEvents", "LogEvents"))
	if len(rawEvents) == 0 {
		return h.validation("logEvents is required.", requestID)
	}
	timestamps := make([]int64, len(rawEvents))
	for index, item := range rawEvents {
		timestamp := int64Value(inputValue(item, "timestamp", "Timestamp"), -1)
		if timestamp < 0 {
			return h.validation("Each log event must include timestamp.", requestID)
		}
		if index > 0 && timestamp < timestamps[index-1] {
			return h.validation("The log events in a batch must be in chronological order.", requestID)
		}
		timestamps[index] = timestamp
	}
	ingestionTime := h.now().UnixMilli()
	for index, item := range rawEvents {
		message := stringValue(inputValue(item, "message", "Message"))
		timestamp := timestamps[index]
		h.LogEvents.Insert(corestore.Record{
			"account_id":      h.accountID(ctx),
			"region":          h.region(ctx),
			"log_group_name":  groupName,
			"log_stream_name": stringField(stream, "log_stream_name"),
			"event_id":        h.generateID("event"),
			"timestamp":       timestamp,
			"message":         message,
			"ingestion_time":  ingestionTime,
		})
	}
	nextToken := ""
	eventBytes := logEventsBytes(rawEvents)
	if _, ok := h.LogStreams.UpdateFunc(intField(stream, "id"), func(current corestore.Record) (corestore.Record, bool) {
		firstTimestamp := int64Field(current, "first_event_timestamp")
		lastTimestamp := int64Field(current, "last_event_timestamp")
		for _, timestamp := range timestamps {
			if firstTimestamp == 0 || timestamp < firstTimestamp {
				firstTimestamp = timestamp
			}
			if timestamp > lastTimestamp {
				lastTimestamp = timestamp
			}
		}
		nextToken = strconv.Itoa(intField(current, "upload_sequence_token") + len(rawEvents) + 1)
		return corestore.Record{
			"first_event_timestamp": firstTimestamp,
			"last_event_timestamp":  lastTimestamp,
			"last_ingestion_time":   ingestionTime,
			"upload_sequence_token": nextToken,
			"stored_bytes":          intField(current, "stored_bytes") + eventBytes,
		}, true
	}); !ok {
		return h.notFound("The specified log stream does not exist.", requestID)
	}
	if nextToken == "" {
		nextToken = strconv.Itoa(len(rawEvents) + 1)
	}
	return jsonResponse(http.StatusOK, map[string]any{"nextSequenceToken": nextToken})
}

func (h *Handler) getLogEvents(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	group, response, ok := h.requireGroupInput(ctx, requestID)
	if !ok {
		return response
	}
	stream, response, ok := h.requireStream(group, stringInput(ctx.Input, "logStreamName", "LogStreamName"), requestID)
	if !ok {
		return response
	}
	events := h.eventsForStream(group, stringField(stream, "log_stream_name"))
	events = h.filterEventsByTime(events, int64Input(ctx.Input, "startTime", "StartTime", 0), int64Input(ctx.Input, "endTime", "EndTime", 0), true)
	if !boolInput(ctx.Input, "startFromHead", "StartFromHead") {
		reverseRecords(events)
	}
	start := tokenOffset(stringInput(ctx.Input, "nextToken", "NextToken"))
	if start > len(events) {
		start = len(events)
	}
	limit := intInput(ctx.Input, "limit", "Limit", 10000)
	if limit <= 0 || limit > 10000 {
		limit = 10000
	}
	end := start + limit
	if end > len(events) {
		end = len(events)
	}
	out := make([]map[string]any, 0, end-start)
	for _, event := range events[start:end] {
		out = append(out, map[string]any{
			"timestamp":     int64Field(event, "timestamp"),
			"message":       stringField(event, "message"),
			"ingestionTime": int64Field(event, "ingestion_time"),
		})
	}
	return jsonResponse(http.StatusOK, map[string]any{
		"events":            out,
		"nextForwardToken":  fmt.Sprintf("f/%d", end),
		"nextBackwardToken": fmt.Sprintf("b/%d", start),
	})
}

func (h *Handler) filterLogEvents(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	group, response, ok := h.requireGroupInput(ctx, requestID)
	if !ok {
		return response
	}
	groupName := stringField(group, "log_group_name")
	streamFilter := stringSet(stringSlice(inputValue(ctx.Input, "logStreamNames", "LogStreamNames")))
	streamPrefix := stringInput(ctx.Input, "logStreamNamePrefix", "LogStreamNamePrefix")
	if len(streamFilter) > 0 && streamPrefix != "" {
		return h.validation("logStreamNames and logStreamNamePrefix cannot both be specified.", requestID)
	}
	pattern := strings.Trim(strings.TrimSpace(stringInput(ctx.Input, "filterPattern", "FilterPattern")), "\"")
	events := []corestore.Record{}
	searchedStreams := []map[string]any{}
	for _, stream := range h.LogStreams.FindBy("log_group_name", groupName) {
		if !sameRecordScope(group, stream) {
			continue
		}
		streamName := stringField(stream, "log_stream_name")
		if len(streamFilter) > 0 && !streamFilter[streamName] {
			continue
		}
		if streamPrefix != "" && !strings.HasPrefix(streamName, streamPrefix) {
			continue
		}
		searchedStreams = append(searchedStreams, map[string]any{"logStreamName": streamName, "searchedCompletely": true})
		for _, event := range h.eventsForStream(group, streamName) {
			if pattern != "" && !strings.Contains(stringField(event, "message"), pattern) {
				continue
			}
			events = append(events, event)
		}
	}
	events = h.filterEventsByTime(events, int64Input(ctx.Input, "startTime", "StartTime", 0), int64Input(ctx.Input, "endTime", "EndTime", 0), false)
	sortEvents(events)
	start, end, nextToken, pageResponse, ok := h.pageBounds(ctx.Input, len(events), 10000, requestID)
	if !ok {
		return pageResponse
	}
	out := make([]map[string]any, 0, end-start)
	for _, event := range events[start:end] {
		out = append(out, map[string]any{
			"eventId":       stringField(event, "event_id"),
			"logGroupName":  groupName,
			"logStreamName": stringField(event, "log_stream_name"),
			"timestamp":     int64Field(event, "timestamp"),
			"message":       stringField(event, "message"),
			"ingestionTime": int64Field(event, "ingestion_time"),
		})
	}
	body := map[string]any{"events": out, "searchedLogStreams": searchedStreams}
	if nextToken != "" {
		body["nextToken"] = nextToken
	}
	return jsonResponse(http.StatusOK, body)
}

func (h *Handler) putRetentionPolicy(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	group, response, ok := h.requireGroup(ctx, stringInput(ctx.Input, "logGroupName", "LogGroupName"), requestID)
	if !ok {
		return response
	}
	retention := intInput(ctx.Input, "retentionInDays", "RetentionInDays", 0)
	if !isValidRetentionDays(retention) {
		return h.validation("retentionInDays is invalid.", requestID)
	}
	h.LogGroups.Update(intField(group, "id"), corestore.Record{"retention_in_days": retention})
	return jsonResponse(http.StatusOK, map[string]any{})
}

func (h *Handler) deleteRetentionPolicy(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	group, response, ok := h.requireGroup(ctx, stringInput(ctx.Input, "logGroupName", "LogGroupName"), requestID)
	if !ok {
		return response
	}
	h.LogGroups.Update(intField(group, "id"), corestore.Record{"retention_in_days": 0})
	return jsonResponse(http.StatusOK, map[string]any{})
}

func (h *Handler) tagResource(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	group, response, ok := h.requireGroupByARN(ctx, stringInput(ctx.Input, "resourceArn", "ResourceArn"), requestID)
	if !ok {
		return response
	}
	tags := tagsMap(ctx.Input["tags"], ctx.Input["Tags"])
	h.LogGroups.Update(intField(group, "id"), corestore.Record{"tags": mergeTags(mapRecord(group["tags"]), tags)})
	return jsonResponse(http.StatusOK, map[string]any{})
}

func (h *Handler) untagResource(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	group, response, ok := h.requireGroupByARN(ctx, stringInput(ctx.Input, "resourceArn", "ResourceArn"), requestID)
	if !ok {
		return response
	}
	tags := mapRecord(group["tags"])
	for _, key := range stringSlice(inputValue(ctx.Input, "tagKeys", "TagKeys")) {
		delete(tags, key)
	}
	h.LogGroups.Update(intField(group, "id"), corestore.Record{"tags": tags})
	return jsonResponse(http.StatusOK, map[string]any{})
}

func (h *Handler) listTagsForResource(ctx gateway.AwsRequestContext, requestID string) protocols.ErrorResponse {
	group, response, ok := h.requireGroupByARN(ctx, stringInput(ctx.Input, "resourceArn", "ResourceArn"), requestID)
	if !ok {
		return response
	}
	return jsonResponse(http.StatusOK, map[string]any{"tags": mapRecord(group["tags"])})
}

func (h *Handler) requireGroup(ctx gateway.AwsRequestContext, name string, requestID string) (corestore.Record, protocols.ErrorResponse, bool) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, h.validation("logGroupName is required.", requestID), false
	}
	group, ok := h.findGroup(ctx, name)
	if !ok {
		return nil, h.notFound("The specified log group does not exist.", requestID), false
	}
	return group, protocols.ErrorResponse{}, true
}

func (h *Handler) requireGroupInput(ctx gateway.AwsRequestContext, requestID string) (corestore.Record, protocols.ErrorResponse, bool) {
	name := strings.TrimSpace(stringInput(ctx.Input, "logGroupName", "LogGroupName"))
	identifier := strings.TrimSpace(stringInput(ctx.Input, "logGroupIdentifier", "LogGroupIdentifier"))
	if name != "" && identifier != "" {
		return nil, h.validation("Specify either logGroupName or logGroupIdentifier, not both.", requestID), false
	}
	if identifier == "" {
		return h.requireGroup(ctx, name, requestID)
	}
	return h.requireGroupIdentifier(ctx, identifier, requestID)
}

func (h *Handler) requireGroupIdentifier(ctx gateway.AwsRequestContext, identifier string, requestID string) (corestore.Record, protocols.ErrorResponse, bool) {
	if strings.HasPrefix(identifier, "arn:") {
		parsed, ok := parseLogGroupARN(identifier)
		if !ok {
			return nil, h.validation("logGroupIdentifier is invalid.", requestID), false
		}
		if group, ok := h.findGroupByARNParts(ctx, parsed); ok {
			return group, protocols.ErrorResponse{}, true
		}
		return nil, h.notFound("The specified log group does not exist.", requestID), false
	}
	return h.requireGroup(ctx, identifier, requestID)
}

func (h *Handler) requireGroupByARN(ctx gateway.AwsRequestContext, arn string, requestID string) (corestore.Record, protocols.ErrorResponse, bool) {
	parsed, ok := parseLogGroupARN(arn)
	if !ok {
		return nil, h.validation("resourceArn is required.", requestID), false
	}
	if group, ok := h.findGroupByARNParts(ctx, parsed); ok {
		return group, protocols.ErrorResponse{}, true
	}
	return nil, h.notFound("The specified log group does not exist.", requestID), false
}

func (h *Handler) requireStream(group corestore.Record, streamName string, requestID string) (corestore.Record, protocols.ErrorResponse, bool) {
	streamName = strings.TrimSpace(streamName)
	if streamName == "" {
		return nil, h.validation("logStreamName is required.", requestID), false
	}
	stream, ok := h.findStream(group, streamName)
	if !ok {
		return nil, h.notFound("The specified log stream does not exist.", requestID), false
	}
	return stream, protocols.ErrorResponse{}, true
}

func (h *Handler) findGroup(ctx gateway.AwsRequestContext, name string) (corestore.Record, bool) {
	for _, group := range h.LogGroups.FindBy("log_group_name", name) {
		if h.sameScope(ctx, group) {
			return group, true
		}
	}
	return nil, false
}

func (h *Handler) findGroupByARNParts(ctx gateway.AwsRequestContext, parsed logGroupARNParts) (corestore.Record, bool) {
	if !h.logGroupARNMatchesCaller(ctx, parsed) {
		return nil, false
	}
	for _, group := range h.LogGroups.FindBy("log_group_name", parsed.Name) {
		if stringField(group, "account_id") == parsed.AccountID && stringField(group, "region") == parsed.Region {
			return group, true
		}
	}
	return nil, false
}

func (h *Handler) logGroupIdentifierKeys(ctx gateway.AwsRequestContext, value any, requestID string) (map[string]bool, bool, protocols.ErrorResponse, bool) {
	identifiers := stringSlice(value)
	if len(identifiers) == 0 {
		return nil, false, protocols.ErrorResponse{}, true
	}
	keys := map[string]bool{}
	for _, identifier := range identifiers {
		identifier = strings.TrimSpace(identifier)
		if identifier == "" {
			continue
		}
		if strings.HasPrefix(identifier, "arn:") {
			parsed, ok := parseLogGroupARN(identifier)
			if !ok {
				return nil, false, h.validation("logGroupIdentifiers contains an invalid log group identifier.", requestID), false
			}
			if h.logGroupARNMatchesCaller(ctx, parsed) {
				keys[logGroupKey(parsed.AccountID, parsed.Region, parsed.Name)] = true
			}
			continue
		}
		keys[logGroupKey(h.accountID(ctx), h.region(ctx), identifier)] = true
	}
	return keys, true, protocols.ErrorResponse{}, true
}

func (h *Handler) findStream(group corestore.Record, streamName string) (corestore.Record, bool) {
	for _, stream := range h.LogStreams.FindBy("log_group_name", stringField(group, "log_group_name")) {
		if sameRecordScope(group, stream) && stringField(stream, "log_stream_name") == streamName {
			return stream, true
		}
	}
	return nil, false
}

func (h *Handler) deleteStreamEvents(group corestore.Record, streamName string) {
	for _, event := range h.LogEvents.FindBy("log_group_name", stringField(group, "log_group_name")) {
		if sameRecordScope(group, event) && stringField(event, "log_stream_name") == streamName {
			h.LogEvents.Delete(intField(event, "id"))
		}
	}
}

func (h *Handler) eventsForStream(group corestore.Record, streamName string) []corestore.Record {
	events := []corestore.Record{}
	for _, event := range h.LogEvents.FindBy("log_group_name", stringField(group, "log_group_name")) {
		if sameRecordScope(group, event) && stringField(event, "log_stream_name") == streamName {
			events = append(events, event)
		}
	}
	sortEvents(events)
	return events
}

func (h *Handler) filterEventsByTime(events []corestore.Record, startTime int64, endTime int64, endExclusive bool) []corestore.Record {
	filtered := events[:0]
	for _, event := range events {
		timestamp := int64Field(event, "timestamp")
		if startTime > 0 && timestamp < startTime {
			continue
		}
		if endTime > 0 && (timestamp > endTime || endExclusive && timestamp == endTime) {
			continue
		}
		filtered = append(filtered, event)
	}
	return filtered
}

func (h *Handler) groupResponse(group corestore.Record) map[string]any {
	logGroupArn := stringField(group, "arn")
	response := map[string]any{
		"logGroupName":      stringField(group, "log_group_name"),
		"creationTime":      int64Field(group, "creation_time"),
		"metricFilterCount": 0,
		"arn":               logGroupWildcardARN(logGroupArn),
		"logGroupArn":       logGroupArn,
		"storedBytes":       h.groupStoredBytes(group),
	}
	if retention := intField(group, "retention_in_days"); retention > 0 {
		response["retentionInDays"] = retention
	}
	if kmsKeyID := stringField(group, "kms_key_id"); kmsKeyID != "" {
		response["kmsKeyId"] = kmsKeyID
	}
	return response
}

func (h *Handler) groupPatternResponse(group corestore.Record) map[string]any {
	return map[string]any{
		"logGroupName": stringField(group, "log_group_name"),
		"creationTime": int64Field(group, "creation_time"),
		"arn":          logGroupWildcardARN(stringField(group, "arn")),
	}
}

func (h *Handler) streamResponse(stream corestore.Record) map[string]any {
	response := map[string]any{
		"logStreamName":       stringField(stream, "log_stream_name"),
		"creationTime":        int64Field(stream, "creation_time"),
		"arn":                 stringField(stream, "arn"),
		"storedBytes":         intField(stream, "stored_bytes"),
		"uploadSequenceToken": stringField(stream, "upload_sequence_token"),
	}
	if value := int64Field(stream, "first_event_timestamp"); value > 0 {
		response["firstEventTimestamp"] = value
	}
	if value := int64Field(stream, "last_event_timestamp"); value > 0 {
		response["lastEventTimestamp"] = value
	}
	if value := int64Field(stream, "last_ingestion_time"); value > 0 {
		response["lastIngestionTime"] = value
	}
	return response
}

func (h *Handler) groupStoredBytes(group corestore.Record) int {
	total := 0
	groupName := stringField(group, "log_group_name")
	for _, stream := range h.LogStreams.FindBy("log_group_name", groupName) {
		if stringField(stream, "account_id") == stringField(group, "account_id") && stringField(stream, "region") == stringField(group, "region") {
			total += intField(stream, "stored_bytes")
		}
	}
	return total
}

func (h *Handler) pageBounds(input map[string]any, total int, fallbackLimit int, requestID string) (int, int, string, protocols.ErrorResponse, bool) {
	limit := intInput(input, "limit", "Limit", fallbackLimit)
	if limit <= 0 {
		limit = fallbackLimit
	}
	if limit > 10000 {
		limit = 10000
	}
	start := 0
	if raw := strings.TrimSpace(stringInput(input, "nextToken", "NextToken")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 0 || parsed > total {
			return 0, 0, "", h.error("InvalidParameterException", "nextToken is invalid.", http.StatusBadRequest, requestID), false
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

func (h *Handler) validation(message string, requestID string) protocols.ErrorResponse {
	return h.error("InvalidParameterException", message, http.StatusBadRequest, requestID)
}

func (h *Handler) notFound(message string, requestID string) protocols.ErrorResponse {
	return h.error("ResourceNotFoundException", message, http.StatusBadRequest, requestID)
}

func (h *Handler) error(code string, message string, status int, requestID string) protocols.ErrorResponse {
	return protocols.SerializeJSONError(protocols.AWSError{
		Code:       code,
		Message:    message,
		RequestID:  requestID,
		Service:    "com.amazonaws.logs",
		StatusCode: status,
	})
}

func (h *Handler) sameScope(ctx gateway.AwsRequestContext, record corestore.Record) bool {
	return stringField(record, "account_id") == h.accountID(ctx) && stringField(record, "region") == h.region(ctx)
}

func sameRecordScope(left corestore.Record, right corestore.Record) bool {
	return stringField(left, "account_id") == stringField(right, "account_id") && stringField(left, "region") == stringField(right, "region")
}

func (h *Handler) logGroupARNMatchesCaller(ctx gateway.AwsRequestContext, parsed logGroupARNParts) bool {
	return parsed.AccountID == h.accountID(ctx) && parsed.Region == h.region(ctx)
}

func logGroupRecordKey(group corestore.Record) string {
	return logGroupKey(stringField(group, "account_id"), stringField(group, "region"), stringField(group, "log_group_name"))
}

func logGroupKey(accountID string, region string, name string) string {
	return accountID + "\x00" + region + "\x00" + name
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
	return fmt.Sprintf("%s-%016x", prefix, fallbackIDCounter.Add(1))
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

func logGroupARN(region string, accountID string, name string) string {
	return "arn:aws:logs:" + region + ":" + accountID + ":log-group:" + name
}

func logGroupWildcardARN(arn string) string {
	if strings.HasSuffix(arn, ":*") {
		return arn
	}
	return arn + ":*"
}

func logStreamARN(region string, accountID string, groupName string, streamName string) string {
	return logGroupARN(region, accountID, groupName) + ":log-stream:" + streamName
}

type logGroupARNParts struct {
	Region    string
	AccountID string
	Name      string
}

func parseLogGroupARN(arn string) (logGroupARNParts, bool) {
	parts := strings.SplitN(strings.TrimSpace(arn), ":", 6)
	if len(parts) != 6 || parts[0] != "arn" || parts[2] != "logs" || parts[3] == "" || parts[4] == "" {
		return logGroupARNParts{}, false
	}
	value := parts[5]
	if !strings.HasPrefix(value, "log-group:") {
		return logGroupARNParts{}, false
	}
	name := strings.TrimPrefix(value, "log-group:")
	if before, _, ok := strings.Cut(name, ":log-stream:"); ok {
		name = before
	}
	name = strings.TrimSuffix(name, ":*")
	if name == "" {
		return logGroupARNParts{}, false
	}
	return logGroupARNParts{Region: parts[3], AccountID: parts[4], Name: name}, true
}

func sortEvents(events []corestore.Record) {
	sort.SliceStable(events, func(i int, j int) bool {
		left := int64Field(events[i], "timestamp")
		right := int64Field(events[j], "timestamp")
		if left == right {
			return intField(events[i], "id") < intField(events[j], "id")
		}
		return left < right
	})
}

func reverseRecords(records []corestore.Record) {
	for left, right := 0, len(records)-1; left < right; left, right = left+1, right-1 {
		records[left], records[right] = records[right], records[left]
	}
}

func logEventsBytes(events []map[string]any) int {
	total := 0
	for _, event := range events {
		total += len(stringValue(inputValue(event, "message", "Message")))
	}
	return total
}

func isValidRetentionDays(days int) bool {
	switch days {
	case 1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653:
		return true
	default:
		return false
	}
}

func tokenOffset(token string) int {
	if token == "" {
		return 0
	}
	if _, value, ok := strings.Cut(token, "/"); ok {
		token = value
	}
	parsed, err := strconv.Atoi(token)
	if err != nil || parsed < 0 {
		return 0
	}
	return parsed
}

func stringInput(input map[string]any, keys ...string) string {
	return stringValue(inputValue(input, keys...))
}

func intInput(input map[string]any, first string, second string, fallback int) int {
	value := inputValue(input, first, second)
	switch v := value.(type) {
	case int:
		return v
	case int64:
		return int(v)
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

func int64Input(input map[string]any, first string, second string, fallback int64) int64 {
	return int64Value(inputValue(input, first, second), fallback)
}

func int64Value(value any, fallback int64) int64 {
	switch v := value.(type) {
	case int:
		return int64(v)
	case int64:
		return v
	case float64:
		return int64(v)
	case json.Number:
		n, err := v.Int64()
		if err == nil {
			return n
		}
	case string:
		n, err := strconv.ParseInt(v, 10, 64)
		if err == nil {
			return n
		}
	}
	return fallback
}

func boolInput(input map[string]any, first string, second string) bool {
	value := inputValue(input, first, second)
	switch v := value.(type) {
	case bool:
		return v
	case string:
		return strings.EqualFold(v, "true")
	default:
		return false
	}
}

func inputValue(input map[string]any, keys ...string) any {
	for _, key := range keys {
		if value, ok := input[key]; ok {
			return value
		}
	}
	return nil
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

func intField(record corestore.Record, name string) int {
	return int(int64Field(record, name))
}

func int64Field(record corestore.Record, name string) int64 {
	return int64Value(record[name], 0)
}

func stringField(record corestore.Record, name string) string {
	value, _ := record[name].(string)
	return value
}

func mapSlice(value any) []map[string]any {
	switch v := value.(type) {
	case []map[string]any:
		return v
	case []corestore.Record:
		out := make([]map[string]any, 0, len(v))
		for _, item := range v {
			out = append(out, map[string]any(item))
		}
		return out
	case []any:
		out := make([]map[string]any, 0, len(v))
		for _, item := range v {
			if m := mapValue(item); len(m) > 0 {
				out = append(out, m)
			}
		}
		return out
	default:
		return nil
	}
}

func mapValue(value any) map[string]any {
	switch v := value.(type) {
	case map[string]any:
		return v
	case corestore.Record:
		return map[string]any(v)
	default:
		return nil
	}
}

func mapRecord(value any) corestore.Record {
	switch v := value.(type) {
	case corestore.Record:
		out := corestore.Record{}
		for key, value := range v {
			out[key] = value
		}
		return out
	case map[string]any:
		out := corestore.Record{}
		for key, value := range v {
			out[key] = value
		}
		return out
	default:
		return corestore.Record{}
	}
}

func tagsMap(values ...any) corestore.Record {
	tags := corestore.Record{}
	for _, value := range values {
		for key, raw := range mapValue(value) {
			tags[key] = stringValue(raw)
		}
	}
	return tags
}

func mergeTags(existing corestore.Record, incoming corestore.Record) corestore.Record {
	out := corestore.Record{}
	for key, value := range existing {
		out[key] = value
	}
	for key, value := range incoming {
		out[key] = value
	}
	return out
}

func stringSlice(value any) []string {
	switch v := value.(type) {
	case []string:
		return append([]string(nil), v...)
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			out = append(out, stringValue(item))
		}
		return out
	default:
		return nil
	}
}

func stringSet(values []string) map[string]bool {
	out := map[string]bool{}
	for _, value := range values {
		out[value] = true
	}
	return out
}
