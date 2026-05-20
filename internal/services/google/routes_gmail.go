package google

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	corehttp "github.com/vercel-labs/emulate/internal/core/http"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
)

func (s *Service) registerGmailRoutes(router *corehttp.Router) {
	router.Get("/gmail/v1/users/:userId/messages", s.handleListMessages)
	router.Post("/gmail/v1/users/:userId/messages/batchModify", s.handleBatchModifyMessages)
	router.Post("/gmail/v1/users/:userId/messages/batchDelete", s.handleBatchDeleteMessages)
	router.Post("/gmail/v1/users/:userId/messages/import", s.handleImportMessage)
	router.Post("/upload/gmail/v1/users/:userId/messages/import", s.handleImportMessage)
	router.Post("/gmail/v1/users/:userId/messages/send", s.handleSendMessage)
	router.Post("/upload/gmail/v1/users/:userId/messages/send", s.handleSendMessage)
	router.Post("/gmail/v1/users/:userId/messages", s.handleInsertMessage)
	router.Post("/upload/gmail/v1/users/:userId/messages", s.handleInsertMessage)
	router.Get("/gmail/v1/users/:userId/messages/:messageId/attachments/:id", s.handleGetAttachment)
	router.Get("/gmail/v1/users/:userId/messages/:id", s.handleGetMessage)
	router.Post("/gmail/v1/users/:userId/messages/:id/modify", s.handleModifyMessage)
	router.Post("/gmail/v1/users/:userId/messages/:id/trash", s.handleTrashMessage)
	router.Post("/gmail/v1/users/:userId/messages/:id/untrash", s.handleUntrashMessage)
	router.Delete("/gmail/v1/users/:userId/messages/:id", s.handleDeleteMessage)

	router.Get("/gmail/v1/users/:userId/drafts", s.handleListDrafts)
	router.Post("/gmail/v1/users/:userId/drafts", s.handleCreateDraft)
	router.Post("/upload/gmail/v1/users/:userId/drafts", s.handleCreateDraft)
	router.Get("/gmail/v1/users/:userId/drafts/:id", s.handleGetDraft)
	router.Put("/gmail/v1/users/:userId/drafts/:id", s.handleUpdateDraft)
	router.Post("/gmail/v1/users/:userId/drafts/send", s.handleSendDraftFromBody)
	router.Post("/upload/gmail/v1/users/:userId/drafts/send", s.handleSendDraftFromBody)
	router.Post("/gmail/v1/users/:userId/drafts/:id/send", s.handleSendDraftByID)
	router.Delete("/gmail/v1/users/:userId/drafts/:id", s.handleDeleteDraft)

	router.Get("/gmail/v1/users/:userId/threads", s.handleListThreads)
	router.Get("/gmail/v1/users/:userId/threads/:id", s.handleGetThread)
	router.Post("/gmail/v1/users/:userId/threads/:id/modify", s.handleModifyThread)
	router.Post("/gmail/v1/users/:userId/threads/:id/trash", s.handleTrashThread)
	router.Post("/gmail/v1/users/:userId/threads/:id/untrash", s.handleUntrashThread)
	router.Delete("/gmail/v1/users/:userId/threads/:id", s.handleDeleteThread)

	router.Get("/gmail/v1/users/:userId/labels", s.handleListLabels)
	router.Post("/gmail/v1/users/:userId/labels", s.handleCreateLabel)
	router.Get("/gmail/v1/users/:userId/labels/:id", s.handleGetLabel)
	router.Patch("/gmail/v1/users/:userId/labels/:id", s.handlePatchLabel)
	router.Put("/gmail/v1/users/:userId/labels/:id", s.handlePatchLabel)
	router.Delete("/gmail/v1/users/:userId/labels/:id", s.handleDeleteLabel)

	router.Get("/gmail/v1/users/:userId/settings/sendAs", s.handleListSendAs)
	router.Get("/gmail/v1/users/:userId/settings/forwardingAddresses", s.handleListForwardingAddresses)
	router.Get("/gmail/v1/users/:userId/settings/filters", s.handleListFilters)
	router.Post("/gmail/v1/users/:userId/settings/filters", s.handleCreateFilter)
	router.Delete("/gmail/v1/users/:userId/settings/filters/:id", s.handleDeleteFilter)

	router.Post("/gmail/v1/users/:userId/watch", s.handleWatch)
	router.Post("/gmail/v1/users/:userId/stop", s.handleStop)
	router.Get("/gmail/v1/users/:userId/history", s.handleListHistory)
}

func (s *Service) handleListMessages(c *corehttp.Context) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	messages := s.listMessages(email, c.Request.URL.Query())
	offset := parseOffset(c.Query("pageToken"))
	limit := normalizeLimit(c.Query("maxResults"), 100, 500)
	page := pageRecords(messages, offset, limit)
	out := make([]map[string]string, 0, len(page))
	for _, message := range page {
		out = append(out, map[string]string{"id": stringField(message, "gmail_id"), "threadId": stringField(message, "thread_id")})
	}
	body := map[string]any{"messages": out, "resultSizeEstimate": len(messages)}
	if offset+limit < len(messages) {
		body["nextPageToken"] = strconv.Itoa(offset + limit)
	}
	c.JSON(http.StatusOK, body)
}

