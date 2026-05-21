package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	nethttp "net/http"
	"os/exec"
	"strconv"
	"strings"
	"time"

	emuruntime "github.com/vercel-labs/emulate/internal/runtime"
)

type portlessAlias struct {
	Name string
	Port int
}

type runningPortlessServer struct {
	Service  string
	BaseURL  string
	Port     int
	Server   *nethttp.Server
	Listener net.Listener
}

var runPortlessCommand = func(args []string, stdout io.Writer, stderr io.Writer) error {
	cmd := exec.Command("portless", args...)
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	return cmd.Run()
}

func runPortlessStart(ctx context.Context, stdout io.Writer, stderr io.Writer, basePort int, services []string, seeds nativeSeedOptions) int {
	if err := ensurePortless(); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}

	running := make([]runningPortlessServer, 0, len(services))
	for index, service := range services {
		port := basePort + index
		baseURL := portlessBaseURL(service)
		if seedBaseURL := seedBaseURLForService(service, seeds.BaseURLs); seedBaseURL != "" {
			baseURL = seedBaseURL
		}
		server := emuruntime.NewServer(serverOptions(baseURL, []string{service}, seeds))
		httpServer := &nethttp.Server{
			Handler:           server.Handler,
			ReadHeaderTimeout: 5 * time.Second,
		}
		listener, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
		if err != nil {
			closePortlessListeners(running)
			fmt.Fprintf(stderr, "Failed to listen on port %d for %s: %v\n", port, service, err)
			return 1
		}
		running = append(running, runningPortlessServer{
			Service:  service,
			BaseURL:  baseURL,
			Port:     port,
			Server:   httpServer,
			Listener: listener,
		})
	}

	aliases := make([]portlessAlias, 0, len(running))
	for _, server := range running {
		aliases = append(aliases, portlessAlias{Name: server.Service + ".emulate", Port: server.Port})
	}
	if err := registerPortlessAliases(aliases, stdout, stderr); err != nil {
		closePortlessListeners(running)
		fmt.Fprintln(stderr, err)
		return 1
	}

	fmt.Fprintf(stdout, "emulate %s native Go runtime.\n", version)
	fmt.Fprintln(stdout, "Listening with portless:")
	for _, server := range running {
		fmt.Fprintf(stdout, "  %s  %s\n", server.Service, server.BaseURL)
	}
	fmt.Fprintf(stdout, "Health check: %s%s\n", strings.TrimRight(running[0].BaseURL, "/"), emuruntime.HealthPath)

	errCh := make(chan error, len(running))
	for _, server := range running {
		server := server
		go func() {
			errCh <- server.Server.Serve(server.Listener)
		}()
	}

	var exitCode int
	select {
	case <-ctx.Done():
		exitCode = shutdownPortlessServers(running, stderr)
	case err := <-errCh:
		if err != nil && !errors.Is(err, nethttp.ErrServerClosed) {
			fmt.Fprintf(stderr, "Server stopped unexpectedly: %v\n", err)
			exitCode = 1
		}
		if shutdownCode := shutdownPortlessServers(running, stderr); exitCode == 0 {
			exitCode = shutdownCode
		}
	}
	removePortlessAliases(aliases, stderr)
	return exitCode
}

func ensurePortless() error {
	if err := runPortlessCommand([]string{"--version"}, nil, nil); err != nil {
		return fmt.Errorf("portless is required but not installed. Run: npm i -g portless")
	}
	if err := runPortlessCommand([]string{"list"}, nil, nil); err != nil {
		return fmt.Errorf("portless proxy is not running. Start it with: portless proxy start")
	}
	return nil
}

func registerPortlessAliases(aliases []portlessAlias, stdout io.Writer, stderr io.Writer) error {
	registered := []portlessAlias{}
	for _, alias := range aliases {
		err := runPortlessCommand([]string{"alias", alias.Name, strconv.Itoa(alias.Port), "--force"}, stdout, stderr)
		if err != nil {
			removePortlessAliases(registered, stderr)
			return fmt.Errorf("failed to register portless alias: %s -> %d", alias.Name, alias.Port)
		}
		registered = append(registered, alias)
	}
	return nil
}

func removePortlessAliases(aliases []portlessAlias, stderr io.Writer) {
	for _, alias := range aliases {
		if err := runPortlessCommand([]string{"alias", "--remove", alias.Name}, nil, nil); err != nil {
			fmt.Fprintf(stderr, "Warning: failed to remove portless alias: %s\n", alias.Name)
		}
	}
}

func portlessBaseURL(service string) string {
	return "https://" + service + ".emulate.localhost"
}

func closePortlessListeners(servers []runningPortlessServer) {
	for _, server := range servers {
		_ = server.Listener.Close()
	}
}

func shutdownPortlessServers(servers []runningPortlessServer, stderr io.Writer) int {
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	exitCode := 0
	for _, server := range servers {
		if err := server.Server.Shutdown(shutdownCtx); err != nil {
			fmt.Fprintf(stderr, "Failed to shut down %s server: %v\n", server.Service, err)
			exitCode = 1
		}
	}
	return exitCode
}
