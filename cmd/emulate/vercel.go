package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
)

const requiredVercelGoVersion = "1.24"

var defaultVercelRewrite = map[string]string{
	"source":      "/emulate/:path*",
	"destination": "/api/emulate?path=:path*",
}

var supportedVercelServices = []string{"apple", "aws", "clerk", "github", "google", "microsoft", "mongoatlas", "okta", "resend", "slack", "stripe", "vercel"}

type vercelScaffoldResult struct {
	Created   []string
	Updated   []string
	Unchanged []string
	Services  []string
}

type preparedVercelConfig struct {
	RelativePath string
	Target       string
	Existed      bool
	Changed      bool
	Content      string
}

func runVercel(args []string, stdout io.Writer, stderr io.Writer) int {
	if len(args) == 0 {
		printVercelHelp(stderr)
		return 1
	}
	switch args[0] {
	case "-h", "--help", "help":
		printVercelHelp(stdout)
		return 0
	case "init":
		return runVercelInit(args[1:], stdout, stderr)
	default:
		fmt.Fprintf(stderr, "Unknown vercel command: %s\n", args[0])
		printVercelHelp(stderr)
		return 1
	}
}

func runVercelInit(args []string, stdout io.Writer, stderr io.Writer) int {
	fs := flag.NewFlagSet("vercel init", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() {
		printVercelInitHelp(stderr)
	}
	serviceValue := fs.String("service", strings.Join(supportedVercelServices, ","), "Comma-separated native services to enable")
	fs.StringVar(serviceValue, "s", strings.Join(supportedVercelServices, ","), "Comma-separated native services to enable")
	forceValue := fs.Bool("force", false, "Overwrite generated files")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 1
	}
	if hasUnexpectedArg(fs, stderr) {
		return 1
	}

	result, err := createVercelScaffold(".", *serviceValue, *forceValue, version)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	for _, file := range result.Created {
		fmt.Fprintf(stdout, "Created %s\n", file)
	}
	for _, file := range result.Updated {
		fmt.Fprintf(stdout, "Updated %s\n", file)
	}
	for _, file := range result.Unchanged {
		fmt.Fprintf(stdout, "Skipped existing %s\n", file)
	}
	fmt.Fprintf(stdout, "\nVercel Go Function scaffold ready for: %s\n", strings.Join(result.Services, ", "))
	fmt.Fprintln(stdout, "State uses warm in-memory stores by default. Cold starts reset state, and concurrent instances can diverge.")
	fmt.Fprintln(stdout, "Add a vercel.Persistence implementation in api/emulate.go when snapshots need to survive cold starts.")
	return 0
}

func printVercelHelp(w io.Writer) {
	fmt.Fprintln(w, "Usage:")
	fmt.Fprintln(w, "  npx emulate vercel init [--service <services>] [--force]")
}

func printVercelInitHelp(w io.Writer) {
	fmt.Fprintln(w, "Usage:")
	fmt.Fprintln(w, "  npx emulate vercel init [--service <services>] [--force]")
	fmt.Fprintln(w, "\nOptions:")
	fmt.Fprintln(w, "  -s, --service <services>   Comma-separated native services to enable")
	fmt.Fprintln(w, "      --force                Overwrite generated files")
}

func createVercelScaffold(cwd string, serviceValue string, force bool, versionValue string) (vercelScaffoldResult, error) {
	root, err := filepath.Abs(cwd)
	if err != nil {
		return vercelScaffoldResult{}, err
	}
	services, err := parseVercelServices(serviceValue)
	if err != nil {
		return vercelScaffoldResult{}, err
	}
	prepared, err := prepareVercelConfig(root, force)
	if err != nil {
		return vercelScaffoldResult{}, err
	}
	result := vercelScaffoldResult{Services: services}
	if err := os.MkdirAll(filepath.Join(root, "api"), 0o755); err != nil {
		return result, err
	}
	if err := writeFileIfAllowed(root, "api/emulate.go", renderVercelHandler(services), force, &result); err != nil {
		return result, err
	}
	if err := updateVercelGoMod(root, versionValue, &result); err != nil {
		return result, err
	}
	if err := writePreparedVercelConfig(prepared, &result); err != nil {
		return result, err
	}
	return result, nil
}