func (s *Service) handleGetMessage(c *corehttp.Context) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	message := s.getMessageByID(email, c.Param("id"))
	if message == nil {
		googleAPIError(c, http.StatusNotFound, "Requested entity was not found.", "notFound", "NOT_FOUND")
		return
	}
	c.JSON(http.StatusOK, formatMessageResource(s, message, c.Query("format"), c.Request.URL.Query()["metadataHeaders"]))
}

func (s *Service) handleGetAttachment(c *corehttp.Context) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	if s.getMessageByID(email, c.Param("messageId")) == nil {
		googleAPIError(c, http.StatusNotFound, "Requested entity was not found.", "notFound", "NOT_FOUND")
		return
	}
	for _, attachment := range s.store.Attachments.FindBy("message_gmail_id", c.Param("messageId")) {
		if stringField(attachment, "user_email") == email && stringField(attachment, "gmail_id") == c.Param("id") {
			c.JSON(http.StatusOK, map[string]any{
				"attachmentId": stringField(attachment, "gmail_id"),
				"size":         intField(attachment, "size"),
				"data":         stringField(attachment, "data"),
			})
			return
		}
	}
	googleAPIError(c, http.StatusNotFound, "Requested entity was not found.", "notFound", "NOT_FOUND")
}

func (s *Service) handleImportMessage(c *corehttp.Context) {
	s.createMessageFromRequest(c, "import")
}

func (s *Service) handleSendMessage(c *corehttp.Context) {
	s.createMessageFromRequest(c, "send")
}

func (s *Service) handleInsertMessage(c *corehttp.Context) {
	s.createMessageFromRequest(c, "insert")
}

func (s *Service) createMessageFromRequest(c *corehttp.Context, mode string) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	body := parseJSONBody(c.Request)
	labelIDs := getStringArray(body, "labelIds")
	defaultLabels := labelIDs
	switch {
	case mode == "send":
		defaultLabels = dedupeStrings(append(defaultLabels, "SENT"))
	case mode == "import" && len(defaultLabels) == 0:
		defaultLabels = []string{"INBOX", "UNREAD"}
	}
	if !s.validateMutationLabelIDs(c, email, defaultLabels) {
		return
	}
	messageBody := body
	if nested, ok := body["message"].(map[string]any); ok {
		messageBody = nested
	}
	input := messageInput{
		UserEmail:    email,
		Raw:          messageBody["raw"],
		ThreadID:     stringValue(firstNonNil(messageBody["threadId"], messageBody["thread_id"])),
		From:         stringValue(messageBody["from"]),
		To:           stringValue(messageBody["to"]),
		CC:           nullableString(stringValue(messageBody["cc"])),
		BCC:          nullableString(stringValue(messageBody["bcc"])),
		ReplyTo:      nullableString(stringValue(firstNonNil(messageBody["replyTo"], messageBody["reply_to"]))),
		Subject:      stringValue(messageBody["subject"]),
		Snippet:      stringValue(messageBody["snippet"]),
		BodyText:     nullableString(stringValue(firstNonNil(messageBody["body_text"], messageBody["text"]))),
		BodyHTML:     nullableString(stringValue(firstNonNil(messageBody["body_html"], messageBody["html"]))),
		Date:         stringValue(messageBody["date"]),
		InternalDate: stringValue(firstNonNil(messageBody["internalDate"], messageBody["internal_date"])),
		MessageID:    stringValue(firstNonNil(messageBody["messageId"], messageBody["message_id"])),
		References:   nullableString(stringValue(messageBody["references"])),
		InReplyTo:    nullableString(stringValue(firstNonNil(messageBody["inReplyTo"], messageBody["in_reply_to"]))),
		LabelIDs:     defaultLabels,
	}
	if mode == "send" && input.From == "" {
		input.From = email
	}
	if !validateRawMessagePayload(c, input.Raw) {
		return
	}
	if stringValue(input.Raw) == "" && (input.From == "" || input.To == "") {
		googleAPIError(c, http.StatusBadRequest, "A raw MIME message or explicit from/to fields are required.", "invalidArgument", "INVALID_ARGUMENT")
		return
	}
	message := s.createStoredMessage(input)
	c.JSON(http.StatusOK, formatMessageResource(s, message, "full", nil))
}

func (s *Service) handleModifyMessage(c *corehttp.Context) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	message := s.getMessageByID(email, c.Param("id"))
	if message == nil {
		googleAPIError(c, http.StatusNotFound, "Requested entity was not found.", "notFound", "NOT_FOUND")
		return
	}
	body := parseJSONBody(c.Request)
	addLabelIDs := getStringArray(body, "addLabelIds")
	removeLabelIDs := getStringArray(body, "removeLabelIds")
	if !s.validateMutationLabelIDs(c, email, append(addLabelIDs, removeLabelIDs...)) {
		return
	}
	updated := s.updateMessageLabels(message, applyLabelMutation(stringSliceValue(message["label_ids"]), addLabelIDs, removeLabelIDs))
	c.JSON(http.StatusOK, formatMessageResource(s, updated, "full", nil))
}

