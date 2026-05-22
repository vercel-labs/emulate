package sqs

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
	Queues           *corestore.Collection
	Messages         *corestore.Collection
	BaseURL          string
	AccountID        string
	Region           string
	Now              func() time.Time
	IDGenerator      func() string
	ReceiptGenerator func() string
}

var fallbackIDCounter atomic.Uint64

func (h *Handler) Handle(req *http.Request, ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	if ctx.Protocol == protocols.ProtocolJSONRPC {
		return h.handleJSON(req, ctx)
	}
	requestID := ctx.RequestID
	if requestID == "" {
		requestID = h.generateID()
	}
	var response protocols.ErrorResponse
	switch ctx.Action {
	case "CreateQueue":
		response = h.createQueue(req, ctx.Query, requestID)
	case "DeleteQueue":
		response = h.deleteQueue(ctx.Query, requestID)
	case "ListQueues":
		response = h.listQueues(ctx.Query, requestID)
	case "GetQueueUrl":
		response = h.getQueueURL(ctx.Query, requestID)
	case "GetQueueAttributes":
		response = h.getQueueAttributes(ctx.Query, requestID)
	case "SetQueueAttributes":
		response = h.setQueueAttributes(ctx.Query, requestID)
	case "SendMessage":
		response = h.sendMessage(ctx.Query, requestID)
	case "SendMessageBatch":
		response = h.sendMessageBatch(ctx.Query, requestID)
	case "ReceiveMessage":
		response = h.receiveMessage(ctx.Query, requestID)
	case "DeleteMessage":
		response = h.deleteMessage(ctx.Query, requestID)
	case "DeleteMessageBatch":
		response = h.deleteMessageBatch(ctx.Query, requestID)
	case "ChangeMessageVisibility":
		response = h.changeMessageVisibility(ctx.Query, requestID)
	case "ChangeMessageVisibilityBatch":
		response = h.changeMessageVisibilityBatch(ctx.Query, requestID)
	case "PurgeQueue":
		response = h.purgeQueue(ctx.Query, requestID)
	case "TagQueue":
		response = h.tagQueue(ctx.Query, requestID)
	case "UntagQueue":
		response = h.untagQueue(ctx.Query, requestID)
	case "ListQueueTags":
		response = h.listQueueTags(ctx.Query, requestID)
	default:
		action := ctx.Action
		response = h.queryError("InvalidAction", "The action "+action+" is not valid for this endpoint.", http.StatusBadRequest, requestID)
	}
	return withRequestID(response, requestID)
}

func (h *Handler) handleJSON(req *http.Request, ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	requestID := ctx.RequestID
	if requestID == "" {
		requestID = h.generateID()
	}
	params := jsonParams(ctx.Action, ctx.Input)
	var response protocols.ErrorResponse
	switch ctx.Action {
	case "CreateQueue":
		response = h.createQueueJSON(req, params)
	case "DeleteQueue":
		response = h.deleteQueueJSON(params)
	case "ListQueues":
		response = h.listQueuesJSON(params)
	case "GetQueueUrl":
		response = h.getQueueURLJSON(params)
	case "GetQueueAttributes":
		response = h.getQueueAttributesJSON(params)
	case "SetQueueAttributes":
		response = h.setQueueAttributesJSON(params)
	case "SendMessage":
		response = h.sendMessageJSON(params)
	case "SendMessageBatch":
		response = h.sendMessageBatchJSON(params)
	case "ReceiveMessage":
		response = h.receiveMessageJSON(params)
	case "DeleteMessage":
		response = h.deleteMessageJSON(params)
	case "DeleteMessageBatch":
		response = h.deleteMessageBatchJSON(params)
	case "ChangeMessageVisibility":
		response = h.changeMessageVisibilityJSON(params)
	case "ChangeMessageVisibilityBatch":
		response = h.changeMessageVisibilityBatchJSON(params)
	case "PurgeQueue":
		response = h.purgeQueueJSON(params)
	case "TagQueue":
		response = h.tagQueueJSON(params)
	case "UntagQueue":
		response = h.untagQueueJSON(params)
	case "ListQueueTags":
		response = h.listQueueTagsJSON(params)
	default:
		response = jsonResponse(http.StatusBadRequest, map[string]any{"__type": "InvalidAction", "message": "The action " + ctx.Action + " is not valid for this endpoint."})
	}
	return withRequestID(response, requestID)
}

func (h *Handler) createQueue(req *http.Request, params map[string]string, requestID string) protocols.ErrorResponse {
	queueName := params["QueueName"]
	if queueName == "" {
		return h.queryError("MissingParameter", "The request must contain the parameter QueueName.", http.StatusBadRequest, requestID)
	}
	if existing, ok := h.findQueueByName(queueName); ok {
		return h.queueURLResponse("CreateQueue", stringField(existing, "queue_url"), requestID)
	}
	region := h.region()
	accountID := h.accountID()
	queueURL := strings.TrimRight(h.baseURL(req), "/") + "/sqs/" + accountID + "/" + queueName
	queue := h.Queues.Insert(newQueueRecord(queueName, queueURL, region, accountID, indexedAttributes(params, "Attribute"), indexedTags(params, "Tag")))
	return h.queueURLResponse("CreateQueue", stringField(queue, "queue_url"), requestID)
}

func (h *Handler) deleteQueue(params map[string]string, requestID string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFound(requestID)
	}
	for _, message := range h.Messages.FindBy("queue_name", stringField(queue, "queue_name")) {
		h.Messages.Delete(intField(message, "id"))
	}
	h.Queues.Delete(intField(queue, "id"))
	body := `<?xml version="1.0" encoding="UTF-8"?>
<DeleteQueueResponse>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</DeleteQueueResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) listQueues(params map[string]string, requestID string) protocols.ErrorResponse {
	prefix := params["QueueNamePrefix"]
	var rows strings.Builder
	for _, queue := range h.Queues.All() {
		if prefix != "" && !strings.HasPrefix(stringField(queue, "queue_name"), prefix) {
			continue
		}
		rows.WriteString(`    <QueueUrl>`)
		rows.WriteString(xmlEscape(stringField(queue, "queue_url")))
		rows.WriteString(`</QueueUrl>
`)
	}
	body := `<?xml version="1.0" encoding="UTF-8"?>
<ListQueuesResponse>
  <ListQueuesResult>
` + strings.TrimRight(rows.String(), "\n") + `
  </ListQueuesResult>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</ListQueuesResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) getQueueURL(params map[string]string, requestID string) protocols.ErrorResponse {
	queue, ok := h.findQueueByName(params["QueueName"])
	if !ok {
		return h.queueNotFound(requestID)
	}
	return h.queueURLResponse("GetQueueUrl", stringField(queue, "queue_url"), requestID)
}