func parseVercelServices(value string) ([]string, error) {
	if strings.TrimSpace(value) == "" || strings.EqualFold(strings.TrimSpace(value), "all") {
		return append([]string(nil), supportedVercelServices...), nil
	}
	supported := map[string]bool{}
	for _, service := range supportedVercelServices {
		supported[service] = true
	}
	services := []string{}
	seen := map[string]bool{}
	for _, part := range strings.Split(value, ",") {
		name := strings.ToLower(strings.TrimSpace(part))
		if name == "" || seen[name] {
			continue
		}
		if !supported[name] {
			return nil, fmt.Errorf("The Vercel Go Function scaffold currently supports native services: %s", strings.Join(supportedVercelServices, ", "))
		}
		seen[name] = true
		services = append(services, name)
	}
	if len(services) == 0 {
		return append([]string(nil), supportedVercelServices...), nil
	}
	return services, nil
}

func writeFileIfAllowed(root string, relativePath string, content string, force bool, result *vercelScaffoldResult) error {
	target := filepath.Join(root, relativePath)
	_, statErr := os.Stat(target)
	if statErr == nil && !force {
		result.Unchanged = append(result.Unchanged, relativePath)
		return nil
	}
	if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
		return statErr
	}
	existed := statErr == nil
	if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
		return err
	}
	if existed {
		result.Updated = append(result.Updated, relativePath)
	} else {
		result.Created = append(result.Created, relativePath)
	}
	return nil
}

func updateVercelGoMod(root string, versionValue string, result *vercelScaffoldResult) error {
	relativePath := "go.mod"
	target := filepath.Join(root, relativePath)
	moduleVersion := normalizeGoModuleVersion(versionValue)
	raw, err := os.ReadFile(target)
	if errors.Is(err, os.ErrNotExist) {
		if err := os.WriteFile(target, []byte(renderVercelGoMod(moduleVersion)), 0o644); err != nil {
			return err
		}
		result.Created = append(result.Created, relativePath)
		return nil
	}
	if err != nil {
		return err
	}
	content := string(raw)
	next := content
	if existing := getEmulateRequirementVersion(content); existing != moduleVersion {
		if existing == "" {
			next = addEmulateRequirement(next, moduleVersion)
		} else {
			next = updateEmulateRequirement(next, moduleVersion)
		}
	}
	next = ensureGoDirective(next, requiredVercelGoVersion)
	if next == content {
		result.Unchanged = append(result.Unchanged, relativePath)
		return nil
	}
	if err := os.WriteFile(target, []byte(next), 0o644); err != nil {
		return err
	}
	result.Updated = append(result.Updated, relativePath)
	return nil
}

func getEmulateRequirementVersion(content string) string {
	match := regexp.MustCompile(`(?m)^[ \t]*(?:require[ \t]+)?github\.com/vercel-labs/emulate[ \t]+(v\S+)`).FindStringSubmatch(content)
	if len(match) == 0 {
		return ""
	}
	return match[1]
}

func updateEmulateRequirement(content string, moduleVersion string) string {
	re := regexp.MustCompile(`(?m)^([ \t]*(?:require[ \t]+)?github\.com/vercel-labs/emulate[ \t]+)v\S+([ \t]*(?://.*)?$)`)
	return re.ReplaceAllString(content, "${1}"+moduleVersion+"${2}")
}

func addEmulateRequirement(content string, moduleVersion string) string {
	dependency := "github.com/vercel-labs/emulate " + moduleVersion
	if regexp.MustCompile(`(?m)^require\s*\(`).MatchString(content) {
		re := regexp.MustCompile(`(?m)^require\s*\(\s*\n`)
		return re.ReplaceAllStringFunc(content, func(match string) string {
			return match + "\t" + dependency + "\n"
		})
	}
	suffix := ""
	if !strings.HasSuffix(content, "\n") {
		suffix = "\n"
	}
	return content + suffix + "\nrequire " + dependency + "\n"
}