func (s *Service) handleBatchModifyMessages(c *corehttp.Context) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	body := parseJSONBody(c.Request)
	addLabelIDs := getStringArray(body, "addLabelIds")
	removeLabelIDs := getStringArray(body, "removeLabelIds")
	if !s.validateMutationLabelIDs(c, email, append(addLabelIDs, removeLabelIDs...)) {
		return
	}
	for _, id := range getStringArray(body, "ids") {
		message := s.getMessageByID(email, id)
		if message == nil {
			continue
		}
		s.updateMessageLabels(message, applyLabelMutation(stringSliceValue(message["label_ids"]), addLabelIDs, removeLabelIDs))
	}
	c.Writer.WriteHeader(http.StatusNoContent)
}

func (s *Service) handleBatchDeleteMessages(c *corehttp.Context) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	body := parseJSONBody(c.Request)
	for _, id := range getStringArray(body, "ids") {
		if message := s.getMessageByID(email, id); message != nil {
			s.deleteMessage(message)
		}
	}
	c.Writer.WriteHeader(http.StatusNoContent)
}

func (s *Service) handleTrashMessage(c *corehttp.Context) {
	s.mutateMessageLabels(c, func(labels []string) []string {
		return applyLabelMutation(labels, []string{"TRASH"}, []string{"INBOX"})
	})
}

func (s *Service) handleUntrashMessage(c *corehttp.Context) {
	s.mutateMessageLabels(c, func(labels []string) []string {
		return applyLabelMutation(labels, []string{"INBOX"}, []string{"TRASH"})
	})
}

func (s *Service) mutateMessageLabels(c *corehttp.Context, mutate func([]string) []string) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	message := s.getMessageByID(email, c.Param("id"))
	if message == nil {
		googleAPIError(c, http.StatusNotFound, "Requested entity was not found.", "notFound", "NOT_FOUND")
		return
	}
	updated := s.updateMessageLabels(message, mutate(stringSliceValue(message["label_ids"])))
	c.JSON(http.StatusOK, formatMessageResource(s, updated, "full", nil))
}

func (s *Service) handleDeleteMessage(c *corehttp.Context) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	if message := s.getMessageByID(email, c.Param("id")); message != nil {
		s.deleteMessage(message)
	}
	c.Writer.WriteHeader(http.StatusNoContent)
}

func (s *Service) handleListDrafts(c *corehttp.Context) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	rows := s.store.Drafts.FindBy("user_email", email)
	sort.SliceStable(rows, func(i int, j int) bool {
		return stringField(rows[i], "created_at") < stringField(rows[j], "created_at")
	})
	offset := parseOffset(c.Query("pageToken"))
	limit := normalizeLimit(c.Query("maxResults"), 100, 500)
	page := pageRecords(rows, offset, limit)
	drafts := make([]map[string]any, 0, len(page))
	for _, draft := range page {
		if message := s.getMessageByID(email, stringField(draft, "message_gmail_id")); message != nil {
			drafts = append(drafts, s.formatDraft(draft, message, c.Query("format")))
		}
	}
	body := map[string]any{"drafts": drafts, "resultSizeEstimate": len(rows)}
	if offset+limit < len(rows) {
		body["nextPageToken"] = strconv.Itoa(offset + limit)
	}
	c.JSON(http.StatusOK, body)
}

func (s *Service) handleCreateDraft(c *corehttp.Context) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	body := parseJSONBody(c.Request)
	messageBody := body
	if nested, ok := body["message"].(map[string]any); ok {
		messageBody = nested
	}
	input := s.messageInputFromBody(email, messageBody)
	input.LabelIDs = dedupeStrings(append(input.LabelIDs, "DRAFT"))
	if !s.validateMutationLabelIDs(c, email, input.LabelIDs) {
		return
	}
	if !validateRawMessagePayload(c, input.Raw) {
		return
	}
	if stringValue(input.Raw) == "" && (input.From == "" || input.To == "") {
		googleAPIError(c, http.StatusBadRequest, "A raw MIME message or explicit from/to fields are required.", "invalidArgument", "INVALID_ARGUMENT")
		return
	}
	message := s.createStoredMessage(input)
	draft := s.store.Drafts.Insert(corestore.Record{
		"gmail_id":         generateDraftID(),
		"user_email":       email,
		"message_gmail_id": stringField(message, "gmail_id"),
	})
	c.JSON(http.StatusOK, s.formatDraft(draft, message, "full"))
}

func (s *Service) handleGetDraft(c *corehttp.Context) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	draft, message := s.getDraftAndMessage(email, c.Param("id"))
	if draft == nil || message == nil {
		googleAPIError(c, http.StatusNotFound, "Requested entity was not found.", "notFound", "NOT_FOUND")
		return
	}
	c.JSON(http.StatusOK, s.formatDraft(draft, message, c.Query("format")))
}