func (h *Handler) getQueueAttributes(params map[string]string, requestID string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFound(requestID)
	}
	attrs := selectedQueueAttributes(h.queueAttributeValues(queue), params)
	var rows strings.Builder
	for _, attr := range attrs {
		rows.WriteString(`    <Attribute><Name>`)
		rows.WriteString(xmlEscape(attr.Name))
		rows.WriteString(`</Name><Value>`)
		rows.WriteString(xmlEscape(attr.Value))
		rows.WriteString(`</Value></Attribute>
`)
	}
	body := `<?xml version="1.0" encoding="UTF-8"?>
<GetQueueAttributesResponse>
  <GetQueueAttributesResult>
` + strings.TrimRight(rows.String(), "\n") + `
  </GetQueueAttributesResult>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</GetQueueAttributesResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) setQueueAttributes(params map[string]string, requestID string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFound(requestID)
	}
	h.Queues.Update(intField(queue, "id"), queueAttributePatch(queue, indexedAttributes(params, "Attribute")))
	body := `<?xml version="1.0" encoding="UTF-8"?>
<SetQueueAttributesResponse>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</SetQueueAttributesResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) sendMessage(params map[string]string, requestID string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFound(requestID)
	}
	messageBody := params["MessageBody"]
	if messageBody == "" {
		return h.queryError("MissingParameter", "The request must contain the parameter MessageBody.", http.StatusBadRequest, requestID)
	}
	if len([]byte(messageBody)) > intField(queue, "max_message_size") {
		return h.queryError("InvalidParameterValue", "One or more parameters are invalid. Reason: Message must be shorter than "+strconv.Itoa(intField(queue, "max_message_size"))+" bytes.", http.StatusBadRequest, requestID)
	}
	messageAttributes := parseMessageAttributes(params)
	result := h.enqueueMessage(queue, messageBody, messageAttributes, messageDelaySeconds(params, queue))
	messageAttributesMD5XML := ""
	if result.AttributesMD5 != "" {
		messageAttributesMD5XML = `
    <MD5OfMessageAttributes>` + result.AttributesMD5 + `</MD5OfMessageAttributes>`
	}
	body := `<?xml version="1.0" encoding="UTF-8"?>
<SendMessageResponse>
  <SendMessageResult>
    <MessageId>` + xmlEscape(result.MessageID) + `</MessageId>
    <MD5OfMessageBody>` + result.BodyMD5 + `</MD5OfMessageBody>` + messageAttributesMD5XML + `
  </SendMessageResult>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</SendMessageResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) sendMessageBatch(params map[string]string, requestID string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFound(requestID)
	}
	successful, failed := h.sendMessageBatchEntries(queue, params)
	body := `<?xml version="1.0" encoding="UTF-8"?>
<SendMessageBatchResponse>
  <SendMessageBatchResult>
` + batchSendXML(successful, failed) + `
  </SendMessageBatchResult>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</SendMessageBatchResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) receiveMessage(params map[string]string, requestID string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFound(requestID)
	}
	maxMessages := intParam(params["MaxNumberOfMessages"], 1)
	if maxMessages > 10 {
		maxMessages = 10
	}
	if maxMessages < 1 {
		maxMessages = 1
	}
	visibilityTimeout := intParam(params["VisibilityTimeout"], intField(queue, "visibility_timeout"))
	now := h.nowMillis()
	allMessages := h.Messages.FindBy("queue_name", stringField(queue, "queue_name"))
	batch := make([]corestore.Record, 0, maxMessages)
	for _, message := range allMessages {
		if int64Field(message, "visible_after") > now {
			continue
		}
		updated, ok := h.reserveVisibleMessage(message, now, visibilityTimeout)
		if !ok {
			continue
		}
		batch = append(batch, updated)
		if len(batch) == maxMessages {
			break
		}
	}
	var rows strings.Builder
	for _, message := range batch {
		rows.WriteString(`    <Message>
      <MessageId>`)
		rows.WriteString(xmlEscape(stringField(message, "message_id")))
		rows.WriteString(`</MessageId>
      <ReceiptHandle>`)
		rows.WriteString(xmlEscape(stringField(message, "receipt_handle")))
		rows.WriteString(`</ReceiptHandle>
      <MD5OfBody>`)
		rows.WriteString(xmlEscape(stringField(message, "md5_of_body")))
		rows.WriteString(`</MD5OfBody>
      <Body>`)
		rows.WriteString(xmlEscape(stringField(message, "body")))
		rows.WriteString(`</Body>
`)
		writeSystemAttributesXML(&rows, message, params)
		writeMessageAttributesXML(&rows, message, params)
		rows.WriteString(`    </Message>
`)
	}
	body := `<?xml version="1.0" encoding="UTF-8"?>
<ReceiveMessageResponse>
  <ReceiveMessageResult>
` + strings.TrimRight(rows.String(), "\n") + `
  </ReceiveMessageResult>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</ReceiveMessageResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) deleteMessage(params map[string]string, requestID string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFound(requestID)
	}
	h.deleteReceiptHandle(queue, params["ReceiptHandle"])
	body := `<?xml version="1.0" encoding="UTF-8"?>
<DeleteMessageResponse>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</DeleteMessageResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) deleteMessageBatch(params map[string]string, requestID string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFound(requestID)
	}
	successful, failed := h.deleteMessageBatchEntries(queue, params)
	body := `<?xml version="1.0" encoding="UTF-8"?>
<DeleteMessageBatchResponse>
  <DeleteMessageBatchResult>
` + batchDeleteXML(successful, failed) + `
  </DeleteMessageBatchResult>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</DeleteMessageBatchResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) changeMessageVisibility(params map[string]string, requestID string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFound(requestID)
	}
	if params["ReceiptHandle"] == "" {
		return h.queryError("MissingParameter", "The request must contain the parameter ReceiptHandle.", http.StatusBadRequest, requestID)
	}
	if !h.changeReceiptVisibility(queue, params["ReceiptHandle"], intParam(params["VisibilityTimeout"], intField(queue, "visibility_timeout"))) {
		return h.queryError("ReceiptHandleIsInvalid", "The input receipt handle is invalid.", http.StatusBadRequest, requestID)
	}
	body := `<?xml version="1.0" encoding="UTF-8"?>
<ChangeMessageVisibilityResponse>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</ChangeMessageVisibilityResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) changeMessageVisibilityBatch(params map[string]string, requestID string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFound(requestID)
	}
	successful, failed := h.changeMessageVisibilityBatchEntries(queue, params)
	body := `<?xml version="1.0" encoding="UTF-8"?>
<ChangeMessageVisibilityBatchResponse>
  <ChangeMessageVisibilityBatchResult>
` + batchVisibilityXML(successful, failed) + `
  </ChangeMessageVisibilityBatchResult>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</ChangeMessageVisibilityBatchResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) purgeQueue(params map[string]string, requestID string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFound(requestID)
	}
	for _, message := range h.Messages.FindBy("queue_name", stringField(queue, "queue_name")) {
		h.Messages.Delete(intField(message, "id"))
	}
	body := `<?xml version="1.0" encoding="UTF-8"?>
