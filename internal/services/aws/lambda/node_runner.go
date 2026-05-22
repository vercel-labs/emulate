package lambda

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	corestore "github.com/vercel-labs/emulate/internal/core/store"
	"github.com/vercel-labs/emulate/internal/services/aws/gateway"
)

const lambdaNodeResultMarker = "__EMULATE_LAMBDA_RESULT__"

type localInvokeResult struct {
	Payload       []byte
	Logs          []string
	FunctionError string
}

type nodeEnvelope struct {
	OK           bool     `json:"ok"`
	Payload      string   `json:"payload"`
	ErrorType    string   `json:"errorType"`
	ErrorMessage string   `json:"errorMessage"`
	Logs         []string `json:"logs"`
}

func (h *Handler) invokeLocalNode(ctx gateway.AwsRequestContext, fn corestore.Record, executedVersion string, payload []byte, requestID string) (localInvokeResult, bool) {
	if !strings.HasPrefix(strings.TrimSpace(stringField(fn, "runtime")), "nodejs") {
		return localInvokeResult{}, false
	}
	archive, ok := inlineCodeZip(fn)
	if !ok {
		return localInvokeResult{}, false
	}
	zipReader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		return localInvokeResult{}, false
	}
	workingDir, err := os.MkdirTemp("", "emulate-lambda-*")
	if err != nil {
		return localInvokeFailure("Runtime.Unknown", err.Error(), nil), true
	}
	defer os.RemoveAll(workingDir)
	if err := extractLambdaZip(zipReader, workingDir); err != nil {
		return localInvokeFailure("Runtime.InvalidZipFileException", err.Error(), nil), true
	}
	if _, err := exec.LookPath("node"); err != nil {
		return localInvokeFailure("Runtime.InvalidRuntime", "node executable was not found for local Lambda invocation", nil), true
	}
	wrapperPath := filepath.Join(workingDir, ".emulate-lambda-wrapper.mjs")
	if err := os.WriteFile(wrapperPath, []byte(lambdaNodeWrapperSource), 0o600); err != nil {
		return localInvokeFailure("Runtime.Unknown", err.Error(), nil), true
	}
	timeoutSeconds := intFieldDefault(fn, "timeout", 3)
	if timeoutSeconds <= 0 {
		timeoutSeconds = 3
	}
	contextValue, _ := json.Marshal(lambdaNodeContext(ctx, fn, executedVersion, requestID, timeoutSeconds))
	runCtx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSeconds)*time.Second)
	defer cancel()
	cmd := exec.CommandContext(runCtx, "node", wrapperPath, stringField(fn, "handler"), base64.StdEncoding.EncodeToString(contextValue))
	cmd.Dir = workingDir
	cmd.Env = lambdaNodeEnvironment(ctx, fn, executedVersion)
	cmd.Stdin = bytes.NewReader(payload)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err = cmd.Run()
	if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
		message := fmt.Sprintf("Task timed out after %d seconds", timeoutSeconds)
		return localInvokeFailure("TimeoutError", message, append(splitLogLines(stdout.String()), splitLogLines(stderr.String())...)), true
	}
	result, ok := parseNodeInvokeOutput(stdout.String(), stderr.String())
	if !ok {
		logs := append(splitLogLines(stdout.String()), splitLogLines(stderr.String())...)
		if err != nil {
			logs = append(logs, err.Error())
		}
		return localInvokeFailure("Runtime.Unknown", "local Node.js Lambda invocation did not return a result", logs), true
	}
	if !result.OK {
		payload, err := base64.StdEncoding.DecodeString(result.Payload)
		if err != nil || len(payload) == 0 {
			payload = lambdaErrorPayload(firstNonEmpty(result.ErrorType, "Error"), result.ErrorMessage)
		}
		return localInvokeResult{Payload: payload, Logs: result.Logs, FunctionError: "Unhandled"}, true
	}
	decoded, err := base64.StdEncoding.DecodeString(result.Payload)
	if err != nil {
		return localInvokeFailure("Runtime.Unknown", "local Node.js Lambda invocation returned invalid payload", result.Logs), true
	}
	return localInvokeResult{Payload: decoded, Logs: result.Logs}, true
}

func inlineCodeZip(fn corestore.Record) ([]byte, bool) {
	encoded := strings.TrimSpace(stringField(fn, "code_zip_base64"))
	if encoded == "" {
		return nil, false
	}
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(decoded) == 0 {
		return nil, false
	}
	return decoded, true
}