func (s *Service) handleUpdateDraft(c *corehttp.Context) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	draft, message := s.getDraftAndMessage(email, c.Param("id"))
	if draft == nil || message == nil {
		googleAPIError(c, http.StatusNotFound, "Requested entity was not found.", "notFound", "NOT_FOUND")
		return
	}
	body := parseJSONBody(c.Request)
	messageBody := body
	if nested, ok := body["message"].(map[string]any); ok {
		messageBody = nested
	}
	input := s.messageInputFromBody(email, messageBody)
	if !validateRawMessagePayload(c, input.Raw) {
		return
	}
	patch := messagePatchFromInput(input)
	patch["label_ids"] = applyLabelMutation(stringSliceValue(message["label_ids"]), []string{"DRAFT"}, nil)
	patch["history_id"] = generateHistoryID()
	updated, _ := s.store.Messages.Update(intField(message, "id"), patch)
	if input.Raw != nil {
		s.replaceMessageAttachments(updated, parseRawMessage(stringValue(input.Raw)).Attachments)
	}
	c.JSON(http.StatusOK, s.formatDraft(draft, updated, "full"))
}

func (s *Service) handleSendDraftFromBody(c *corehttp.Context) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	body := parseJSONBody(c.Request)
	s.sendDraft(c, email, stringValue(body["id"]))
}

func (s *Service) handleSendDraftByID(c *corehttp.Context) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	s.sendDraft(c, email, c.Param("id"))
}

func (s *Service) sendDraft(c *corehttp.Context, email string, draftID string) {
	draft, message := s.getDraftAndMessage(email, draftID)
	if draft == nil || message == nil {
		googleAPIError(c, http.StatusNotFound, "Requested entity was not found.", "notFound", "NOT_FOUND")
		return
	}
	s.store.Drafts.Delete(intField(draft, "id"))
	updated := s.updateMessageLabels(message, applyLabelMutation(stringSliceValue(message["label_ids"]), []string{"SENT"}, []string{"DRAFT"}))
	c.JSON(http.StatusOK, formatMessageResource(s, updated, "full", nil))
}

func (s *Service) handleDeleteDraft(c *corehttp.Context) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	draft, message := s.getDraftAndMessage(email, c.Param("id"))
	if draft != nil {
		s.store.Drafts.Delete(intField(draft, "id"))
	}
	if message != nil {
		s.deleteMessage(message)
	}
	c.Writer.WriteHeader(http.StatusNoContent)
}

func (s *Service) getDraftAndMessage(email string, draftID string) (corestore.Record, corestore.Record) {
	for _, draft := range s.store.Drafts.FindBy("user_email", email) {
		if stringField(draft, "gmail_id") == draftID {
			return draft, s.getMessageByID(email, stringField(draft, "message_gmail_id"))
		}
	}
	return nil, nil
}

func (s *Service) formatDraft(draft corestore.Record, message corestore.Record, format string) map[string]any {
	return map[string]any{
		"id":      stringField(draft, "gmail_id"),
		"message": formatMessageResource(s, message, format, nil),
	}
}

func (s *Service) messageInputFromBody(email string, body map[string]any) messageInput {
	return messageInput{
		UserEmail:    email,
		Raw:          body["raw"],
		ThreadID:     stringValue(firstNonNil(body["threadId"], body["thread_id"])),
		From:         firstNonEmpty(stringValue(body["from"]), email),
		To:           stringValue(body["to"]),
		CC:           nullableString(stringValue(body["cc"])),
		BCC:          nullableString(stringValue(body["bcc"])),
		ReplyTo:      nullableString(stringValue(firstNonNil(body["replyTo"], body["reply_to"]))),
		Subject:      stringValue(body["subject"]),
		Snippet:      stringValue(body["snippet"]),
		BodyText:     nullableString(stringValue(firstNonNil(body["body_text"], body["text"]))),
		BodyHTML:     nullableString(stringValue(firstNonNil(body["body_html"], body["html"]))),
		Date:         stringValue(body["date"]),
		InternalDate: stringValue(firstNonNil(body["internalDate"], body["internal_date"])),
		MessageID:    stringValue(firstNonNil(body["messageId"], body["message_id"])),
		References:   nullableString(stringValue(body["references"])),
		InReplyTo:    nullableString(stringValue(firstNonNil(body["inReplyTo"], body["in_reply_to"]))),
		LabelIDs:     getStringArray(body, "labelIds"),
	}
}

func validateRawMessagePayload(c *corehttp.Context, raw any) bool {
	value := stringValue(raw)
	if value == "" {
		return true
	}
	if parseRawMessage(value).Valid {
		return true
	}
	googleAPIError(c, http.StatusBadRequest, "Invalid raw MIME message payload.", "invalidArgument", "INVALID_ARGUMENT")
	return false
}