<PurgeQueueResponse>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</PurgeQueueResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) tagQueue(params map[string]string, requestID string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFound(requestID)
	}
	h.mergeQueueTags(queue, indexedTags(params, "Tag"))
	body := `<?xml version="1.0" encoding="UTF-8"?>
<TagQueueResponse>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</TagQueueResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) untagQueue(params map[string]string, requestID string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFound(requestID)
	}
	h.removeQueueTags(queue, indexedNames(params, "TagKey"))
	body := `<?xml version="1.0" encoding="UTF-8"?>
<UntagQueueResponse>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</UntagQueueResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) listQueueTags(params map[string]string, requestID string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFound(requestID)
	}
	body := `<?xml version="1.0" encoding="UTF-8"?>
<ListQueueTagsResponse>
  <ListQueueTagsResult>
` + queueTagsXML(recordField(queue, "tags")) + `
  </ListQueueTagsResult>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</ListQueueTagsResponse>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) createQueueJSON(req *http.Request, params map[string]string) protocols.ErrorResponse {
	queueName := params["QueueName"]
	if queueName == "" {
		return jsonResponse(http.StatusBadRequest, map[string]any{"__type": "MissingParameter", "message": "The request must contain the parameter QueueName."})
	}
	if existing, ok := h.findQueueByName(queueName); ok {
		return jsonResponse(http.StatusOK, map[string]any{"QueueUrl": stringField(existing, "queue_url")})
	}
	region := h.region()
	accountID := h.accountID()
	queueURL := strings.TrimRight(h.baseURL(req), "/") + "/sqs/" + accountID + "/" + queueName
	h.Queues.Insert(newQueueRecord(queueName, queueURL, region, accountID, indexedAttributes(params, "Attribute"), indexedTags(params, "Tag")))
	return jsonResponse(http.StatusOK, map[string]any{"QueueUrl": queueURL})
}

func (h *Handler) deleteQueueJSON(params map[string]string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFoundJSON()
	}
	for _, message := range h.Messages.FindBy("queue_name", stringField(queue, "queue_name")) {
		h.Messages.Delete(intField(message, "id"))
	}
	h.Queues.Delete(intField(queue, "id"))
	return jsonResponse(http.StatusOK, map[string]any{})
}

func (h *Handler) listQueuesJSON(params map[string]string) protocols.ErrorResponse {
	prefix := params["QueueNamePrefix"]
	queueURLs := []string{}
	for _, queue := range h.Queues.All() {
		if prefix != "" && !strings.HasPrefix(stringField(queue, "queue_name"), prefix) {
			continue
		}
		queueURLs = append(queueURLs, stringField(queue, "queue_url"))
	}
	return jsonResponse(http.StatusOK, map[string]any{"QueueUrls": queueURLs})
}

func (h *Handler) getQueueURLJSON(params map[string]string) protocols.ErrorResponse {
	queue, ok := h.findQueueByName(params["QueueName"])
	if !ok {
		return h.queueNotFoundJSON()
	}
	return jsonResponse(http.StatusOK, map[string]any{"QueueUrl": stringField(queue, "queue_url")})
}

func (h *Handler) getQueueAttributesJSON(params map[string]string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFoundJSON()
	}
	return jsonResponse(http.StatusOK, map[string]any{"Attributes": nameValuesMap(selectedQueueAttributes(h.queueAttributeValues(queue), params))})
}

func (h *Handler) setQueueAttributesJSON(params map[string]string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFoundJSON()
	}
	h.Queues.Update(intField(queue, "id"), queueAttributePatch(queue, indexedAttributes(params, "Attribute")))
	return jsonResponse(http.StatusOK, map[string]any{})
}

func (h *Handler) sendMessageJSON(params map[string]string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFoundJSON()
	}
	messageBody := params["MessageBody"]
	if messageBody == "" {
		return jsonResponse(http.StatusBadRequest, map[string]any{"__type": "MissingParameter", "message": "The request must contain the parameter MessageBody."})
	}
	if len([]byte(messageBody)) > intField(queue, "max_message_size") {
		return jsonResponse(http.StatusBadRequest, map[string]any{"__type": "InvalidParameterValue", "message": "One or more parameters are invalid. Reason: Message must be shorter than " + strconv.Itoa(intField(queue, "max_message_size")) + " bytes."})
	}
	messageAttributes := parseMessageAttributes(params)
	result := h.enqueueMessage(queue, messageBody, messageAttributes, messageDelaySeconds(params, queue))
	response := map[string]any{
		"MD5OfMessageBody": result.BodyMD5,
		"MessageId":        result.MessageID,
	}
	if result.AttributesMD5 != "" {
		response["MD5OfMessageAttributes"] = result.AttributesMD5
	}
	return jsonResponse(http.StatusOK, response)
}

func (h *Handler) sendMessageBatchJSON(params map[string]string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFoundJSON()
	}
	successful, failed := h.sendMessageBatchEntries(queue, params)
	return jsonResponse(http.StatusOK, map[string]any{"Successful": sendBatchJSON(successful), "Failed": batchFailuresJSON(failed)})
}

func (h *Handler) receiveMessageJSON(params map[string]string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFoundJSON()
	}
	maxMessages := intParam(params["MaxNumberOfMessages"], 1)
	if maxMessages > 10 {
		maxMessages = 10
	}
	if maxMessages < 1 {
		maxMessages = 1
	}
	visibilityTimeout := intParam(params["VisibilityTimeout"], intField(queue, "visibility_timeout"))
	now := h.nowMillis()
	messages := make([]map[string]any, 0, maxMessages)
	for _, message := range h.Messages.FindBy("queue_name", stringField(queue, "queue_name")) {
		if int64Field(message, "visible_after") > now {
			continue
		}
		updated, ok := h.reserveVisibleMessage(message, now, visibilityTimeout)
		if !ok {
			continue
		}
		item := map[string]any{
			"MessageId":     stringField(updated, "message_id"),
			"ReceiptHandle": stringField(updated, "receipt_handle"),
			"MD5OfBody":     stringField(updated, "md5_of_body"),
			"Body":          stringField(updated, "body"),
		}
		if attrs := selectedSystemAttributes(updated, params); len(attrs) > 0 {
			item["Attributes"] = attrs
		}
		if attrs := selectedMessageAttributes(updated, params); len(attrs) > 0 {
			item["MessageAttributes"] = attrs
			if md5Value := stringField(updated, "md5_of_message_attributes"); md5Value != "" {
				item["MD5OfMessageAttributes"] = md5Value
			}
		}
		messages = append(messages, item)
		if len(messages) == maxMessages {
			break
		}
	}
	return jsonResponse(http.StatusOK, map[string]any{"Messages": messages})
}

func (h *Handler) deleteMessageJSON(params map[string]string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFoundJSON()
	}
	h.deleteReceiptHandle(queue, params["ReceiptHandle"])
	return jsonResponse(http.StatusOK, map[string]any{})
}

func (h *Handler) deleteMessageBatchJSON(params map[string]string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFoundJSON()
	}
	successful, failed := h.deleteMessageBatchEntries(queue, params)
	return jsonResponse(http.StatusOK, map[string]any{"Successful": batchSuccessIDsJSON(successful), "Failed": batchFailuresJSON(failed)})
}

func (h *Handler) changeMessageVisibilityJSON(params map[string]string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFoundJSON()
	}
	if params["ReceiptHandle"] == "" {
		return jsonResponse(http.StatusBadRequest, map[string]any{"__type": "MissingParameter", "message": "The request must contain the parameter ReceiptHandle."})
	}
	if !h.changeReceiptVisibility(queue, params["ReceiptHandle"], intParam(params["VisibilityTimeout"], intField(queue, "visibility_timeout"))) {
		return jsonResponse(http.StatusBadRequest, map[string]any{"__type": "ReceiptHandleIsInvalid", "message": "The input receipt handle is invalid."})
	}
	return jsonResponse(http.StatusOK, map[string]any{})
}

func (h *Handler) changeMessageVisibilityBatchJSON(params map[string]string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFoundJSON()
	}
	successful, failed := h.changeMessageVisibilityBatchEntries(queue, params)
	return jsonResponse(http.StatusOK, map[string]any{"Successful": batchSuccessIDsJSON(successful), "Failed": batchFailuresJSON(failed)})
}

func (h *Handler) purgeQueueJSON(params map[string]string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFoundJSON()
	}
	for _, message := range h.Messages.FindBy("queue_name", stringField(queue, "queue_name")) {
		h.Messages.Delete(intField(message, "id"))
	}
	return jsonResponse(http.StatusOK, map[string]any{})
}

func (h *Handler) tagQueueJSON(params map[string]string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFoundJSON()
	}
	h.mergeQueueTags(queue, indexedTags(params, "Tag"))
	return jsonResponse(http.StatusOK, map[string]any{})
}

func (h *Handler) untagQueueJSON(params map[string]string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFoundJSON()
	}
	h.removeQueueTags(queue, indexedNames(params, "TagKey"))
	return jsonResponse(http.StatusOK, map[string]any{})
}

func (h *Handler) listQueueTagsJSON(params map[string]string) protocols.ErrorResponse {
	queue, ok := h.findQueueByURL(params["QueueUrl"])
	if !ok {
		return h.queueNotFoundJSON()
	}
	return jsonResponse(http.StatusOK, map[string]any{"Tags": tagsMap(recordField(queue, "tags"))})
}

func (h *Handler) queueURLResponse(action string, queueURL string, requestID string) protocols.ErrorResponse {
	body := `<?xml version="1.0" encoding="UTF-8"?>
