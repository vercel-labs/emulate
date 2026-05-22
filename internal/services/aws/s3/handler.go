package s3

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	coreassets "github.com/vercel-labs/emulate/internal/core/assets"
	corestore "github.com/vercel-labs/emulate/internal/core/store"
	awsassets "github.com/vercel-labs/emulate/internal/services/aws/assets"
	"github.com/vercel-labs/emulate/internal/services/aws/gateway"
	"github.com/vercel-labs/emulate/internal/services/aws/protocols"
)

type Handler struct {
	Buckets *corestore.Collection
	Objects *corestore.Collection
	Assets  *coreassets.Store
	BaseURL string
	Region  string
	Now     func() time.Time
}

type objectOptions struct {
	Metadata             map[string]string
	ServerSideEncryption string
	SSEKMSKeyID          string
}

func (h *Handler) Handle(req *http.Request, ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	if ctx.S3 == nil {
		return withRequestID(h.notImplemented(ctx), ctx.RequestID)
	}
	var response protocols.ErrorResponse
	switch ctx.Action {
	case "ListBuckets":
		response = h.listBuckets()
	case "CreateBucket":
		response = h.createBucket(ctx.S3.Bucket, ctx.RawBody)
	case "DeleteBucket":
		response = h.deleteBucket(ctx.S3.Bucket)
	case "HeadBucket":
		response = h.headBucket(ctx.S3.Bucket)
	case "GetBucketLocation":
		response = h.getBucketLocation(ctx.S3.Bucket)
	case "ListObjects", "ListObjectsV2":
		response = h.listObjects(ctx.S3.Bucket, ctx.S3.Query)
	case "PostObject":
		response = h.postObject(req, ctx)
	case "PutObject":
		response = h.putObject(req, ctx)
	case "CopyObject":
		response = h.copyObject(ctx)
	case "GetObject":
		response = h.getObject(req, ctx.S3.Bucket, ctx.S3.Key, false)
	case "HeadObject":
		response = h.getObject(req, ctx.S3.Bucket, ctx.S3.Key, true)
	case "DeleteObject":
		response = h.deleteObject(ctx.S3.Bucket, ctx.S3.Key)
	default:
		response = h.notImplemented(ctx)
	}
	return withRequestID(response, ctx.RequestID)
}

func (h *Handler) listBuckets() protocols.ErrorResponse {
	buckets := h.Buckets.All()
	var rows strings.Builder
	for _, bucket := range buckets {
		rows.WriteString(`    <Bucket>
      <Name>`)
		rows.WriteString(xmlEscape(stringField(bucket, "bucket_name")))
		rows.WriteString(`</Name>
      <CreationDate>`)
		rows.WriteString(xmlEscape(stringField(bucket, "creation_date")))
		rows.WriteString(`</CreationDate>
    </Bucket>
`)
	}
	body := `<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult>
  <Owner>
    <ID>owner-id</ID>
    <DisplayName>emulate</DisplayName>
  </Owner>
  <Buckets>
` + strings.TrimRight(rows.String(), "\n") + `
  </Buckets>
</ListAllMyBucketsResult>`
	return xmlResponse(http.StatusOK, body, nil)
}

func (h *Handler) createBucket(bucketName string, body []byte) protocols.ErrorResponse {
	if bucketName == "" {
		return h.xmlError("InvalidBucketName", "The specified bucket is not valid.", http.StatusBadRequest, "")
	}
	if _, ok := h.findBucket(bucketName); ok {
		return h.xmlError("BucketAlreadyOwnedByYou", "Your previous request to create the named bucket succeeded and you already own it.", http.StatusConflict, "/"+bucketName)
	}
	region := h.Region
	if configured, err := createBucketRegion(body); err != nil {
		return h.xmlError("MalformedXML", "The XML you provided was not well-formed or did not validate against our published schema.", http.StatusBadRequest, "/"+bucketName)
	} else if configured != "" {
		region = configured
	}
	if region == "" {
		region = gateway.DefaultRegion
	}
	h.Buckets.Insert(corestore.Record{
		"bucket_name":        bucketName,
		"region":             region,
		"creation_date":      h.now().Format(time.RFC3339Nano),
		"acl":                "private",
		"versioning_enabled": false,
	})
	return response(http.StatusOK, "", nil, map[string]string{"Location": "/" + bucketName})
}