func messagePatchFromInput(input messageInput) corestore.Record {
	patch := corestore.Record{}
	if input.Raw != nil {
		raw := stringValue(input.Raw)
		patch["raw"] = nullableString(raw)
		parsed := parseRawMessage(raw)
		patch["from"] = firstNonEmpty(input.From, parsed.From)
		patch["to"] = firstNonEmpty(input.To, parsed.To)
		patch["cc"] = firstNonNil(input.CC, nullableString(parsed.CC))
		patch["bcc"] = firstNonNil(input.BCC, nullableString(parsed.BCC))
		patch["reply_to"] = firstNonNil(input.ReplyTo, nullableString(parsed.ReplyTo))
		patch["subject"] = firstNonEmpty(input.Subject, parsed.Subject)
		patch["body_text"] = nullableString(firstNonEmpty(stringValue(input.BodyText), parsed.BodyText))
		patch["body_html"] = nullableString(firstNonEmpty(stringValue(input.BodyHTML), parsed.BodyHTML))
		if value := firstNonEmpty(input.MessageID, parsed.MessageID); value != "" {
			patch["message_id"] = value
		}
		patch["references"] = firstNonNil(input.References, nullableString(parsed.References))
		patch["in_reply_to"] = firstNonNil(input.InReplyTo, nullableString(parsed.InReplyTo))
		if value := firstNonEmpty(input.Date, parsed.DateHeader); value != "" {
			patch["date_header"] = value
		}
	} else {
		if input.From != "" {
			patch["from"] = input.From
		}
		if input.To != "" {
			patch["to"] = input.To
		}
		if input.Subject != "" {
			patch["subject"] = input.Subject
		}
		if stringValue(input.BodyText) != "" {
			patch["body_text"] = input.BodyText
		}
		if stringValue(input.BodyHTML) != "" {
			patch["body_html"] = input.BodyHTML
		}
	}
	if input.ThreadID != "" {
		patch["thread_id"] = input.ThreadID
	}
	if input.Snippet != "" {
		patch["snippet"] = input.Snippet
	}
	if len(input.LabelIDs) > 0 {
		patch["label_ids"] = input.LabelIDs
	}
	return patch
}

func (s *Service) handleListThreads(c *corehttp.Context) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	messages := s.listMessages(email, c.Request.URL.Query())
	seen := map[string]corestore.Record{}
	order := []string{}
	for _, message := range messages {
		threadID := stringField(message, "thread_id")
		if _, ok := seen[threadID]; ok {
			continue
		}
		seen[threadID] = message
		order = append(order, threadID)
	}
	offset := parseOffset(c.Query("pageToken"))
	limit := normalizeLimit(c.Query("maxResults"), 100, 500)
	pageIDs := order
	if offset < len(order) {
		end := offset + limit
		if end > len(order) {
			end = len(order)
		}
		pageIDs = order[offset:end]
	} else {
		pageIDs = nil
	}
	threads := make([]map[string]any, 0, len(pageIDs))
	for _, threadID := range pageIDs {
		message := seen[threadID]
		threads = append(threads, map[string]any{"id": threadID, "snippet": stringField(message, "snippet"), "historyId": stringField(message, "history_id")})
	}
	body := map[string]any{"threads": threads, "resultSizeEstimate": len(order)}
	if offset+limit < len(order) {
		body["nextPageToken"] = strconv.Itoa(offset + limit)
	}
	c.JSON(http.StatusOK, body)
}

func (s *Service) handleGetThread(c *corehttp.Context) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	messages := s.threadMessages(email, c.Param("id"))
	if len(messages) == 0 {
		googleAPIError(c, http.StatusNotFound, "Requested entity was not found.", "notFound", "NOT_FOUND")
		return
	}
	formatted := make([]map[string]any, 0, len(messages))
	for _, message := range messages {
		formatted = append(formatted, formatMessageResource(s, message, "full", nil))
	}
	c.JSON(http.StatusOK, map[string]any{"id": c.Param("id"), "messages": formatted, "historyId": stringField(messages[len(messages)-1], "history_id")})
}

func (s *Service) handleModifyThread(c *corehttp.Context) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	body := parseJSONBody(c.Request)
	messages := s.threadMessages(email, c.Param("id"))
	if len(messages) == 0 {
		googleAPIError(c, http.StatusNotFound, "Requested entity was not found.", "notFound", "NOT_FOUND")
		return
	}
	addLabelIDs := getStringArray(body, "addLabelIds")
	removeLabelIDs := getStringArray(body, "removeLabelIds")
	if !s.validateMutationLabelIDs(c, email, append(addLabelIDs, removeLabelIDs...)) {
		return
	}
	formatted := make([]map[string]any, 0, len(messages))
	for _, message := range messages {
		updated := s.updateMessageLabels(message, applyLabelMutation(stringSliceValue(message["label_ids"]), addLabelIDs, removeLabelIDs))
		formatted = append(formatted, formatMessageResource(s, updated, "full", nil))
	}
	c.JSON(http.StatusOK, map[string]any{"id": c.Param("id"), "messages": formatted})
}

func (s *Service) handleTrashThread(c *corehttp.Context) {
	s.mutateThreadLabels(c, func(labels []string) []string {
		return applyLabelMutation(labels, []string{"TRASH"}, []string{"INBOX"})
	})
}

