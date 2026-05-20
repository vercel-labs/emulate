package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	nethttp "net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	coreconfig "github.com/vercel-labs/emulate/internal/core/config"
	emuruntime "github.com/vercel-labs/emulate/internal/runtime"
	"github.com/vercel-labs/emulate/internal/services/github"
	"github.com/vercel-labs/emulate/internal/services/resend"
	"github.com/vercel-labs/emulate/internal/services/vercel"
)

var version = "dev"

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	os.Exit(runWithContext(ctx, os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout io.Writer, stderr io.Writer) int {
	return runWithContext(context.Background(), args, stdout, stderr)
}

func runWithContext(ctx context.Context, args []string, stdout io.Writer, stderr io.Writer) int {
	if len(args) == 0 {
		return runStart(ctx, nil, stdout, stderr)
	}

	switch args[0] {
	case "-h", "--help", "help":
		printHelp(stdout)
		return 0
	case "-v", "--version", "version":
		fmt.Fprintf(stdout, "emulate %s\n", version)
		return 0
	case "start":
		return runStart(ctx, args[1:], stdout, stderr)
	case "init":
		return runInit(args[1:], stdout, stderr)
	case "list", "list-services":
		return runList(args[1:], stdout, stderr)
	default:
		if strings.HasPrefix(args[0], "-") {
			return runStart(ctx, args, stdout, stderr)
		}
		fmt.Fprintf(stderr, "Unknown command: %s\n", args[0])
		printHelp(stderr)
		return 1
	}
}

func runStart(ctx context.Context, args []string, stdout io.Writer, stderr io.Writer) int {
	defaultPort := getenv("EMULATE_PORT", getenv("PORT", "4000"))
	fs := flag.NewFlagSet("start", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() {
		printStartHelp(stderr)
	}

	portValue := fs.String("port", defaultPort, "Base port")
	fs.StringVar(portValue, "p", defaultPort, "Base port")
	serviceValue := fs.String("service", "", "Comma-separated services to enable")
	fs.StringVar(serviceValue, "s", "", "Comma-separated services to enable")
	seedValue := fs.String("seed", "", "Path to seed config file")
	baseURLValue := fs.String("base-url", "", "Override advertised base URL")
	portlessValue := fs.Bool("portless", false, "Serve over HTTPS via portless")

	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 1
	}
	if hasUnexpectedArg(fs, stderr) {
		return 1
	}

	port, err := strconv.Atoi(*portValue)
	if err != nil || port < 1 || port > 65535 {
		fmt.Fprintf(stderr, "Invalid port: %s\n", *portValue)
		return 1
	}
	if *portlessValue && *baseURLValue != "" {
		fmt.Fprintln(stderr, "--portless and --base-url are mutually exclusive.")
		return 1
	}
	if *portlessValue {
		fmt.Fprintln(stderr, "The native Go runtime does not support --portless yet.")
		return 1
	}
	var seedServices []string
	var githubSeed *github.SeedConfig
	var resendSeed *resend.SeedConfig
	var vercelSeed *vercel.SeedConfig
	if *seedValue != "" {
		loaded, err := coreconfig.Load(coreconfig.LoadOptions{Path: *seedValue})
		if err != nil {
			fmt.Fprintf(stderr, "Failed to load seed config: %v\n", err)
			return 1
		}
		if unsupported := unsupportedNativeSeedServices(loaded.Data); len(unsupported) > 0 {
			fmt.Fprintf(stderr, "The native Go runtime only supports --seed for github, resend, and vercel. Unsupported seed config services: %s\n", strings.Join(unsupported, ", "))
			return 1
		}
		seedServices = coreconfig.InferServices(loaded.Data, nativeSeedServiceNames())
		if raw, ok := loaded.Data["github"]; ok {
			var cfg github.SeedConfig
			if err := json.Unmarshal(raw, &cfg); err != nil {
				fmt.Fprintf(stderr, "Failed to parse github seed config: %v\n", err)
				return 1
			}
			githubSeed = &cfg
		}
		if raw, ok := loaded.Data["tokens"]; ok {
			var tokens map[string]github.TokenSeed
			if err := json.Unmarshal(raw, &tokens); err != nil {
				fmt.Fprintf(stderr, "Failed to parse token seed config: %v\n", err)
				return 1
			}
			if githubSeed == nil {
				githubSeed = &github.SeedConfig{}
			}
			if githubSeed.Tokens == nil {
				githubSeed.Tokens = map[string]github.TokenSeed{}
			}
			for token, user := range tokens {
				githubSeed.Tokens[token] = user
			}
		}
		if raw, ok := loaded.Data["resend"]; ok {
			var cfg resend.SeedConfig
			if err := json.Unmarshal(raw, &cfg); err != nil {
				fmt.Fprintf(stderr, "Failed to parse resend seed config: %v\n", err)
				return 1
			}
			resendSeed = &cfg
		}
		if raw, ok := loaded.Data["vercel"]; ok {
			var cfg vercel.SeedConfig
			if err := json.Unmarshal(raw, &cfg); err != nil {
				fmt.Fprintf(stderr, "Failed to parse vercel seed config: %v\n", err)
				return 1
			}
			vercelSeed = &cfg
		}
	}
	services, err := parseServices(*serviceValue)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if *serviceValue == "" && len(seedServices) > 0 {
		services = seedServices
	}

	baseURL := *baseURLValue
	if baseURL == "" {
		baseURL = fmt.Sprintf("http://localhost:%d", port)
	}
	server := emuruntime.NewServer(emuruntime.ServerOptions{
		Version:    version,
		BaseURL:    baseURL,
		Services:   services,
		GitHubSeed: githubSeed,
		ResendSeed: resendSeed,
		VercelSeed: vercelSeed,
	})
	httpServer := &nethttp.Server{
		Handler:           server.Handler,
		ReadHeaderTimeout: 5 * time.Second,
	}
	listener, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		fmt.Fprintf(stderr, "Failed to listen on port %d: %v\n", port, err)
		return 1
	}

	fmt.Fprintf(stdout, "emulate %s native Go runtime is experimental.\n", version)
	fmt.Fprintf(stdout, "Listening on %s\n", baseURL)
	fmt.Fprintf(stdout, "Health check: %s%s\n", strings.TrimRight(baseURL, "/"), emuruntime.HealthPath)

	errCh := make(chan error, 1)
	go func() {
		errCh <- httpServer.Serve(listener)
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			fmt.Fprintf(stderr, "Failed to shut down server: %v\n", err)
			return 1
		}
		if err := <-errCh; err != nil && !errors.Is(err, nethttp.ErrServerClosed) {
			fmt.Fprintf(stderr, "Server stopped unexpectedly: %v\n", err)
			return 1
		}
		return 0
	case err := <-errCh:
		if err != nil && !errors.Is(err, nethttp.ErrServerClosed) {
			fmt.Fprintf(stderr, "Server stopped unexpectedly: %v\n", err)
			return 1
		}
		return 0
	}
}