func (h *Handler) deleteBucket(bucketName string) protocols.ErrorResponse {
	bucket, ok := h.findBucket(bucketName)
	if !ok {
		return h.xmlError("NoSuchBucket", "The specified bucket does not exist.", http.StatusNotFound, "/"+bucketName)
	}
	if len(h.Objects.FindBy("bucket_name", bucketName)) > 0 {
		return h.xmlError("BucketNotEmpty", "The bucket you tried to delete is not empty.", http.StatusConflict, "/"+bucketName)
	}
	h.Buckets.Delete(intField(bucket, "id"))
	return response(http.StatusNoContent, "", nil, nil)
}

func (h *Handler) headBucket(bucketName string) protocols.ErrorResponse {
	bucket, ok := h.findBucket(bucketName)
	if !ok {
		return response(http.StatusNotFound, "", nil, nil)
	}
	return response(http.StatusOK, "", nil, map[string]string{"x-amz-bucket-region": stringField(bucket, "region")})
}

func (h *Handler) getBucketLocation(bucketName string) protocols.ErrorResponse {
	bucket, ok := h.findBucket(bucketName)
	if !ok {
		return h.xmlError("NoSuchBucket", "The specified bucket does not exist.", http.StatusNotFound, "/"+bucketName)
	}
	region := stringField(bucket, "region")
	if region == "" || region == gateway.DefaultRegion {
		region = ""
	}
	body := `<?xml version="1.0" encoding="UTF-8"?>
<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` + xmlEscape(region) + `</LocationConstraint>`
	return xmlResponse(http.StatusOK, body, nil)
}

func (h *Handler) listObjects(bucketName string, query map[string]string) protocols.ErrorResponse {
	if _, ok := h.findBucket(bucketName); !ok {
		return h.xmlError("NoSuchBucket", "The specified bucket does not exist.", http.StatusNotFound, "/"+bucketName)
	}
	prefix := query["prefix"]
	delimiter := query["delimiter"]
	maxKeys := parseMaxKeys(query["max-keys"])
	continuationToken := query["continuation-token"]
	startAfter := query["start-after"]

	objects := h.Objects.FindBy("bucket_name", bucketName)
	filtered := make([]corestore.Record, 0, len(objects))
	for _, object := range objects {
		if strings.HasPrefix(stringField(object, "key"), prefix) {
			filtered = append(filtered, object)
		}
	}
	sort.Slice(filtered, func(i int, j int) bool {
		return stringField(filtered[i], "key") < stringField(filtered[j], "key")
	})

	marker := continuationToken
	if marker == "" {
		marker = startAfter
	}

	entries := make([]listEntry, 0, len(filtered))
	if delimiter != "" {
		prefixSet := map[string]struct{}{}
		for _, object := range filtered {
			key := stringField(object, "key")
			remaining := strings.TrimPrefix(key, prefix)
			if index := strings.Index(remaining, delimiter); index >= 0 {
				prefixSet[prefix+remaining[:index+len(delimiter)]] = struct{}{}
				continue
			}
			entries = append(entries, listEntry{kind: listEntryObject, key: key, object: object})
		}
		for prefixValue := range prefixSet {
			entries = append(entries, listEntry{kind: listEntryPrefix, key: prefixValue})
		}
	} else {
		for _, object := range filtered {
			entries = append(entries, listEntry{kind: listEntryObject, key: stringField(object, "key"), object: object})
		}
	}
	sort.Slice(entries, func(i int, j int) bool {
		return entries[i].key < entries[j].key
	})

	if marker != "" {
		start := len(entries)
		for index, entry := range entries {
			if entry.key > marker {
				start = index
				break
			}
		}
		entries = entries[start:]
	}

	truncated := len(entries) > maxKeys
	page := entries
	if len(page) > maxKeys {
		page = page[:maxKeys]
	}
	nextToken := ""
	if truncated && len(page) > 0 {
		nextToken = page[len(page)-1].key
	}

	var contentsXML strings.Builder
	var prefixesXML strings.Builder
	for _, entry := range page {
		if entry.kind == listEntryPrefix {
			prefixesXML.WriteString(`  <CommonPrefixes><Prefix>`)
			prefixesXML.WriteString(xmlEscape(entry.key))
			prefixesXML.WriteString(`</Prefix></CommonPrefixes>
`)
			continue
		}
		object := entry.object
		contentsXML.WriteString(`  <Contents>
    <Key>`)
		contentsXML.WriteString(xmlEscape(stringField(object, "key")))
		contentsXML.WriteString(`</Key>
    <LastModified>`)
		contentsXML.WriteString(xmlEscape(stringField(object, "last_modified")))
		contentsXML.WriteString(`</LastModified>
    <ETag>"`)
		contentsXML.WriteString(xmlEscape(stringField(object, "etag")))
		contentsXML.WriteString(`"</ETag>
    <Size>`)
		contentsXML.WriteString(strconv.FormatInt(int64Field(object, "content_length"), 10))
		contentsXML.WriteString(`</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
`)
	}

	body := `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>` + xmlEscape(bucketName) + `</Name>
  <Prefix>` + xmlEscape(prefix) + `</Prefix>
  <MaxKeys>` + strconv.Itoa(maxKeys) + `</MaxKeys>
  <IsTruncated>` + strconv.FormatBool(truncated) + `</IsTruncated>
  <KeyCount>` + strconv.Itoa(len(page)) + `</KeyCount>` + optionalElement("ContinuationToken", continuationToken) + optionalElement("NextContinuationToken", nextToken) + optionalElement("StartAfter", startAfter) + `
` + strings.TrimRight(contentsXML.String(), "\n") + `
` + strings.TrimRight(prefixesXML.String(), "\n") + `
</ListBucketResult>`
	return xmlResponse(http.StatusOK, body, nil)
}