<` + action + `Response>
  <` + action + `Result>
    <QueueUrl>` + xmlEscape(queueURL) + `</QueueUrl>
  </` + action + `Result>
  <ResponseMetadata><RequestId>` + xmlEscape(requestID) + `</RequestId></ResponseMetadata>
</` + action + `Response>`
	return xmlResponse(http.StatusOK, body)
}

func (h *Handler) queueNotFound(requestID string) protocols.ErrorResponse {
	return h.queryError("AWS.SimpleQueueService.NonExistentQueue", "The specified queue does not exist.", http.StatusBadRequest, requestID)
}

func (h *Handler) queueNotFoundJSON() protocols.ErrorResponse {
	return jsonResponse(http.StatusBadRequest, map[string]any{"__type": "QueueDoesNotExist", "message": "The specified queue does not exist."})
}

func (h *Handler) queryError(code string, message string, status int, requestID string) protocols.ErrorResponse {
	return protocols.SerializeXMLError(protocols.AWSError{
		Code:       code,
		Message:    message,
		RequestID:  requestID,
		StatusCode: status,
	})
}

func (h *Handler) findQueueByName(queueName string) (corestore.Record, bool) {
	for _, queue := range h.Queues.FindBy("queue_name", queueName) {
		return queue, true
	}
	return nil, false
}

func (h *Handler) findQueueByURL(queueURL string) (corestore.Record, bool) {
	for _, queue := range h.Queues.FindBy("queue_url", queueURL) {
		return queue, true
	}
	return nil, false
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

func (h *Handler) region() string {
	if h.Region != "" {
		return h.Region
	}
	return gateway.DefaultRegion
}

func (h *Handler) accountID() string {
	if h.AccountID != "" {
		return h.AccountID
	}
	return gateway.DefaultAccountID
}

func (h *Handler) baseURL(req *http.Request) string {
	if h.BaseURL != "" {
		return h.BaseURL
	}
	scheme := "http"
	if req.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + req.Host
}

func (h *Handler) generateID() string {
	if h.IDGenerator != nil {
		return h.IDGenerator()
	}
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err == nil {
		return hex.EncodeToString(bytes[0:4]) + "-" + hex.EncodeToString(bytes[4:6]) + "-" + hex.EncodeToString(bytes[6:8]) + "-" + hex.EncodeToString(bytes[8:10]) + "-" + hex.EncodeToString(bytes[10:16])
	}
	return fmt.Sprintf("msg-%d", fallbackIDCounter.Add(1))
}

func (h *Handler) generateReceiptHandle() string {
	if h.ReceiptGenerator != nil {
		return h.ReceiptGenerator()
	}
	var bytes [48]byte
	if _, err := rand.Read(bytes[:]); err == nil {
		return base64.RawURLEncoding.EncodeToString(bytes[:])
	}
	return fmt.Sprintf("receipt-%d", fallbackIDCounter.Add(1))
}

func xmlResponse(status int, body string) protocols.ErrorResponse {
	return protocols.ErrorResponse{
		StatusCode:  status,
		ContentType: "application/xml",
		Headers:     map[string]string{"Content-Type": "application/xml"},
		Body:        []byte(body),
	}
}

func jsonResponse(status int, value any) protocols.ErrorResponse {
	body, _ := json.Marshal(value)
	return protocols.ErrorResponse{
		StatusCode:  status,
		ContentType: "application/x-amz-json-1.0",
		Headers:     map[string]string{"Content-Type": "application/x-amz-json-1.0"},
		Body:        body,
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

func newQueueRecord(queueName string, queueURL string, region string, accountID string, attrs map[string]string, tags corestore.Record) corestore.Record {
	queue := corestore.Record{
		"queue_name":                queueName,
		"queue_url":                 queueURL,
		"arn":                       "arn:aws:sqs:" + region + ":" + accountID + ":" + queueName,
		"visibility_timeout":        30,
		"delay_seconds":             0,
		"max_message_size":          262144,
		"message_retention_period":  345600,
		"receive_message_wait_time": 0,
		"fifo":                      strings.HasSuffix(queueName, ".fifo"),
		"tags":                      tags,
		"extra_attributes":          corestore.Record{},
	}
	for key, value := range queueAttributePatch(queue, attrs) {
		queue[key] = value
	}
	return queue
}

var queueAttributeOrder = []string{
	"QueueArn",
	"ApproximateNumberOfMessages",
	"ApproximateNumberOfMessagesNotVisible",
	"VisibilityTimeout",
	"MaximumMessageSize",
	"MessageRetentionPeriod",
	"DelaySeconds",
	"ReceiveMessageWaitTimeSeconds",
	"FifoQueue",
}

func (h *Handler) queueAttributeValues(queue corestore.Record) map[string]string {
	now := h.nowMillis()
	visibleCount := 0
	inFlightCount := 0
	for _, message := range h.Messages.FindBy("queue_name", stringField(queue, "queue_name")) {
		if int64Field(message, "visible_after") <= now {
			visibleCount++
		} else {
			inFlightCount++
		}
	}
	attrs := map[string]string{
		"QueueArn":                              stringField(queue, "arn"),
		"ApproximateNumberOfMessages":           strconv.Itoa(visibleCount),
		"ApproximateNumberOfMessagesNotVisible": strconv.Itoa(inFlightCount),
		"VisibilityTimeout":                     strconv.Itoa(intField(queue, "visibility_timeout")),
		"MaximumMessageSize":                    strconv.Itoa(intField(queue, "max_message_size")),
		"MessageRetentionPeriod":                strconv.Itoa(intField(queue, "message_retention_period")),
		"DelaySeconds":                          strconv.Itoa(intField(queue, "delay_seconds")),
		"ReceiveMessageWaitTimeSeconds":         strconv.Itoa(intField(queue, "receive_message_wait_time")),
		"FifoQueue":                             strconv.FormatBool(boolField(queue, "fifo")),
	}
	for name, value := range recordField(queue, "extra_attributes") {
		attrs[name] = scalarString(value)
	}
	return attrs
}

func queueAttributePatch(queue corestore.Record, attrs map[string]string) corestore.Record {
	patch := corestore.Record{}
	extra := cloneRecord(recordField(queue, "extra_attributes"))
	for name, value := range attrs {
		switch name {
		case "VisibilityTimeout":
			patch["visibility_timeout"] = intParam(value, intField(queue, "visibility_timeout"))
		case "DelaySeconds":
			patch["delay_seconds"] = intParam(value, intField(queue, "delay_seconds"))
		case "MaximumMessageSize":
			patch["max_message_size"] = intParam(value, intField(queue, "max_message_size"))
		case "MessageRetentionPeriod":
			patch["message_retention_period"] = intParam(value, intField(queue, "message_retention_period"))
		case "ReceiveMessageWaitTimeSeconds":
			patch["receive_message_wait_time"] = intParam(value, intField(queue, "receive_message_wait_time"))
		case "FifoQueue":
			patch["fifo"] = strings.EqualFold(value, "true")
		default:
			if name != "" {
				extra[name] = value
			}
		}
	}
	if len(extra) > 0 || len(recordField(queue, "extra_attributes")) > 0 {
		patch["extra_attributes"] = extra
	}
	return patch
}

func selectedQueueAttributes(attrs map[string]string, params map[string]string) []nameValue {
	requested := indexedNames(params, "AttributeName")
	if len(requested) == 0 {
		return orderedQueueAttributes(attrs)
	}
	selected := map[string]string{}
	for _, request := range requested {
		if request == "All" || request == ".*" {
			for name, value := range attrs {
				selected[name] = value
			}
			continue
		}
		if strings.HasSuffix(request, ".*") {
			prefix := strings.TrimSuffix(request, ".*")
			for name, value := range attrs {
				if strings.HasPrefix(name, prefix) {
					selected[name] = value
				}
			}
			continue
		}
		if value, ok := attrs[request]; ok {
			selected[request] = value
		}
	}
	return orderedQueueAttributes(selected)
}

func orderedQueueAttributes(attrs map[string]string) []nameValue {
	rows := []nameValue{}
	seen := map[string]bool{}
	for _, name := range queueAttributeOrder {
		value, ok := attrs[name]
		if !ok {
			continue
		}
		rows = append(rows, nameValue{Name: name, Value: value})
		seen[name] = true
	}
	extra := make([]string, 0, len(attrs))
	for name := range attrs {
		if !seen[name] {
			extra = append(extra, name)
		}
	}
	sort.Strings(extra)
	for _, name := range extra {
		rows = append(rows, nameValue{Name: name, Value: attrs[name]})
	}
	return rows
}

func nameValuesMap(values []nameValue) map[string]string {
	result := map[string]string{}
	for _, value := range values {
		result[value.Name] = value.Value
	}
	return result
}

func (h *Handler) enqueueMessage(queue corestore.Record, messageBody string, messageAttributes corestore.Record, delaySeconds int) batchSendResult {
	messageID := h.generateID()
	bodyMD5 := md5Hex(messageBody)
	messageAttributesMD5 := md5OfMessageAttributes(messageAttributes)
	now := h.nowMillis()
	h.Messages.Insert(corestore.Record{
		"queue_name":                stringField(queue, "queue_name"),
		"message_id":                messageID,
		"receipt_handle":            h.generateReceiptHandle(),
		"body":                      messageBody,
		"md5_of_body":               bodyMD5,
		"md5_of_message_attributes": messageAttributesMD5,
		"first_receive_timestamp":   int64(0),
		"attributes": corestore.Record{
			"SentTimestamp":                    strconv.FormatInt(now, 10),
			"ApproximateReceiveCount":          "0",
			"ApproximateFirstReceiveTimestamp": "",
			"SenderId":                         h.accountID(),
		},
		"message_attributes": messageAttributes,
		"visible_after":      now + int64(delaySeconds)*1000,
		"sent_timestamp":     now,
		"receive_count":      0,
	})
	return batchSendResult{MessageID: messageID, BodyMD5: bodyMD5, AttributesMD5: messageAttributesMD5}
}

func (h *Handler) sendMessageBatchEntries(queue corestore.Record, params map[string]string) ([]batchSendResult, []batchResultError) {
	successful := []batchSendResult{}
	failed := []batchResultError{}
	for _, prefix := range indexedBatchEntryPrefixes(params, "SendMessageBatchRequestEntry") {
		id := params[prefix+".Id"]
		messageBody := params[prefix+".MessageBody"]
		if id == "" {
			failed = append(failed, batchError(id, "MissingParameter", "Each batch entry must contain an Id."))
			continue
		}
		if messageBody == "" {
			failed = append(failed, batchError(id, "MissingParameter", "Each batch entry must contain a MessageBody."))
			continue
		}
		if len([]byte(messageBody)) > intField(queue, "max_message_size") {
			failed = append(failed, batchError(id, "InvalidParameterValue", "Message must be shorter than "+strconv.Itoa(intField(queue, "max_message_size"))+" bytes."))
			continue
		}
		result := h.enqueueMessage(queue, messageBody, parseMessageAttributesAt(params, prefix+".MessageAttribute"), intParam(params[prefix+".DelaySeconds"], intField(queue, "delay_seconds")))
		result.ID = id
		successful = append(successful, result)
	}
	return successful, failed
}

func (h *Handler) deleteMessageBatchEntries(queue corestore.Record, params map[string]string) ([]string, []batchResultError) {
	successful := []string{}
	failed := []batchResultError{}
	for _, prefix := range indexedBatchEntryPrefixes(params, "DeleteMessageBatchRequestEntry") {
		id := params[prefix+".Id"]
		receiptHandle := params[prefix+".ReceiptHandle"]
		if id == "" {
			failed = append(failed, batchError(id, "MissingParameter", "Each batch entry must contain an Id."))
			continue
		}
		if receiptHandle == "" {
			failed = append(failed, batchError(id, "MissingParameter", "Each batch entry must contain a ReceiptHandle."))
			continue
		}
		h.deleteReceiptHandle(queue, receiptHandle)
		successful = append(successful, id)
	}
	return successful, failed
}

func (h *Handler) changeMessageVisibilityBatchEntries(queue corestore.Record, params map[string]string) ([]string, []batchResultError) {
	successful := []string{}
	failed := []batchResultError{}
	for _, prefix := range indexedBatchEntryPrefixes(params, "ChangeMessageVisibilityBatchRequestEntry") {
		id := params[prefix+".Id"]
		receiptHandle := params[prefix+".ReceiptHandle"]
		if id == "" {
			failed = append(failed, batchError(id, "MissingParameter", "Each batch entry must contain an Id."))
			continue
		}
		if receiptHandle == "" {
			failed = append(failed, batchError(id, "MissingParameter", "Each batch entry must contain a ReceiptHandle."))
			continue
		}
		visibilityTimeout := intParam(params[prefix+".VisibilityTimeout"], intField(queue, "visibility_timeout"))
		if !h.changeReceiptVisibility(queue, receiptHandle, visibilityTimeout) {
			failed = append(failed, batchError(id, "ReceiptHandleIsInvalid", "The input receipt handle is invalid."))
			continue
		}
		successful = append(successful, id)
	}
	return successful, failed
}

func (h *Handler) deleteReceiptHandle(queue corestore.Record, receiptHandle string) bool {
	for _, message := range h.Messages.FindBy("queue_name", stringField(queue, "queue_name")) {
		if stringField(message, "receipt_handle") == receiptHandle {
			return h.Messages.Delete(intField(message, "id"))
		}
	}
	return false
}

func (h *Handler) changeReceiptVisibility(queue corestore.Record, receiptHandle string, visibilityTimeout int) bool {
	now := h.nowMillis()
	for _, message := range h.Messages.FindBy("queue_name", stringField(queue, "queue_name")) {
		if stringField(message, "receipt_handle") == receiptHandle {
			_, ok := h.Messages.Update(intField(message, "id"), corestore.Record{"visible_after": now + int64(visibilityTimeout)*1000})
			return ok
		}
	}
	return false
}

func indexedBatchEntryPrefixes(params map[string]string, prefix string) []string {
	prefixes := []string{}
	for index := 1; ; index++ {
		base := prefix + "." + strconv.Itoa(index)
		if params[base+".Id"] == "" && params[base+".MessageBody"] == "" && params[base+".ReceiptHandle"] == "" {
			break
		}
		prefixes = append(prefixes, base)
	}
	return prefixes
}

type batchSendResult struct {
	ID            string
	MessageID     string
	BodyMD5       string
	AttributesMD5 string
}

type batchResultError struct {
	ID          string
	Code        string
	Message     string
	SenderFault bool
}

func batchError(id string, code string, message string) batchResultError {
	return batchResultError{ID: id, Code: code, Message: message, SenderFault: true}
}

func batchSendXML(successful []batchSendResult, failed []batchResultError) string {
	var rows strings.Builder
	for _, result := range successful {
		rows.WriteString(`    <SendMessageBatchResultEntry><Id>`)
		rows.WriteString(xmlEscape(result.ID))
		rows.WriteString(`</Id><MessageId>`)
		rows.WriteString(xmlEscape(result.MessageID))
		rows.WriteString(`</MessageId><MD5OfMessageBody>`)
		rows.WriteString(result.BodyMD5)
		rows.WriteString(`</MD5OfMessageBody>`)
		if result.AttributesMD5 != "" {
			rows.WriteString(`<MD5OfMessageAttributes>`)
			rows.WriteString(result.AttributesMD5)
			rows.WriteString(`</MD5OfMessageAttributes>`)
		}
		rows.WriteString(`</SendMessageBatchResultEntry>