func ensureGoDirective(content string, requiredVersion string) string {
	re := regexp.MustCompile(`(?m)^([ \t]*go[ \t]+)(\S+)([ \t]*(?://.*)?$)`)
	match := re.FindStringSubmatch(content)
	if len(match) > 0 {
		if compareGoVersions(match[2], requiredVersion) >= 0 {
			return content
		}
		return re.ReplaceAllString(content, "${1}"+requiredVersion+"${3}")
	}
	moduleRe := regexp.MustCompile(`(?m)^(module[ \t]+\S+[ \t]*(?://.*)?)(?:\r?\n)+`)
	if moduleRe.MatchString(content) {
		return moduleRe.ReplaceAllString(content, "$1\n\ngo "+requiredVersion+"\n\n")
	}
	suffix := ""
	if !strings.HasSuffix(content, "\n") {
		suffix = "\n"
	}
	return content + suffix + "\ngo " + requiredVersion + "\n"
}

func compareGoVersions(left string, right string) int {
	leftParts := parseGoVersion(left)
	rightParts := parseGoVersion(right)
	if leftParts == nil || rightParts == nil {
		if left == right {
			return 0
		}
		return -1
	}
	for index := 0; index < 3; index++ {
		if leftParts[index] != rightParts[index] {
			return leftParts[index] - rightParts[index]
		}
	}
	return 0
}

func parseGoVersion(value string) []int {
	match := regexp.MustCompile(`^(\d+)\.(\d+)(?:\.(\d+))?(?:rc\d+)?$`).FindStringSubmatch(value)
	if len(match) == 0 {
		return nil
	}
	patch := 0
	if match[3] != "" {
		patch, _ = strconv.Atoi(match[3])
	}
	major, _ := strconv.Atoi(match[1])
	minor, _ := strconv.Atoi(match[2])
	return []int{major, minor, patch}
}

func prepareVercelConfig(root string, force bool) (preparedVercelConfig, error) {
	relativePath := "vercel.json"
	target := filepath.Join(root, relativePath)
	config := map[string]any{"$schema": "https://openapi.vercel.sh/vercel.json"}
	existed := false
	raw, err := os.ReadFile(target)
	if err == nil {
		existed = true
		if err := json.Unmarshal(raw, &config); err != nil {
			return preparedVercelConfig{}, fmt.Errorf("Failed to parse %s: %v", relativePath, err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return preparedVercelConfig{}, err
	}
	rewriteList, err := vercelRewriteList(config)
	if err != nil {
		return preparedVercelConfig{}, err
	}
	for _, rewrite := range rewriteList {
		if isRewrite(rewrite) && stringField(rewrite, "source") == defaultVercelRewrite["source"] && stringField(rewrite, "destination") != defaultVercelRewrite["destination"] {
			return preparedVercelConfig{}, fmt.Errorf("%s already has a rewrite for %s", relativePath, defaultVercelRewrite["source"])
		}
	}
	hasRewrite := false
	for _, rewrite := range rewriteList {
		if isDefaultVercelRewrite(rewrite) {
			hasRewrite = true
			break
		}
	}
	next := rewriteList
	if !hasRewrite {
		next = insertVercelRewrite(next)
	}
	next = moveVercelRewriteBeforeCatchAll(next)
	if hasRewrite && !force && rewriteListsEqual(next, rewriteList) {
		return preparedVercelConfig{RelativePath: relativePath, Target: target, Existed: existed}, nil
	}
	config["rewrites"] = recordsToInterfaces(next)
	if _, ok := config["$schema"]; !ok {
		config["$schema"] = "https://openapi.vercel.sh/vercel.json"
	}
	content, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return preparedVercelConfig{}, err
	}
	return preparedVercelConfig{
		RelativePath: relativePath,
		Target:       target,
		Existed:      existed,
		Changed:      true,
		Content:      string(content) + "\n",
	}, nil
}

func vercelRewriteList(config map[string]any) ([]map[string]any, error) {
	raw, ok := config["rewrites"]
	if !ok {
		return []map[string]any{}, nil
	}
	items, ok := raw.([]any)
	if !ok {
		return nil, fmt.Errorf("vercel.json rewrites must be an array to add the emulate preview route")
	}
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		object, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("vercel.json rewrites must contain objects to add the emulate preview route")
		}
		out = append(out, cloneInterfaceMap(object))
	}
	return out, nil
}