const (
	listEntryObject = "object"
	listEntryPrefix = "prefix"
)

type listEntry struct {
	kind   string
	key    string
	object corestore.Record
}

func (h *Handler) putObject(req *http.Request, ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	if _, ok := h.findBucket(ctx.S3.Bucket); !ok {
		return h.xmlError("NoSuchBucket", "The specified bucket does not exist.", http.StatusNotFound, requestResource(ctx.S3.Bucket, ctx.S3.Key))
	}
	options := requestObjectOptions(req)
	contentType := req.Header.Get("Content-Type")
	if contentType == "" {
		contentType = coreassets.DefaultContentType
	}
	stored, err := h.storeObject(ctx.S3.Bucket, ctx.S3.Key, ctx.RawBody, contentType, options)
	if err != nil {
		return h.xmlError("InternalFailure", err.Error(), http.StatusInternalServerError, requestResource(ctx.S3.Bucket, ctx.S3.Key))
	}
	return response(http.StatusOK, "", nil, objectResponseHeaders(stored, map[string]string{"ETag": quotedETag(stringField(stored, "etag"))}))
}

func (h *Handler) copyObject(ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	if _, ok := h.findBucket(ctx.S3.Bucket); !ok {
		return h.xmlError("NoSuchBucket", "The specified bucket does not exist.", http.StatusNotFound, requestResource(ctx.S3.Bucket, ctx.S3.Key))
	}
	sourceBucket, sourceKey, ok := parseCopySource(ctx.S3.CopySource)
	if !ok {
		return h.xmlError("InvalidArgument", "Invalid copy source.", http.StatusBadRequest, requestResource(ctx.S3.Bucket, ctx.S3.Key))
	}
	source, ok := h.findObject(sourceBucket, sourceKey)
	if !ok {
		return h.xmlError("NoSuchKey", "The specified source key does not exist.", http.StatusNotFound, requestResource(sourceBucket, sourceKey))
	}
	body, _, ok := h.assetBytes(source)
	if !ok {
		return h.xmlError("NoSuchKey", "The specified source key does not exist.", http.StatusNotFound, requestResource(sourceBucket, sourceKey))
	}
	stored, err := h.storeObject(ctx.S3.Bucket, ctx.S3.Key, body, stringField(source, "content_type"), recordObjectOptions(source))
	if err != nil {
		return h.xmlError("InternalFailure", err.Error(), http.StatusInternalServerError, requestResource(ctx.S3.Bucket, ctx.S3.Key))
	}
	lastModified := stringField(stored, "last_modified")
	bodyXML := `<?xml version="1.0" encoding="UTF-8"?>
<CopyObjectResult>
  <ETag>"` + xmlEscape(stringField(stored, "etag")) + `"</ETag>
  <LastModified>` + xmlEscape(lastModified) + `</LastModified>
</CopyObjectResult>`
	return xmlResponse(http.StatusOK, bodyXML, objectResponseHeaders(stored, map[string]string{"Last-Modified": httpTime(lastModified)}))
}