func runInit(args []string, stdout io.Writer, stderr io.Writer) int {
	fs := flag.NewFlagSet("init", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() {
		printInitHelp(stderr)
	}

	serviceValue := fs.String("service", "all", "Service to generate config for")
	fs.StringVar(serviceValue, "s", "all", "Service to generate config for")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 1
	}
	if hasUnexpectedArg(fs, stderr) {
		return 1
	}

	config, err := emuruntime.StarterConfig(*serviceValue)
	if err != nil {
		fmt.Fprintf(stderr, "%s. Available: %s, all\n", err, strings.Join(emuruntime.ServiceNames(), ", "))
		return 1
	}

	filename, err := existingConfigFile()
	if err != nil {
		fmt.Fprintf(stderr, "Failed to check %s: %v\n", filename, err)
		return 1
	}
	if filename != "" {
		fmt.Fprintf(stderr, "Config file already exists: %s\n", filename)
		return 1
	}

	content, err := encodeYAML(config)
	if err != nil {
		fmt.Fprintf(stderr, "Failed to encode starter config: %v\n", err)
		return 1
	}
	const targetFilename = "emulate.config.yaml"
	if err := os.WriteFile(targetFilename, content, 0o644); err != nil {
		fmt.Fprintf(stderr, "Failed to write %s: %v\n", targetFilename, err)
		return 1
	}

	fmt.Fprintf(stdout, "Created %s\n", targetFilename)
	fmt.Fprintln(stdout, "\nRun 'npx emulate' to start the emulator.")
	return 0
}