`)
	}
	writeBatchErrorsXML(&rows, failed)
	return strings.TrimRight(rows.String(), "\n")
}

func batchDeleteXML(successful []string, failed []batchResultError) string {
	var rows strings.Builder
	for _, id := range successful {
		rows.WriteString(`    <DeleteMessageBatchResultEntry><Id>`)
		rows.WriteString(xmlEscape(id))
		rows.WriteString(`</Id></DeleteMessageBatchResultEntry>
`)
	}
	writeBatchErrorsXML(&rows, failed)
	return strings.TrimRight(rows.String(), "\n")
}

func batchVisibilityXML(successful []string, failed []batchResultError) string {
	var rows strings.Builder
	for _, id := range successful {
		rows.WriteString(`    <ChangeMessageVisibilityBatchResultEntry><Id>`)
		rows.WriteString(xmlEscape(id))
		rows.WriteString(`</Id></ChangeMessageVisibilityBatchResultEntry>
`)
	}
	writeBatchErrorsXML(&rows, failed)
	return strings.TrimRight(rows.String(), "\n")
}

func writeBatchErrorsXML(rows *strings.Builder, failed []batchResultError) {
	for _, failure := range failed {
		rows.WriteString(`    <BatchResultErrorEntry><Id>`)
		rows.WriteString(xmlEscape(failure.ID))
		rows.WriteString(`</Id><SenderFault>`)
		rows.WriteString(strconv.FormatBool(failure.SenderFault))
		rows.WriteString(`</SenderFault><Code>`)
		rows.WriteString(xmlEscape(failure.Code))
		rows.WriteString(`</Code><Message>`)
		rows.WriteString(xmlEscape(failure.Message))
		rows.WriteString(`</Message></BatchResultErrorEntry>