func (h *Handler) getObject(req *http.Request, bucketName string, key string, head bool) protocols.ErrorResponse {
	if _, ok := h.findBucket(bucketName); !ok {
		if head {
			return response(http.StatusNotFound, "", nil, nil)
		}
		return h.xmlError("NoSuchBucket", "The specified bucket does not exist.", http.StatusNotFound, requestResource(bucketName, key))
	}
	object, ok := h.findObject(bucketName, key)
	if !ok {
		if head {
			return response(http.StatusNotFound, "", nil, nil)
		}
		return h.xmlError("NoSuchKey", "The specified key does not exist.", http.StatusNotFound, requestResource(bucketName, key))
	}
	body, assetMetadata, ok := h.assetBytes(object)
	if !ok {
		if head {
			return response(http.StatusNotFound, "", nil, nil)
		}
		return h.xmlError("NoSuchKey", "The specified key does not exist.", http.StatusNotFound, requestResource(bucketName, key))
	}
	if condition := h.evaluateObjectConditions(req, object, assetMetadata, bucketName, key); condition != nil {
		return *condition
	}
	headers := map[string]string{
		"Content-Length": strconv.FormatInt(assetMetadata.ContentLength, 10),
		"ETag":           quotedETag(stringField(object, "etag")),
		"Last-Modified":  assetMetadata.LastModified.UTC().Format(http.TimeFormat),
	}
	contentType := stringField(object, "content_type")
	if contentType != "" {
		headers["Content-Type"] = contentType
	}
	for key, value := range stringMapField(object, "metadata") {
		headers["x-amz-meta-"+key] = value
	}
	objectResponseHeaders(object, headers)
	status := http.StatusOK
	if rangeHeader := strings.TrimSpace(req.Header.Get("Range")); rangeHeader != "" {
		rangeSpec, ok := parseByteRange(rangeHeader, int64(len(body)))
		if !ok {
			return h.xmlError("InvalidRange", "The requested range is not satisfiable.", http.StatusRequestedRangeNotSatisfiable, requestResource(bucketName, key))
		}
		body = body[rangeSpec.start : rangeSpec.end+1]
		status = http.StatusPartialContent
		headers["Content-Length"] = strconv.FormatInt(int64(len(body)), 10)
		headers["Content-Range"] = fmt.Sprintf("bytes %d-%d/%d", rangeSpec.start, rangeSpec.end, rangeSpec.total)
	}
	if head {
		return response(status, "", nil, headers)
	}
	return response(status, contentType, body, headers)
}

func (h *Handler) deleteObject(bucketName string, key string) protocols.ErrorResponse {
	if _, ok := h.findBucket(bucketName); !ok {
		return h.xmlError("NoSuchBucket", "The specified bucket does not exist.", http.StatusNotFound, requestResource(bucketName, key))
	}
	if object, ok := h.findObject(bucketName, key); ok {
		h.Objects.Delete(intField(object, "id"))
		if assetID := stringField(object, "asset_id"); assetID != "" {
			h.assets().Delete(assetID)
		}
	}
	return response(http.StatusNoContent, "", nil, nil)
}

func (h *Handler) postObject(req *http.Request, ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	if _, ok := h.findBucket(ctx.S3.Bucket); !ok {
		return h.xmlError("NoSuchBucket", "The specified bucket does not exist.", http.StatusNotFound, requestResource(ctx.S3.Bucket, ""))
	}
	form, err := parseMultipartForm(req, ctx.RawBody)
	if err != nil {
		return h.xmlError("InvalidArgument", err.Error(), http.StatusBadRequest, requestResource(ctx.S3.Bucket, ""))
	}
	defer form.RemoveAll()
	key := firstFormValue(form, "key")
	if key == "" {
		return h.xmlError("InvalidArgument", "Bucket POST must contain a field named 'key'.", http.StatusBadRequest, requestResource(ctx.S3.Bucket, ""))
	}
	fileHeader := firstFormFile(form, "file")
	if fileHeader == nil {
		return h.xmlError("InvalidArgument", "Bucket POST must contain a file field.", http.StatusBadRequest, requestResource(ctx.S3.Bucket, key))
	}
	body, err := readMultipartFile(fileHeader)
	if err != nil {
		return h.xmlError("InvalidArgument", err.Error(), http.StatusBadRequest, requestResource(ctx.S3.Bucket, key))
	}
	if err := validatePolicy(firstFormValueAnyCase(form, "Policy"), form, ctx.S3.Bucket, int64(len(body))); err != nil {
		return h.xmlError(err.code, err.message, err.status, requestResource(ctx.S3.Bucket, key))
	}
	contentType := firstFormValue(form, "Content-Type")
	if contentType == "" {
		contentType = fileHeader.Header.Get("Content-Type")
	}
	if contentType == "" {
		contentType = coreassets.DefaultContentType
	}
	stored, err := h.storeObject(ctx.S3.Bucket, key, body, contentType, formObjectOptions(form))
	if err != nil {
		return h.xmlError("InternalFailure", err.Error(), http.StatusInternalServerError, requestResource(ctx.S3.Bucket, key))
	}
	if firstFormValue(form, "success_action_status") == "201" {
		bodyXML := `<?xml version="1.0" encoding="UTF-8"?>
<PostResponse>
  <Location>` + xmlEscape(strings.TrimRight(h.baseURL(req), "/")+"/"+ctx.S3.Bucket+"/"+key) + `</Location>
  <Bucket>` + xmlEscape(ctx.S3.Bucket) + `</Bucket>
  <Key>` + xmlEscape(key) + `</Key>
  <ETag>"` + xmlEscape(stringField(stored, "etag")) + `"</ETag>
</PostResponse>`
		return xmlResponse(http.StatusCreated, bodyXML, nil)
	}
	return response(http.StatusNoContent, "", nil, nil)
}