func runList(args []string, stdout io.Writer, stderr io.Writer) int {
	fs := flag.NewFlagSet("list", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() {
		printListHelp(stderr)
	}
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 1
	}
	if hasUnexpectedArg(fs, stderr) {
		return 1
	}

	fmt.Fprintln(stdout)
	fmt.Fprintln(stdout, "Available services:")
	fmt.Fprintln(stdout)
	maxNameLength := 0
	for _, service := range emuruntime.Services {
		if len(service.Name) > maxNameLength {
			maxNameLength = len(service.Name)
		}
	}
	for _, service := range emuruntime.Services {
		fmt.Fprintf(stdout, "  %-*s  %s\n", maxNameLength, service.Name, service.Label)
		fmt.Fprintf(stdout, "  %-*s  Endpoints: %s\n\n", maxNameLength, "", service.Endpoints)
	}
	return 0
}

func printHelp(w io.Writer) {
	fmt.Fprintf(w, "emulate %s native Go runtime experimental\n\n", version)
	fmt.Fprintln(w, "Usage:")
	fmt.Fprintln(w, "  npx emulate [start] [options]")
	fmt.Fprintln(w, "  npx emulate init [--service <service>]")
	fmt.Fprintln(w, "  npx emulate list")
	fmt.Fprintln(w, "\nStart options:")
	fmt.Fprintln(w, "  -p, --port <port>          Base port")
	fmt.Fprintln(w, "  -s, --service <services>   Comma-separated services to enable")
	fmt.Fprintln(w, "      --seed <file>          Path to JSON seed config file (YAML not supported in native Go yet)")
	fmt.Fprintln(w, "      --base-url <url>       Override advertised base URL")
	fmt.Fprintln(w, "      --portless             Serve over HTTPS via portless (not supported in native Go yet)")
	fmt.Fprintln(w, "\nThe published TypeScript CLI remains the default user-facing runtime.")
	fmt.Fprintln(w, "Use npx emulate for current production behavior.")
}

func printStartHelp(w io.Writer) {
	fmt.Fprintln(w, "Usage:")
	fmt.Fprintln(w, "  npx emulate [start] [options]")
	fmt.Fprintln(w, "\nOptions:")
	fmt.Fprintln(w, "  -p, --port <port>          Base port")
	fmt.Fprintln(w, "  -s, --service <services>   Comma-separated services to enable")
	fmt.Fprintln(w, "      --seed <file>          Path to JSON seed config file (YAML not supported in native Go yet)")
	fmt.Fprintln(w, "      --base-url <url>       Override advertised base URL")
	fmt.Fprintln(w, "      --portless             Serve over HTTPS via portless (not supported in native Go yet)")
}

func printInitHelp(w io.Writer) {
	fmt.Fprintln(w, "Usage:")
	fmt.Fprintln(w, "  npx emulate init [--service <service>]")
	fmt.Fprintln(w, "\nOptions:")
	fmt.Fprintln(w, "  -s, --service <service>    Service to generate config for")
}

func printListHelp(w io.Writer) {
	fmt.Fprintln(w, "Usage:")
	fmt.Fprintln(w, "  npx emulate list")
}

func parseServices(value string) ([]string, error) {
	if value == "" {
		return emuruntime.ServiceNames(), nil
	}
	services := make([]string, 0)
	seen := map[string]bool{}
	for _, service := range strings.Split(value, ",") {
		name := strings.TrimSpace(service)
		if name == "" || seen[name] {
			continue
		}
		if _, ok := emuruntime.FindService(name); !ok {
			return nil, fmt.Errorf("Unknown service: %s", name)
		}
		services = append(services, name)
		seen[name] = true
	}
	if len(services) == 0 {
		return nil, fmt.Errorf("No services selected")
	}
	return services, nil
}

func nativeSeedServiceNames() []string {
	return []string{"github", "resend", "vercel"}
}

func unsupportedNativeSeedServices(data map[string]json.RawMessage) []string {
	supported := map[string]bool{}
	for _, service := range nativeSeedServiceNames() {
		supported[service] = true
	}

	unsupported := make([]string, 0)
	for _, service := range emuruntime.ServiceNames() {
		if supported[service] {
			continue
		}
		if _, ok := data[service]; ok {
			unsupported = append(unsupported, service)
		}
	}
	return unsupported
}