`)
	}
}

func sendBatchJSON(successful []batchSendResult) []map[string]any {
	results := make([]map[string]any, 0, len(successful))
	for _, result := range successful {
		item := map[string]any{
			"Id":               result.ID,
			"MessageId":        result.MessageID,
			"MD5OfMessageBody": result.BodyMD5,
		}
		if result.AttributesMD5 != "" {
			item["MD5OfMessageAttributes"] = result.AttributesMD5
		}
		results = append(results, item)
	}
	return results
}

func batchSuccessIDsJSON(successful []string) []map[string]string {
	results := make([]map[string]string, 0, len(successful))
	for _, id := range successful {
		results = append(results, map[string]string{"Id": id})
	}
	return results
}

func batchFailuresJSON(failed []batchResultError) []map[string]any {
	results := make([]map[string]any, 0, len(failed))
	for _, failure := range failed {
		results = append(results, map[string]any{
			"Id":          failure.ID,
			"SenderFault": failure.SenderFault,
			"Code":        failure.Code,
			"Message":     failure.Message,
		})
	}
	return results
}

func indexedTags(params map[string]string, prefix string) corestore.Record {
	tags := corestore.Record{}
	for index := 1; ; index++ {
		base := prefix + "." + strconv.Itoa(index)
		key := params[base+".Key"]
		if key == "" {
			break
		}
		tags[key] = params[base+".Value"]
	}
	return tags
}

func (h *Handler) mergeQueueTags(queue corestore.Record, additions corestore.Record) {
	h.Queues.UpdateFunc(intField(queue, "id"), func(current corestore.Record) (corestore.Record, bool) {
		tags := cloneRecord(recordField(current, "tags"))
		for name, value := range additions {
			tags[name] = scalarString(value)
		}
		return corestore.Record{"tags": tags}, true
	})
}

func (h *Handler) removeQueueTags(queue corestore.Record, names []string) {
	h.Queues.UpdateFunc(intField(queue, "id"), func(current corestore.Record) (corestore.Record, bool) {
		tags := cloneRecord(recordField(current, "tags"))
		for _, name := range names {
			delete(tags, name)
		}
		return corestore.Record{"tags": tags}, true
	})
}

func queueTagsXML(tags corestore.Record) string {
	var rows strings.Builder
	for _, name := range sortedRecordKeys(tags) {
		rows.WriteString(`    <Tag><Key>`)
		rows.WriteString(xmlEscape(name))
		rows.WriteString(`</Key><Value>`)
		rows.WriteString(xmlEscape(scalarString(tags[name])))
		rows.WriteString(`</Value></Tag>