func (h *Handler) storeObject(bucketName string, key string, body []byte, contentType string, options objectOptions) (corestore.Record, error) {
	now := h.now()
	assetID := awsassets.S3ObjectID(bucketName, key)
	assetMetadata, err := h.assets().PutBytes(assetID, body, coreassets.PutOptions{
		Purpose:      awsassets.PurposeS3Object,
		ContentType:  contentType,
		LastModified: now,
		UserMetadata: options.Metadata,
	})
	if err != nil {
		return nil, err
	}
	record := corestore.Record{
		"bucket_name":    bucketName,
		"key":            key,
		"asset_id":       assetID,
		"content_type":   assetMetadata.ContentType,
		"content_length": assetMetadata.ContentLength,
		"etag":           strings.Trim(assetMetadata.ETag, `"`),
		"last_modified":  assetMetadata.LastModified.Format(time.RFC3339Nano),
		"metadata":       stringMapRecord(options.Metadata),
		"sse_algorithm":  options.ServerSideEncryption,
		"sse_kms_key_id": options.SSEKMSKeyID,
	}
	if existing, ok := h.findObject(bucketName, key); ok {
		updated, _ := h.Objects.Update(intField(existing, "id"), record)
		return updated, nil
	}
	return h.Objects.Insert(record), nil
}

func (h *Handler) findBucket(bucketName string) (corestore.Record, bool) {
	for _, bucket := range h.Buckets.FindBy("bucket_name", bucketName) {
		return bucket, true
	}
	return nil, false
}

func (h *Handler) findObject(bucketName string, key string) (corestore.Record, bool) {
	for _, object := range h.Objects.FindBy("bucket_name", bucketName) {
		if stringField(object, "key") == key {
			return object, true
		}
	}
	return nil, false
}

func (h *Handler) assetBytes(object corestore.Record) ([]byte, coreassets.Metadata, bool) {
	assetID := stringField(object, "asset_id")
	if assetID == "" {
		return nil, coreassets.Metadata{}, false
	}
	return h.assets().Bytes(assetID)
}

func (h *Handler) xmlError(code string, message string, status int, resource string) protocols.ErrorResponse {
	return protocols.SerializeRESTXMLError(protocols.AWSError{
		Code:       code,
		Message:    message,
		Resource:   resource,
		RequestID:  gateway.NewRequestID(),
		StatusCode: status,
	})
}

func (h *Handler) notImplemented(ctx gateway.AwsRequestContext) protocols.ErrorResponse {
	message := "AWS operation is not implemented in the native Go runtime yet."
	if ctx.Service != "" && ctx.Action != "" {
		message = fmt.Sprintf("%s.%s is not implemented in the native Go runtime yet.", ctx.Service, ctx.Action)
	}
	bucket := ""
	key := ""
	if ctx.S3 != nil {
		bucket = ctx.S3.Bucket
		key = ctx.S3.Key
	}
	return h.xmlError("NotImplemented", message, http.StatusNotImplemented, requestResource(bucket, key))
}