func writePreparedVercelConfig(prepared preparedVercelConfig, result *vercelScaffoldResult) error {
	if !prepared.Changed {
		result.Unchanged = append(result.Unchanged, prepared.RelativePath)
		return nil
	}
	if err := os.WriteFile(prepared.Target, []byte(prepared.Content), 0o644); err != nil {
		return err
	}
	if prepared.Existed {
		result.Updated = append(result.Updated, prepared.RelativePath)
	} else {
		result.Created = append(result.Created, prepared.RelativePath)
	}
	return nil
}

func insertVercelRewrite(rewrites []map[string]any) []map[string]any {
	catchAll := -1
	for index, rewrite := range rewrites {
		if isCatchAllSource(stringField(rewrite, "source")) {
			catchAll = index
			break
		}
	}
	next := cloneRewriteList(rewrites)
	rewrite := defaultVercelRewriteRecord()
	if catchAll < 0 {
		return append(next, rewrite)
	}
	next = append(next[:catchAll], append([]map[string]any{rewrite}, next[catchAll:]...)...)
	return next
}

func moveVercelRewriteBeforeCatchAll(rewrites []map[string]any) []map[string]any {
	rewriteIndex := -1
	catchAllIndex := -1
	for index, rewrite := range rewrites {
		if rewriteIndex < 0 && isDefaultVercelRewrite(rewrite) {
			rewriteIndex = index
		}
		if catchAllIndex < 0 && isCatchAllSource(stringField(rewrite, "source")) {
			catchAllIndex = index
		}
	}
	if rewriteIndex < 0 || catchAllIndex < 0 || rewriteIndex < catchAllIndex {
		return rewrites
	}
	next := cloneRewriteList(rewrites)
	rewrite := next[rewriteIndex]
	next = append(next[:rewriteIndex], next[rewriteIndex+1:]...)
	catchAllIndex = -1
	for index, candidate := range next {
		if isCatchAllSource(stringField(candidate, "source")) {
			catchAllIndex = index
			break
		}
	}
	return append(next[:catchAllIndex], append([]map[string]any{rewrite}, next[catchAllIndex:]...)...)
}

func isDefaultVercelRewrite(value map[string]any) bool {
	return stringField(value, "source") == defaultVercelRewrite["source"] && stringField(value, "destination") == defaultVercelRewrite["destination"]
}

func isRewrite(value map[string]any) bool {
	return stringField(value, "source") != "" && stringField(value, "destination") != ""
}

func isCatchAllSource(source string) bool {
	value := strings.TrimSpace(source)
	if value == "/(.*)" {
		return true
	}
	return regexp.MustCompile(`^/:[A-Za-z_][\w-]*(?:\*|\(\.\*\))$`).MatchString(value)
}

func rewriteListsEqual(left []map[string]any, right []map[string]any) bool {
	return reflect.DeepEqual(left, right)
}

func recordsToInterfaces(records []map[string]any) []any {
	out := make([]any, 0, len(records))
	for _, record := range records {
		out = append(out, cloneInterfaceMap(record))
	}
	return out
}

func cloneInterfaceMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

func cloneRewriteList(in []map[string]any) []map[string]any {
	out := make([]map[string]any, 0, len(in))
	for _, rewrite := range in {
		out = append(out, cloneInterfaceMap(rewrite))
	}
	return out
}

func defaultVercelRewriteRecord() map[string]any {
	return map[string]any{
		"source":      defaultVercelRewrite["source"],
		"destination": defaultVercelRewrite["destination"],
	}
}

func stringField(value map[string]any, key string) string {
	str, _ := value[key].(string)
	return str
}

func renderVercelHandler(services []string) string {
	quoted := make([]string, 0, len(services))
	for _, service := range services {
		quoted = append(quoted, strconv.Quote(service))
	}
	return `package handler

import (
	"net/http"

	emulate "github.com/vercel-labs/emulate/vercel"
)

var emulateHandler = emulate.NewHandler(emulate.Options{
	Services: []string{` + strings.Join(quoted, ", ") + `},
})

func Handler(w http.ResponseWriter, r *http.Request) {
	emulateHandler.ServeHTTP(w, r)
}
`
}

func normalizeGoModuleVersion(value string) string {
	if strings.HasPrefix(value, "v") {
		return value
	}
	return "v" + value
}

func renderVercelGoMod(moduleVersion string) string {
	return `module emulate-vercel-preview

go ` + requiredVercelGoVersion + `

require github.com/vercel-labs/emulate ` + moduleVersion + `
`
}