`)
	}
	return strings.TrimRight(rows.String(), "\n")
}

func tagsMap(tags corestore.Record) map[string]string {
	result := map[string]string{}
	for _, name := range sortedRecordKeys(tags) {
		result[name] = scalarString(tags[name])
	}
	return result
}

func jsonParams(action string, input map[string]any) map[string]string {
	params := map[string]string{}
	attributeIndex := 1
	for key, value := range input {
		switch key {
		case "Attributes":
			if values, ok := value.(map[string]any); ok {
				for name, attrValue := range values {
					index := strconv.Itoa(attributeIndex)
					params["Attribute."+index+".Name"] = name
					params["Attribute."+index+".Value"] = scalarString(attrValue)
					attributeIndex++
				}
			}
		case "MessageAttributes":
			addJSONMessageAttributes(params, "MessageAttribute", value)
		case "AttributeNames":
			addJSONListParams(params, "AttributeName", value)
		case "MessageAttributeNames":
			addJSONListParams(params, "MessageAttributeName", value)
		case "MessageSystemAttributeNames":
			addJSONListParams(params, "MessageSystemAttributeName", value)
		case "Entries":
			addJSONBatchEntries(params, action, value)
		case "Tags", "tags":
			addJSONTags(params, "Tag", value)
		case "TagKeys":
			addJSONListParams(params, "TagKey", value)
		default:
			params[key] = scalarString(value)
		}
	}
	return params
}

func addJSONBatchEntries(params map[string]string, action string, value any) {
	prefix := ""
	switch action {
	case "SendMessageBatch":
		prefix = "SendMessageBatchRequestEntry"
	case "DeleteMessageBatch":
		prefix = "DeleteMessageBatchRequestEntry"
	case "ChangeMessageVisibilityBatch":
		prefix = "ChangeMessageVisibilityBatchRequestEntry"
	default:
		return
	}
	values, ok := value.([]any)
	if !ok {
		return
	}
	for index, item := range values {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		base := prefix + "." + strconv.Itoa(index+1)
		for name, rawValue := range entry {
			if name == "MessageAttributes" {
				addJSONMessageAttributes(params, base+".MessageAttribute", rawValue)
				continue
			}
			params[base+"."+name] = scalarString(rawValue)
		}
	}
}

func addJSONMessageAttributes(params map[string]string, prefix string, value any) {
	values, ok := value.(map[string]any)
	if !ok {
		return
	}
	index := 1
	for _, name := range sortedAnyKeys(values) {
		attr, ok := values[name].(map[string]any)
		if !ok {
			continue
		}
		attrPrefix := prefix + "." + strconv.Itoa(index)
		params[attrPrefix+".Name"] = name
		params[attrPrefix+".Value.DataType"] = scalarString(attr["DataType"])
		params[attrPrefix+".Value.StringValue"] = scalarString(attr["StringValue"])
		params[attrPrefix+".Value.BinaryValue"] = scalarString(attr["BinaryValue"])
		index++
	}
}

func addJSONTags(params map[string]string, prefix string, value any) {
	values, ok := value.(map[string]any)
	if !ok {
		return
	}
	for index, key := range sortedAnyKeys(values) {
		base := prefix + "." + strconv.Itoa(index+1)
		params[base+".Key"] = key
		params[base+".Value"] = scalarString(values[key])
	}
}

func sortedAnyKeys(values map[string]any) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func addJSONListParams(params map[string]string, prefix string, value any) {
	switch values := value.(type) {
	case []any:
		for index, item := range values {
			params[prefix+"."+strconv.Itoa(index+1)] = scalarString(item)
		}
	case []string:
		for index, item := range values {
			params[prefix+"."+strconv.Itoa(index+1)] = item
		}
	default:
		if raw := scalarString(value); raw != "" {
			params[prefix+".1"] = raw
		}
	}
}

func scalarString(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return v
	case json.Number:
		return v.String()
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(v)
	default:
		return fmt.Sprint(v)
	}
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

func parseMessageAttributes(params map[string]string) corestore.Record {
	return parseMessageAttributesAt(params, "MessageAttribute")
}

func parseMessageAttributesAt(params map[string]string, prefix string) corestore.Record {
	attrs := corestore.Record{}
	for index := 1; ; index++ {
		itemPrefix := prefix + "." + strconv.Itoa(index)
		name := params[itemPrefix+".Name"]
		if name == "" {
			break
		}
		value := corestore.Record{
			"DataType": params[itemPrefix+".Value.DataType"],
		}
		if stringValue := params[itemPrefix+".Value.StringValue"]; stringValue != "" {
			value["StringValue"] = stringValue
		}
		if binaryValue := params[itemPrefix+".Value.BinaryValue"]; binaryValue != "" {
			value["BinaryValue"] = binaryValue
		}
		attrs[name] = value
	}
	return attrs
}

func messageDelaySeconds(params map[string]string, queue corestore.Record) int {
	return intParam(params["DelaySeconds"], intField(queue, "delay_seconds"))
}

func (h *Handler) reserveVisibleMessage(message corestore.Record, now int64, visibilityTimeout int) (corestore.Record, bool) {
	receiptHandle := h.generateReceiptHandle()
	return h.Messages.UpdateFunc(intField(message, "id"), func(current corestore.Record) (corestore.Record, bool) {
		if int64Field(current, "visible_after") > now {
			return nil, false
		}
		patch := corestore.Record{
			"receipt_handle": receiptHandle,
			"visible_after":  now + int64(visibilityTimeout)*1000,
			"receive_count":  intField(current, "receive_count") + 1,
		}
		if int64Field(current, "first_receive_timestamp") == 0 {
			patch["first_receive_timestamp"] = now
		}
		return patch, true
	})
}

var systemAttributeOrder = []string{
	"SenderId",
	"SentTimestamp",
	"ApproximateReceiveCount",
	"ApproximateFirstReceiveTimestamp",
}

func selectedSystemAttributes(message corestore.Record, params map[string]string) map[string]string {
	requested := indexedNames(params, "AttributeName")
	requested = append(requested, indexedNames(params, "MessageSystemAttributeName")...)
	if len(requested) == 0 {
		return map[string]string{}
	}
	available := systemAttributes(message)
	selected := map[string]string{}
	for _, request := range requested {
		if request == "All" || request == ".*" {
			for name, value := range available {
				selected[name] = value
			}
			continue
		}
		if strings.HasSuffix(request, ".*") {
			prefix := strings.TrimSuffix(request, ".*")
			for name, value := range available {
				if strings.HasPrefix(name, prefix) {
					selected[name] = value
				}
			}
			continue
		}
		if value, ok := available[request]; ok {
			selected[request] = value
		}
	}
	return selected
}

func systemAttributes(message corestore.Record) map[string]string {
	firstReceiveTimestamp := int64Field(message, "first_receive_timestamp")
	if firstReceiveTimestamp == 0 {
		firstReceiveTimestamp = int64Field(message, "sent_timestamp")
	}
	attributes := recordField(message, "attributes")
	senderID := stringField(attributes, "SenderId")
	return map[string]string{
		"SenderId":                         senderID,
		"SentTimestamp":                    strconv.FormatInt(int64Field(message, "sent_timestamp"), 10),
		"ApproximateReceiveCount":          strconv.Itoa(intField(message, "receive_count")),
		"ApproximateFirstReceiveTimestamp": strconv.FormatInt(firstReceiveTimestamp, 10),
	}
}

func selectedMessageAttributes(message corestore.Record, params map[string]string) corestore.Record {
	attrs := recordField(message, "message_attributes")
	if len(attrs) == 0 {
		return corestore.Record{}
	}
	requested := indexedNames(params, "MessageAttributeName")
	if len(requested) == 0 {
		return corestore.Record{}
	}
	selected := corestore.Record{}
	for _, request := range requested {
		if request == "All" || request == ".*" {
			for name, value := range attrs {
				selected[name] = cloneAttributeValue(value)
			}
			continue
		}
		if strings.HasSuffix(request, ".*") {
			prefix := strings.TrimSuffix(request, ".*")
			for name, value := range attrs {
				if strings.HasPrefix(name, prefix) {
					selected[name] = cloneAttributeValue(value)
				}
			}
			continue
		}
		if value, ok := attrs[request]; ok {
			selected[request] = cloneAttributeValue(value)
		}
	}
	return selected
}

func indexedNames(params map[string]string, prefix string) []string {
	names := []string{}
	for index := 1; ; index++ {
		name := params[prefix+"."+strconv.Itoa(index)]
		if name == "" {
			break
		}
		names = append(names, name)
	}
	return names
}

func writeSystemAttributesXML(rows *strings.Builder, message corestore.Record, params map[string]string) {
	attrs := selectedSystemAttributes(message, params)
	for _, name := range systemAttributeOrder {
		value, ok := attrs[name]
		if !ok {
			continue
		}
		rows.WriteString(`      <Attribute><Name>`)
		rows.WriteString(xmlEscape(name))
		rows.WriteString(`</Name><Value>`)
		rows.WriteString(xmlEscape(value))
		rows.WriteString(`</Value></Attribute>