func (h *Handler) now() time.Time {
	if h.Now != nil {
		return h.Now().UTC()
	}
	return time.Now().UTC()
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

func response(status int, contentType string, body []byte, headers map[string]string) protocols.ErrorResponse {
	if headers == nil {
		headers = map[string]string{}
	}
	return protocols.ErrorResponse{
		StatusCode:  status,
		ContentType: contentType,
		Headers:     headers,
		Body:        body,
	}
}

func xmlResponse(status int, body string, headers map[string]string) protocols.ErrorResponse {
	return response(status, "application/xml", []byte(body), headers)
}

func withRequestID(response protocols.ErrorResponse, requestID string) protocols.ErrorResponse {
	if requestID == "" {
		return response
	}
	if response.Headers == nil {
		response.Headers = map[string]string{}
	}
	if response.Headers["x-amz-request-id"] == "" {
		response.Headers["x-amz-request-id"] = requestID
	}
	return response
}

func parseMaxKeys(raw string) int {
	if raw == "" {
		return 1000
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 0 {
		return 1000
	}
	if value > 1000 {
		return 1000
	}
	return value
}

func optionalElement(name string, value string) string {
	if value == "" {
		return ""
	}
	return "\n  <" + name + ">" + xmlEscape(value) + "</" + name + ">"
}

func parseCopySource(value string) (string, string, bool) {
	value = strings.TrimPrefix(value, "/")
	if unescaped, err := url.PathUnescape(value); err == nil {
		value = unescaped
	}
	bucket, key, ok := strings.Cut(value, "/")
	return bucket, key, ok && bucket != "" && key != ""
}

func createBucketRegion(body []byte) (string, error) {
	if len(bytes.TrimSpace(body)) == 0 {
		return "", nil
	}
	var config struct {
		LocationConstraint string `xml:"LocationConstraint"`
	}
	if err := xml.Unmarshal(body, &config); err != nil {
		return "", err
	}
	return strings.TrimSpace(config.LocationConstraint), nil
}

func userMetadata(req *http.Request) map[string]string {
	metadata := map[string]string{}
	for name, values := range req.Header {
		lower := strings.ToLower(name)
		if !strings.HasPrefix(lower, "x-amz-meta-") || len(values) == 0 {
			continue
		}
		metadata[lower[len("x-amz-meta-"):]] = values[0]
	}
	if len(metadata) == 0 {
		return nil
	}
	return metadata
}

func requestObjectOptions(req *http.Request) objectOptions {
	return objectOptions{
		Metadata:             userMetadata(req),
		ServerSideEncryption: strings.TrimSpace(req.Header.Get("x-amz-server-side-encryption")),
		SSEKMSKeyID:          strings.TrimSpace(req.Header.Get("x-amz-server-side-encryption-aws-kms-key-id")),
	}
}

func formObjectOptions(form *multipart.Form) objectOptions {
	return objectOptions{
		ServerSideEncryption: strings.TrimSpace(firstFormValueAnyCase(form, "x-amz-server-side-encryption")),
		SSEKMSKeyID:          strings.TrimSpace(firstFormValueAnyCase(form, "x-amz-server-side-encryption-aws-kms-key-id")),
	}
}

func recordObjectOptions(object corestore.Record) objectOptions {
	return objectOptions{
		Metadata:             stringMapField(object, "metadata"),
		ServerSideEncryption: stringField(object, "sse_algorithm"),
		SSEKMSKeyID:          stringField(object, "sse_kms_key_id"),
	}
}

func objectResponseHeaders(object corestore.Record, headers map[string]string) map[string]string {
	if headers == nil {
		headers = map[string]string{}
	}
	if algorithm := stringField(object, "sse_algorithm"); algorithm != "" {
		headers["x-amz-server-side-encryption"] = algorithm
	}
	if keyID := stringField(object, "sse_kms_key_id"); keyID != "" {
		headers["x-amz-server-side-encryption-aws-kms-key-id"] = keyID
	}
	return headers
}

func (h *Handler) evaluateObjectConditions(req *http.Request, object corestore.Record, metadata coreassets.Metadata, bucketName string, key string) *protocols.ErrorResponse {
	headers := conditionalHeaders(object, metadata)
	etag := headers["ETag"]
	lastModified := metadata.LastModified.UTC().Truncate(time.Second)
	ifMatchSatisfied := false
	if raw := strings.TrimSpace(req.Header.Get("If-Match")); raw != "" {
		if !etagListMatches(raw, etag) {
			response := h.xmlError("PreconditionFailed", "At least one of the pre-conditions you specified did not hold.", http.StatusPreconditionFailed, requestResource(bucketName, key))
			return &response
		}
		ifMatchSatisfied = true
	}
	if raw := strings.TrimSpace(req.Header.Get("If-Unmodified-Since")); raw != "" {
		if limit, err := http.ParseTime(raw); err == nil && lastModified.After(limit) && !ifMatchSatisfied {
			response := h.xmlError("PreconditionFailed", "At least one of the pre-conditions you specified did not hold.", http.StatusPreconditionFailed, requestResource(bucketName, key))
			return &response
		}
	}
	if raw := strings.TrimSpace(req.Header.Get("If-None-Match")); raw != "" && etagListMatches(raw, etag) {
		response := response(http.StatusNotModified, "", nil, headers)
		return &response
	}
	if raw := strings.TrimSpace(req.Header.Get("If-Modified-Since")); raw != "" {
		if limit, err := http.ParseTime(raw); err == nil && !lastModified.After(limit) {
			response := response(http.StatusNotModified, "", nil, headers)
			return &response
		}
	}
	return nil
}

func conditionalHeaders(object corestore.Record, metadata coreassets.Metadata) map[string]string {
	return map[string]string{
		"ETag":          quotedETag(stringField(object, "etag")),
		"Last-Modified": metadata.LastModified.UTC().Format(http.TimeFormat),
	}
}

func etagListMatches(raw string, etag string) bool {
	for _, part := range strings.Split(raw, ",") {
		candidate := strings.TrimSpace(part)
		if candidate == "*" {
			return true
		}
		candidate = strings.TrimPrefix(candidate, "W/")
		if candidate == etag || quotedETag(candidate) == etag {
			return true
		}
	}
	return false
}

type byteRange struct {
	start int64
	end   int64
	total int64
}

func parseByteRange(raw string, total int64) (byteRange, bool) {
	if total <= 0 || !strings.HasPrefix(raw, "bytes=") {
		return byteRange{}, false
	}
	spec := strings.TrimSpace(strings.TrimPrefix(raw, "bytes="))
	if strings.Contains(spec, ",") {
		return byteRange{}, false
	}
	startRaw, endRaw, ok := strings.Cut(spec, "-")
	if !ok {
		return byteRange{}, false
	}
	startRaw = strings.TrimSpace(startRaw)
	endRaw = strings.TrimSpace(endRaw)
	if startRaw == "" && endRaw == "" {
		return byteRange{}, false
	}
	if startRaw == "" {
		suffix, err := strconv.ParseInt(endRaw, 10, 64)
		if err != nil || suffix <= 0 {
			return byteRange{}, false
		}
		start := total - suffix
		if start < 0 {
			start = 0
		}
		return byteRange{start: start, end: total - 1, total: total}, true
	}
	start, err := strconv.ParseInt(startRaw, 10, 64)
	if err != nil || start < 0 || start >= total {
		return byteRange{}, false
	}
	end := total - 1
	if endRaw != "" {
		parsedEnd, err := strconv.ParseInt(endRaw, 10, 64)
		if err != nil || parsedEnd < start {
			return byteRange{}, false
		}
		if parsedEnd < end {
			end = parsedEnd
		}
	}
	return byteRange{start: start, end: end, total: total}, true
}

func (h *Handler) assets() *coreassets.Store {
	if h.Assets == nil {
		h.Assets = coreassets.New()
	}
	return h.Assets
}

func parseMultipartForm(req *http.Request, body []byte) (*multipart.Form, error) {
	contentType := req.Header.Get("Content-Type")
	mediaType, params, err := mime.ParseMediaType(contentType)
	if err != nil || !strings.HasPrefix(strings.ToLower(mediaType), "multipart/") {
		return nil, fmt.Errorf("Bucket POST must use multipart form data.")
	}
	boundary := params["boundary"]
	if boundary == "" {
		return nil, fmt.Errorf("Bucket POST multipart form is missing a boundary.")
	}
	reader := multipart.NewReader(bytes.NewReader(body), boundary)
	form, err := reader.ReadForm(32 << 20)
	if err != nil {
		return nil, fmt.Errorf("Invalid multipart form: %v", err)
	}
	return form, nil
}

func firstFormValue(form *multipart.Form, key string) string {
	if values := form.Value[key]; len(values) > 0 {
		return values[0]
	}
	return ""
}

func firstFormValueAnyCase(form *multipart.Form, key string) string {
	if value := firstFormValue(form, key); value != "" {
		return value
	}
	for candidate, values := range form.Value {
		if strings.EqualFold(candidate, key) && len(values) > 0 {
			return values[0]
		}
	}
	return ""
}

func firstFormFile(form *multipart.Form, key string) *multipart.FileHeader {
	if values := form.File[key]; len(values) > 0 {
		return values[0]
	}
	return nil
}

func readMultipartFile(header *multipart.FileHeader) ([]byte, error) {
	file, err := header.Open()
	if err != nil {
		return nil, fmt.Errorf("read file field: %w", err)
	}
	defer file.Close()
	return io.ReadAll(file)
}

type policyError struct {
	code    string
	message string
	status  int
}

func validatePolicy(raw string, form *multipart.Form, bucketName string, size int64) *policyError {
	if raw == "" {
		return nil
	}
	decoded, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		decoded, err = base64.RawStdEncoding.DecodeString(raw)
	}
	if err != nil {
		return &policyError{code: "InvalidPolicyDocument", message: "Invalid Policy: Invalid base64.", status: http.StatusBadRequest}
	}
	var policy struct {
		Expiration string `json:"expiration"`
		Conditions []any  `json:"conditions"`
	}
	if err := json.Unmarshal(decoded, &policy); err != nil {
		return &policyError{code: "InvalidPolicyDocument", message: "Invalid Policy: Invalid JSON.", status: http.StatusBadRequest}
	}
	if policy.Expiration != "" {
		expires, err := time.Parse(time.RFC3339, policy.Expiration)
		if err == nil && expires.Before(time.Now()) {
			return &policyError{code: "AccessDenied", message: "Invalid according to Policy: Policy expired.", status: http.StatusForbidden}
		}
	}
	for _, condition := range policy.Conditions {
		switch values := condition.(type) {
		case map[string]any:
			for field, expected := range values {
				expectedValue, ok := stringValue(expected)
				if !ok {
					continue
				}
				if policyFieldValue(form, bucketName, field) != expectedValue {
					return policyConditionFailed(condition)
				}
			}
		case []any:
			if err := validatePolicyArrayCondition(values, form, bucketName, size); err != nil {
				return err
			}
		}
	}
	return nil
}

func validatePolicyArrayCondition(values []any, form *multipart.Form, bucketName string, size int64) *policyError {
	if len(values) == 0 {
		return nil
	}
	operator, _ := values[0].(string)
	switch operator {
	case "content-length-range":
		if len(values) < 3 {
			return nil
		}
		min, minOK := numberValue(values[1])
		max, maxOK := numberValue(values[2])
		if minOK && maxOK && (size < min || size > max) {
			return &policyError{code: "EntityTooLarge", message: "Your proposed upload exceeds the maximum allowed size.", status: http.StatusBadRequest}
		}
	case "starts-with":
		if len(values) < 3 {
			return nil
		}
		field, _ := values[1].(string)
		prefix, _ := values[2].(string)
		value := policyFieldValue(form, bucketName, field)
		if !strings.HasPrefix(value, prefix) {
			return policyConditionFailed(values)
		}
	case "eq":
		if len(values) < 3 {
			return nil
		}
		field, _ := values[1].(string)
		expected, ok := stringValue(values[2])
		if !ok {
			return nil
		}
		if policyFieldValue(form, bucketName, field) != expected {
			return policyConditionFailed(values)
		}
	}
	return nil
}

func policyFieldValue(form *multipart.Form, bucketName string, field string) string {
	field = strings.TrimPrefix(field, "$")
	if field == "bucket" {
		return bucketName
	}
	return firstFormValueAnyCase(form, field)
}

func stringValue(value any) (string, bool) {
	switch v := value.(type) {
	case string:
		return v, true
	default:
		return "", false
	}
}

func policyConditionFailed(condition any) *policyError {
	conditionText := fmt.Sprint(condition)
	if raw, err := json.Marshal(condition); err == nil {
		conditionText = string(raw)
	}
	return &policyError{
		code:    "AccessDenied",
		message: "Invalid according to Policy: Policy Condition failed: " + conditionText,
		status:  http.StatusForbidden,
	}
}

func numberValue(value any) (int64, bool) {
	switch v := value.(type) {
	case float64:
		return int64(v), true
	case json.Number:
		n, err := v.Int64()
		return n, err == nil
	default:
		return 0, false
	}
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

func stringMapRecord(values map[string]string) corestore.Record {
	if len(values) == 0 {
		return corestore.Record{}
	}
	record := corestore.Record{}
	for key, value := range values {
		record[key] = value
	}
	return record
}

func stringMapField(record corestore.Record, name string) map[string]string {
	out := map[string]string{}
	switch values := record[name].(type) {
	case corestore.Record:
		for key, value := range values {
			out[key] = fmt.Sprint(value)
		}
	case map[string]any:
		for key, value := range values {
			out[key] = fmt.Sprint(value)
		}
	case map[string]string:
		for key, value := range values {
			out[key] = value
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func quotedETag(value string) string {
	value = strings.Trim(value, `"`)
	return `"` + value + `"`
}

func httpTime(value string) string {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return ""
	}
	return parsed.UTC().Format(http.TimeFormat)
}

func requestResource(bucket string, key string) string {
	if bucket == "" {
		return "/"
	}
	if key == "" {
		return "/" + bucket
	}
	return "/" + bucket + "/" + key
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