func (s *Service) handleUntrashThread(c *corehttp.Context) {
	s.mutateThreadLabels(c, func(labels []string) []string {
		return applyLabelMutation(labels, []string{"INBOX"}, []string{"TRASH"})
	})
}

func (s *Service) mutateThreadLabels(c *corehttp.Context, mutate func([]string) []string) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	messages := s.threadMessages(email, c.Param("id"))
	if len(messages) == 0 {
		googleAPIError(c, http.StatusNotFound, "Requested entity was not found.", "notFound", "NOT_FOUND")
		return
	}
	for _, message := range messages {
		s.updateMessageLabels(message, mutate(stringSliceValue(message["label_ids"])))
	}
	c.JSON(http.StatusOK, map[string]any{"id": c.Param("id")})
}

func (s *Service) handleDeleteThread(c *corehttp.Context) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	for _, message := range s.threadMessages(email, c.Param("id")) {
		s.deleteMessage(message)
	}
	c.Writer.WriteHeader(http.StatusNoContent)
}

func (s *Service) threadMessages(email string, threadID string) []corestore.Record {
	messages := []corestore.Record{}
	for _, message := range s.store.Messages.FindBy("thread_id", threadID) {
		if stringField(message, "user_email") == email {
			messages = append(messages, message)
		}
	}
	sort.SliceStable(messages, func(i int, j int) bool {
		return messageSortTime(messages[i]) < messageSortTime(messages[j])
	})
	return messages
}

func (s *Service) handleListLabels(c *corehttp.Context) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	ensureSystemLabels(s.store, email)
	labels := s.store.Labels.FindBy("user_email", email)
	out := make([]map[string]any, 0, len(labels))
	for _, label := range labels {
		out = append(out, s.formatLabel(email, label))
	}
	c.JSON(http.StatusOK, map[string]any{"labels": out})
}

func (s *Service) handleCreateLabel(c *corehttp.Context) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	body := parseJSONBody(c.Request)
	name := stringValue(body["name"])
	if name == "" {
		googleAPIError(c, http.StatusBadRequest, "Label name is required.", "invalidArgument", "INVALID_ARGUMENT")
		return
	}
	color := mapValue(body["color"])
	label := s.createLabelRecord(labelInput{
		UserEmail:             email,
		Name:                  name,
		Type:                  "user",
		MessageListVisibility: firstNonEmpty(stringValue(body["messageListVisibility"]), "show"),
		LabelListVisibility:   firstNonEmpty(stringValue(body["labelListVisibility"]), "labelShow"),
		ColorBackground:       nullableString(stringValue(color["backgroundColor"])),
		ColorText:             nullableString(stringValue(color["textColor"])),
	})
	c.JSON(http.StatusOK, s.formatLabel(email, label))
}

func (s *Service) handleGetLabel(c *corehttp.Context) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	label := s.findLabelByID(email, c.Param("id"))
	if label == nil {
		googleAPIError(c, http.StatusNotFound, "Requested entity was not found.", "notFound", "NOT_FOUND")
		return
	}
	c.JSON(http.StatusOK, s.formatLabel(email, label))
}

func (s *Service) handlePatchLabel(c *corehttp.Context) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	label := s.findLabelByID(email, c.Param("id"))
	if label == nil {
		googleAPIError(c, http.StatusNotFound, "Requested entity was not found.", "notFound", "NOT_FOUND")
		return
	}
	if stringField(label, "type") == "system" {
		googleAPIError(c, http.StatusBadRequest, "System labels cannot be modified.", "invalidArgument", "INVALID_ARGUMENT")
		return
	}
	body := parseJSONBody(c.Request)
	color := mapValue(body["color"])
	patch := corestore.Record{}
	if name := stringValue(body["name"]); name != "" {
		patch["name"] = name
	}
	if value := stringValue(body["messageListVisibility"]); value != "" {
		patch["message_list_visibility"] = value
	}
	if value := stringValue(body["labelListVisibility"]); value != "" {
		patch["label_list_visibility"] = value
	}
	if value := stringValue(color["backgroundColor"]); value != "" {
		patch["color_background"] = value
	}
	if value := stringValue(color["textColor"]); value != "" {
		patch["color_text"] = value
	}
	updated, _ := s.store.Labels.Update(intField(label, "id"), patch)
	c.JSON(http.StatusOK, s.formatLabel(email, updated))
}

func (s *Service) handleDeleteLabel(c *corehttp.Context) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	label := s.findLabelByID(email, c.Param("id"))
	if label == nil {
		googleAPIError(c, http.StatusNotFound, "Requested entity was not found.", "notFound", "NOT_FOUND")
		return
	}
	if stringField(label, "type") == "system" {
		googleAPIError(c, http.StatusBadRequest, "System labels cannot be deleted.", "invalidArgument", "INVALID_ARGUMENT")
		return
	}
	s.store.Labels.Delete(intField(label, "id"))
	for _, message := range s.store.Messages.FindBy("user_email", email) {
		s.updateMessageLabels(message, applyLabelMutation(stringSliceValue(message["label_ids"]), nil, []string{c.Param("id")}))
	}
	c.Writer.WriteHeader(http.StatusNoContent)
}