func extractLambdaZip(reader *zip.Reader, destination string) error {
	for _, file := range reader.File {
		target := filepath.Join(destination, file.Name)
		relative, err := filepath.Rel(destination, target)
		if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) || filepath.IsAbs(relative) {
			return fmt.Errorf("zip entry %q escapes the function directory", file.Name)
		}
		if file.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		source, err := file.Open()
		if err != nil {
			return err
		}
		mode := file.Mode()
		if mode == 0 {
			mode = 0o644
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
		if err != nil {
			source.Close()
			return err
		}
		_, copyErr := io.Copy(out, source)
		closeErr := out.Close()
		source.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}

func lambdaNodeContext(ctx gateway.AwsRequestContext, fn corestore.Record, executedVersion string, requestID string, timeoutSeconds int) map[string]any {
	executedVersion = firstNonEmpty(executedVersion, "$LATEST")
	arn := stringField(fn, "arn")
	if executedVersion != "$LATEST" && arn != "" && !strings.HasSuffix(arn, ":"+executedVersion) {
		arn += ":" + executedVersion
	}
	return map[string]any{
		"awsRequestId":       requestID,
		"functionName":       stringField(fn, "function_name"),
		"functionVersion":    executedVersion,
		"invokedFunctionArn": arn,
		"memoryLimitInMB":    intFieldDefault(fn, "memory_size", 128),
		"logGroupName":       logGroupName(stringField(fn, "function_name")),
		"logStreamName":      time.Now().UTC().Format("2006/01/02") + "/[" + executedVersion + "]" + requestID,
		"deadlineMs":         time.Now().Add(time.Duration(timeoutSeconds) * time.Second).UnixMilli(),
		"region":             hRegion(ctx),
	}
}

func hRegion(ctx gateway.AwsRequestContext) string {
	if ctx.Region != "" {
		return ctx.Region
	}
	return gateway.DefaultRegion
}

func lambdaNodeEnvironment(ctx gateway.AwsRequestContext, fn corestore.Record, executedVersion string) []string {
	executedVersion = firstNonEmpty(executedVersion, "$LATEST")
	env := append([]string{}, os.Environ()...)
	for key, value := range mapRecord(fn["environment"]) {
		env = append(env, key+"="+stringValue(value))
	}
	region := ctx.Region
	if region == "" {
		region = gateway.DefaultRegion
	}
	env = append(env,
		"_HANDLER="+stringField(fn, "handler"),
		"AWS_REGION="+region,
		"AWS_DEFAULT_REGION="+region,
		"AWS_LAMBDA_FUNCTION_NAME="+stringField(fn, "function_name"),
		"AWS_LAMBDA_FUNCTION_VERSION="+executedVersion,
		"AWS_LAMBDA_FUNCTION_MEMORY_SIZE="+fmt.Sprint(intFieldDefault(fn, "memory_size", 128)),
		"AWS_LAMBDA_LOG_GROUP_NAME="+logGroupName(stringField(fn, "function_name")),
		"AWS_LAMBDA_LOG_STREAM_NAME="+time.Now().UTC().Format("2006/01/02")+"/["+executedVersion+"]local",
	)
	return env
}

func parseNodeInvokeOutput(stdout string, stderr string) (nodeEnvelope, bool) {
	index := strings.LastIndex(stdout, lambdaNodeResultMarker)
	if index < 0 {
		return nodeEnvelope{}, false
	}
	prefix := stdout[:index]
	rest := strings.TrimSpace(stdout[index+len(lambdaNodeResultMarker):])
	if newline := strings.IndexByte(rest, '\n'); newline >= 0 {
		rest = strings.TrimSpace(rest[:newline])
	}
	decoded, err := base64.StdEncoding.DecodeString(rest)
	if err != nil {
		return nodeEnvelope{}, false
	}
	var envelope nodeEnvelope
	if err := json.Unmarshal(decoded, &envelope); err != nil {
		return nodeEnvelope{}, false
	}
	logs := append([]string{}, splitLogLines(prefix)...)
	logs = append(logs, envelope.Logs...)
	logs = append(logs, splitLogLines(stderr)...)
	envelope.Logs = logs
	return envelope, true
}

func localInvokeFailure(errorType string, errorMessage string, logs []string) localInvokeResult {
	return localInvokeResult{
		Payload:       lambdaErrorPayload(errorType, errorMessage),
		Logs:          logs,
		FunctionError: "Unhandled",
	}
}

func lambdaErrorPayload(errorType string, errorMessage string) []byte {
	payload, _ := json.Marshal(map[string]any{"errorType": errorType, "errorMessage": errorMessage})
	return payload
}

func splitLogLines(value string) []string {
	value = strings.ReplaceAll(value, "\r\n", "\n")
	value = strings.TrimRight(value, "\n")
	if value == "" {
		return nil
	}
	parts := strings.Split(value, "\n")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		out = append(out, strings.TrimRight(part, "\r"))
	}
	return out
}