`)
	}
}

func writeMessageAttributesXML(rows *strings.Builder, message corestore.Record, params map[string]string) {
	attrs := selectedMessageAttributes(message, params)
	if len(attrs) > 0 {
		if md5Value := stringField(message, "md5_of_message_attributes"); md5Value != "" {
			rows.WriteString(`      <MD5OfMessageAttributes>`)
			rows.WriteString(md5Value)
			rows.WriteString(`</MD5OfMessageAttributes>
`)
		}
	}
	names := sortedRecordKeys(attrs)
	for _, name := range names {
		value := recordValue(attrs[name])
		rows.WriteString(`      <MessageAttribute><Name>`)
		rows.WriteString(xmlEscape(name))
		rows.WriteString(`</Name><Value><DataType>`)
		rows.WriteString(xmlEscape(stringField(value, "DataType")))
		rows.WriteString(`</DataType>`)
		if stringValue := stringField(value, "StringValue"); stringValue != "" {
			rows.WriteString(`<StringValue>`)
			rows.WriteString(xmlEscape(stringValue))
			rows.WriteString(`</StringValue>`)
		}
		if binaryValue := stringField(value, "BinaryValue"); binaryValue != "" {
			rows.WriteString(`<BinaryValue>`)
			rows.WriteString(xmlEscape(binaryValue))
			rows.WriteString(`</BinaryValue>`)
		}
		rows.WriteString(`</Value></MessageAttribute>
`)
	}
}

func sortedRecordKeys(record corestore.Record) []string {
	keys := make([]string, 0, len(record))
	for key := range record {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func recordField(record corestore.Record, name string) corestore.Record {
	return recordValue(record[name])
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

func cloneAttributeValue(value any) corestore.Record {
	source := recordValue(value)
	return cloneRecord(source)
}

func cloneRecord(source corestore.Record) corestore.Record {
	clone := corestore.Record{}
	for key, item := range source {
		clone[key] = item
	}
	return clone
}

func intParam(raw string, fallback int) int {
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return value
}

func stringField(record corestore.Record, name string) string {
	switch value := record[name].(type) {
	case string:
		return value
	default:
		if value == nil {
			return ""
		}
		return fmt.Sprint(value)
	}
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

func int64Field(record corestore.Record, name string) int64 {
	switch value := record[name].(type) {
	case int64:
		return value
	case int:
		return int64(value)
	case float64:
		return int64(value)
	default:
		return 0
	}
}

func boolField(record corestore.Record, name string) bool {
	value, _ := record[name].(bool)
	return value
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
	for _, name := range sortedRecordKeys(attrs) {
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

type nameValue struct {
	Name  string
	Value string
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