func (s *Service) formatLabel(email string, label corestore.Record) map[string]any {
	total := 0
	unread := 0
	threadIDs := map[string]struct{}{}
	unreadThreadIDs := map[string]struct{}{}
	for _, message := range s.store.Messages.FindBy("user_email", email) {
		labels := stringSliceValue(message["label_ids"])
		if containsString(labels, stringField(label, "gmail_id")) {
			total++
			threadIDs[stringField(message, "thread_id")] = struct{}{}
			if containsString(labels, "UNREAD") {
				unread++
				unreadThreadIDs[stringField(message, "thread_id")] = struct{}{}
			}
		}
	}
	body := map[string]any{
		"id":                    stringField(label, "gmail_id"),
		"name":                  stringField(label, "name"),
		"type":                  stringField(label, "type"),
		"messageListVisibility": stringField(label, "message_list_visibility"),
		"labelListVisibility":   stringField(label, "label_list_visibility"),
		"messagesTotal":         total,
		"messagesUnread":        unread,
		"threadsTotal":          len(threadIDs),
		"threadsUnread":         len(unreadThreadIDs),
	}
	if stringField(label, "color_background") != "" || stringField(label, "color_text") != "" {
		body["color"] = map[string]any{"backgroundColor": label["color_background"], "textColor": label["color_text"]}
	}
	return body
}

func (s *Service) handleListSendAs(c *corehttp.Context) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	ensureDefaultSendAs(s.store, email)
	rows := s.store.SendAs.FindBy("user_email", email)
	sendAs := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		sendAs = append(sendAs, map[string]any{
			"sendAsEmail": stringField(row, "send_as_email"),
			"displayName": stringField(row, "display_name"),
			"isDefault":   boolField(row, "is_default"),
			"signature":   stringField(row, "signature"),
		})
	}
	c.JSON(http.StatusOK, map[string]any{"sendAs": sendAs})
}

func (s *Service) handleListForwardingAddresses(c *corehttp.Context) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	rows := s.store.Forwarding.FindBy("user_email", email)
	items := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		items = append(items, map[string]any{"forwardingEmail": stringField(row, "forwarding_email"), "verificationStatus": stringField(row, "verification_status")})
	}
	c.JSON(http.StatusOK, map[string]any{"forwardingAddresses": items})
}

func (s *Service) handleListFilters(c *corehttp.Context) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	rows := s.store.Filters.FindBy("user_email", email)
	items := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		items = append(items, formatFilter(row))
	}
	c.JSON(http.StatusOK, map[string]any{"filter": items})
}

func (s *Service) handleCreateFilter(c *corehttp.Context) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	body := parseJSONBody(c.Request)
	criteria := mapValue(body["criteria"])
	action := mapValue(body["action"])
	from := stringValue(criteria["from"])
	add := getStringArray(action, "addLabelIds")
	remove := getStringArray(action, "removeLabelIds")
	if len(add) == 0 && len(remove) == 0 {
		googleAPIError(c, http.StatusBadRequest, "Filter actions are required.", "invalidArgument", "INVALID_ARGUMENT")
		return
	}
	if !s.validateMutationLabelIDs(c, email, append(add, remove...)) {
		return
	}
	for _, filter := range s.store.Filters.FindBy("user_email", email) {
		if stringField(filter, "criteria_from") == from && sameStringSet(stringSliceValue(filter["add_label_ids"]), add) && sameStringSet(stringSliceValue(filter["remove_label_ids"]), remove) {
			googleAPIError(c, http.StatusBadRequest, "Filter already exists", "invalidArgument", "INVALID_ARGUMENT")
			return
		}
	}
	filter := s.store.Filters.Insert(corestore.Record{
		"gmail_id":         "filter_" + generateHex(8),
		"user_email":       email,
		"criteria_from":    nullableString(from),
		"add_label_ids":    add,
		"remove_label_ids": remove,
	})
	c.JSON(http.StatusOK, formatFilter(filter))
}

func (s *Service) handleDeleteFilter(c *corehttp.Context) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	for _, filter := range s.store.Filters.FindBy("user_email", email) {
		if stringField(filter, "gmail_id") == c.Param("id") {
			s.store.Filters.Delete(intField(filter, "id"))
			break
		}
	}
	c.Writer.WriteHeader(http.StatusNoContent)
}

func (s *Service) handleWatch(c *corehttp.Context) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	body := parseJSONBody(c.Request)
	topicName := strings.TrimSpace(stringValue(body["topicName"]))
	if topicName == "" {
		googleAPIError(c, http.StatusBadRequest, "Topic name is required.", "invalidArgument", "INVALID_ARGUMENT")
		return
	}
	labelIDs := getStringArray(body, "labelIds")
	if !s.validateMutationLabelIDs(c, email, labelIDs) {
		return
	}
	historyID := generateHistoryID()
	for _, row := range s.store.WatchRegistries.FindBy("user_email", email) {
		s.store.WatchRegistries.Delete(intField(row, "id"))
	}
	s.store.WatchRegistries.Insert(corestore.Record{
		"user_email":            email,
		"history_id":            historyID,
		"topic_name":            topicName,
		"label_ids":             labelIDs,
		"label_filter_behavior": nullableString(firstNonEmpty(stringValue(body["labelFilterBehavior"]), stringValue(body["labelFilterAction"]))),
	})
	c.JSON(http.StatusOK, map[string]any{"historyId": historyID, "expiration": strconv.FormatInt(time.Now().UnixMilli()+604800000, 10)})
}