const lambdaNodeWrapperSource = `import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const marker = "__EMULATE_LAMBDA_RESULT__";
const [handlerSpec, contextBase64 = ""] = process.argv.slice(2);
const logs = [];

function formatLog(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

for (const method of ["debug", "error", "info", "log", "warn"]) {
  console[method] = (...args) => {
    logs.push(args.map(formatLog).join(" "));
  };
}

function payloadBase64(value) {
  return Buffer.from(JSON.stringify(value === undefined ? null : value)).toString("base64");
}

function errorPayload(error) {
  const errorType = error && error.name ? error.name : "Error";
  const errorMessage = error && error.message ? error.message : String(error);
  const stackTrace = error && error.stack ? String(error.stack).split("\n").slice(1).map((line) => line.trim()) : [];
  return { errorType, errorMessage, stackTrace };
}

function respond(envelope) {
  envelope.logs = logs;
  const encoded = Buffer.from(JSON.stringify(envelope)).toString("base64");
  process.stdout.write("\n" + marker + encoded + "\n", () => {
    process.exit(envelope.ok ? 0 : 1);
  });
}

function parseEvent() {
  const raw = readFileSync(0, "utf8");
  if (raw.trim() === "") return {};
  return JSON.parse(raw);
}

function parseContext() {
  if (!contextBase64) return {};
  return JSON.parse(Buffer.from(contextBase64, "base64").toString("utf8"));
}

async function loadHandler(spec) {
  const separator = spec.lastIndexOf(".");
  if (separator <= 0 || separator === spec.length - 1) {
    throw new Error("Invalid Lambda handler " + JSON.stringify(spec));
  }
  const moduleName = spec.slice(0, separator);
  const exportName = spec.slice(separator + 1);
  const require = createRequire(import.meta.url);
  const base = moduleName.startsWith(".") || moduleName.startsWith("/") ? moduleName : "./" + moduleName;
  const candidates = [base, base + ".js", base + ".mjs", path.join(base, "index.js"), path.join(base, "index.mjs")];
  let lastError;
  for (const candidate of candidates) {
    let resolved;
    try {
      resolved = require.resolve(candidate);
    } catch (error) {
      if (error && error.code === "MODULE_NOT_FOUND") {
        lastError = error;
        continue;
      }
      throw error;
    }
    let loaded;
    try {
      loaded = require(resolved);
    } catch (error) {
      if (error && error.code === "ERR_REQUIRE_ESM") {
        loaded = await import(pathToFileURL(resolved).href);
      } else {
        throw error;
      }
    }
    const handler = loaded[exportName] || (loaded.default && loaded.default[exportName]) || (exportName === "default" ? loaded.default : undefined);
    if (typeof handler === "function") return handler;
    lastError = new Error("Lambda handler export " + JSON.stringify(exportName) + " was not found in " + JSON.stringify(candidate));
  }
  throw lastError || new Error("Cannot load Lambda handler " + JSON.stringify(spec));
}

function invokeHandler(handler, event, context) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const callback = (error, result) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(result);
    };
    context.done = callback;
    context.succeed = (result) => callback(null, result);
    context.fail = (error) => callback(error);
    try {
      const returned = handler(event, context, callback);
      if (returned && typeof returned.then === "function") {
        returned.then((value) => callback(null, value), callback);
      } else if (returned !== undefined || handler.length < 2) {
        callback(null, returned);
      }
    } catch (error) {
      callback(error);
    }
  });
}

try {
  const contextData = parseContext();
  const context = {
    callbackWaitsForEmptyEventLoop: true,
    functionName: contextData.functionName || "",
    functionVersion: contextData.functionVersion || "$LATEST",
    invokedFunctionArn: contextData.invokedFunctionArn || "",
    memoryLimitInMB: String(contextData.memoryLimitInMB || 128),
    awsRequestId: contextData.awsRequestId || "",
    logGroupName: contextData.logGroupName || "",
    logStreamName: contextData.logStreamName || "",
    getRemainingTimeInMillis: () => Math.max(0, Number(contextData.deadlineMs || Date.now()) - Date.now()),
  };
  const handler = await loadHandler(handlerSpec);
  const result = await invokeHandler(handler, parseEvent(), context);
  respond({ ok: true, payload: payloadBase64(result) });
} catch (error) {
  const payload = errorPayload(error);
  respond({ ok: false, payload: payloadBase64(payload), errorType: payload.errorType, errorMessage: payload.errorMessage });
}
`