func getenv(name string, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func hasUnexpectedArg(fs *flag.FlagSet, stderr io.Writer) bool {
	if fs.NArg() == 0 {
		return false
	}
	fmt.Fprintf(stderr, "Unexpected argument: %s\n", fs.Arg(0))
	return true
}

func existingConfigFile() (string, error) {
	fullPath, err := coreconfig.Discover(".")
	if errors.Is(err, coreconfig.ErrNotFound) {
		return "", nil
	}
	if err != nil {
		return "config files", err
	}
	return filepath.Base(fullPath), nil
}

func encodeYAML(config map[string]any) ([]byte, error) {
	var b strings.Builder
	for _, key := range topLevelConfigKeys(config) {
		if err := writeYAMLField(&b, key, config[key], 0); err != nil {
			return nil, err
		}
	}
	return []byte(b.String()), nil
}

func topLevelConfigKeys(config map[string]any) []string {
	keys := make([]string, 0, len(config))
	seen := map[string]bool{}
	if _, ok := config["tokens"]; ok {
		keys = append(keys, "tokens")
		seen["tokens"] = true
	}
	for _, service := range emuruntime.Services {
		if _, ok := config[service.Name]; ok {
			keys = append(keys, service.Name)
			seen[service.Name] = true
		}
	}
	rest := make([]string, 0)
	for key := range config {
		if !seen[key] {
			rest = append(rest, key)
		}
	}
	sort.Strings(rest)
	return append(keys, rest...)
}

func writeYAMLField(b *strings.Builder, key string, value any, indent int) error {
	writeIndent(b, indent)
	b.WriteString(key)
	switch v := value.(type) {
	case map[string]any:
		if len(v) == 0 {
			b.WriteString(": {}\n")
			return nil
		}
		b.WriteString(":\n")
		return writeYAMLMap(b, v, indent+2)
	case []map[string]any:
		if len(v) == 0 {
			b.WriteString(": []\n")
			return nil
		}
		b.WriteString(":\n")
		return writeYAMLMapSlice(b, v, indent+2)
	case []string:
		if len(v) == 0 {
			b.WriteString(": []\n")
			return nil
		}
		b.WriteString(":\n")
		for _, item := range v {
			writeIndent(b, indent+2)
			b.WriteString("- ")
			writeYAMLScalar(b, item)
			b.WriteByte('\n')
		}
		return nil
	default:
		b.WriteString(": ")
		if err := writeYAMLScalar(b, v); err != nil {
			return err
		}
		b.WriteByte('\n')
		return nil
	}
}

func writeYAMLMap(b *strings.Builder, value map[string]any, indent int) error {
	for _, key := range sortedMapKeys(value) {
		if err := writeYAMLField(b, key, value[key], indent); err != nil {
			return err
		}
	}
	return nil
}

func writeYAMLMapSlice(b *strings.Builder, values []map[string]any, indent int) error {
	for _, value := range values {
		keys := sortedMapKeys(value)
		if len(keys) == 0 {
			writeIndent(b, indent)
			b.WriteString("- {}\n")
			continue
		}
		writeIndent(b, indent)
		b.WriteString("- ")
		firstKey := keys[0]
		b.WriteString(firstKey)
		switch firstValue := value[firstKey].(type) {
		case map[string]any:
			if len(firstValue) == 0 {
				b.WriteString(": {}\n")
			} else {
				b.WriteString(":\n")
				if err := writeYAMLMap(b, firstValue, indent+4); err != nil {
					return err
				}
			}
		case []map[string]any:
			if len(firstValue) == 0 {
				b.WriteString(": []\n")
			} else {
				b.WriteString(":\n")
				if err := writeYAMLMapSlice(b, firstValue, indent+4); err != nil {
					return err
				}
			}
		case []string:
			if len(firstValue) == 0 {
				b.WriteString(": []\n")
			} else {
				b.WriteString(":\n")
				for _, item := range firstValue {
					writeIndent(b, indent+4)
					b.WriteString("- ")
					writeYAMLScalar(b, item)
					b.WriteByte('\n')
				}
			}
		default:
			b.WriteString(": ")
			if err := writeYAMLScalar(b, firstValue); err != nil {
				return err
			}
			b.WriteByte('\n')
		}
		for _, key := range keys[1:] {
			if err := writeYAMLField(b, key, value[key], indent+2); err != nil {
				return err
			}
		}
	}
	return nil
}

func writeYAMLScalar(b *strings.Builder, value any) error {
	switch v := value.(type) {
	case string:
		b.WriteString(strconv.Quote(v))
	case bool:
		if v {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case int:
		b.WriteString(strconv.Itoa(v))
	default:
		return fmt.Errorf("unsupported YAML value %T", value)
	}
	return nil
}

func sortedMapKeys(value map[string]any) []string {
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func writeIndent(b *strings.Builder, indent int) {
	for range indent {
		b.WriteByte(' ')
	}
}