func (s *Service) handleStop(c *corehttp.Context) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	for _, row := range s.store.WatchRegistries.FindBy("user_email", email) {
		s.store.WatchRegistries.Delete(intField(row, "id"))
	}
	c.Writer.WriteHeader(http.StatusOK)
}

func (s *Service) handleListHistory(c *corehttp.Context) {
	email, ok := s.authenticatedGmailUser(c)
	if !ok {
		return
	}
	start := c.Query("startHistoryId")
	types := map[string]struct{}{}
	for _, value := range c.Request.URL.Query()["historyTypes"] {
		types[value] = struct{}{}
	}
	rows := s.store.History.FindBy("user_email", email)
	items := []map[string]any{}
	var latest string
	for _, row := range rows {
		if start != "" && !historyIDAfter(stringField(row, "gmail_id"), start) {
			continue
		}
		changeType := stringField(row, "change_type")
		if len(types) > 0 {
			if _, ok := types[changeType]; !ok {
				continue
			}
		}
		message := s.getMessageByID(email, stringField(row, "message_gmail_id"))
		entry := map[string]any{"id": stringField(row, "gmail_id")}
		ref := map[string]any{"message": map[string]any{"id": stringField(row, "message_gmail_id"), "threadId": stringField(row, "thread_id")}}
		if message != nil {
			ref["message"] = formatMessageResource(s, message, "minimal", nil)
		}
		switch changeType {
		case "messageAdded":
			entry["messagesAdded"] = []map[string]any{ref}
		case "messageDeleted":
			entry["messagesDeleted"] = []map[string]any{ref}
		case "labelAdded":
			ref["labelIds"] = stringSliceValue(row["label_ids"])
			entry["labelsAdded"] = []map[string]any{ref}
		case "labelRemoved":
			ref["labelIds"] = stringSliceValue(row["label_ids"])
			entry["labelsRemoved"] = []map[string]any{ref}
		}
		latest = stringField(row, "gmail_id")
		items = append(items, entry)
	}
	if latest == "" {
		latest = generateHistoryID()
	}
	c.JSON(http.StatusOK, map[string]any{"historyId": latest, "history": items})
}

func pageRecords(records []corestore.Record, offset int, limit int) []corestore.Record {
	if offset >= len(records) {
		return nil
	}
	end := offset + limit
	if end > len(records) {
		end = len(records)
	}
	return records[offset:end]
}

func getStringArray(body map[string]any, field string) []string {
	value := body[field]
	switch v := value.(type) {
	case []string:
		return append([]string(nil), v...)
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			if s, ok := item.(string); ok && s != "" {
				out = append(out, s)
			}
		}
		return out
	case string:
		if v == "" {
			return nil
		}
		return []string{v}
	default:
		return nil
	}
}

func (s *Service) validateMutationLabelIDs(c *corehttp.Context, userEmail string, labelIDs []string) bool {
	missing := s.missingLabelIDs(userEmail, labelIDs)
	if len(missing) == 0 {
		return true
	}
	googleAPIError(c, http.StatusBadRequest, "Invalid label IDs: "+strings.Join(missing, ", "), "invalidArgument", "INVALID_ARGUMENT")
	return false
}

func (s *Service) missingLabelIDs(userEmail string, labelIDs []string) []string {
	ensureSystemLabels(s.store, userEmail)
	seen := map[string]struct{}{}
	missing := []string{}
	for _, labelID := range labelIDs {
		if labelID == "" {
			continue
		}
		if _, ok := seen[labelID]; ok {
			continue
		}
		seen[labelID] = struct{}{}
		if s.findLabelByID(userEmail, labelID) == nil {
			missing = append(missing, labelID)
		}
	}
	sort.Strings(missing)
	return missing
}

func mapValue(value any) map[string]any {
	if record, ok := value.(map[string]any); ok {
		return record
	}
	return map[string]any{}
}

func formatFilter(row corestore.Record) map[string]any {
	return map[string]any{
		"id":       stringField(row, "gmail_id"),
		"criteria": map[string]any{"from": row["criteria_from"]},
		"action":   map[string]any{"addLabelIds": stringSliceValue(row["add_label_ids"]), "removeLabelIds": stringSliceValue(row["remove_label_ids"])},
	}
}

func sameStringSet(a []string, b []string) bool {
	a = dedupeStrings(a)
	b = dedupeStrings(b)
	if len(a) != len(b) {
		return false
	}
	sort.Strings(a)
	sort.Strings(b)
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
