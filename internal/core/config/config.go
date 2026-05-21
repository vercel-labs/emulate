package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type Format string

const (
	FormatJSON Format = "json"
	FormatYAML Format = "yaml"
)

var DefaultFilenames = []string{
	"emulate.config.yaml",
	"emulate.config.yml",
	"emulate.config.json",
	"service-emulator.config.yaml",
	"service-emulator.config.yml",
	"service-emulator.config.json",
}

var ErrNotFound = errors.New("config file not found")

type UnsupportedFormatError struct {
	Path   string
	Format Format
}

func (e *UnsupportedFormatError) Error() string {
	return fmt.Sprintf("unsupported config format for %s", e.Path)
}

type LoadOptions struct {
	Path string
	Dir  string
}

type LoadResult struct {
	Path     string
	Filename string
	Format   Format
	Data     map[string]json.RawMessage
}

func Load(options LoadOptions) (*LoadResult, error) {
	dir := options.Dir
	if dir == "" {
		dir = "."
	}

	if options.Path != "" {
		fullPath := options.Path
		if !filepath.IsAbs(fullPath) {
			fullPath = filepath.Join(dir, fullPath)
		}
		return loadFile(fullPath, options.Path)
	}

	fullPath, err := Discover(dir)
	if err != nil {
		return nil, err
	}
	return loadFile(fullPath, filepath.Base(fullPath))
}

func Discover(dir string) (string, error) {
	if dir == "" {
		dir = "."
	}
	for _, filename := range DefaultFilenames {
		fullPath := filepath.Join(dir, filename)
		if _, err := os.Stat(fullPath); err == nil {
			return fullPath, nil
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", fmt.Errorf("check %s: %w", filename, err)
		}
	}
	return "", ErrNotFound
}

func InferServices(data map[string]json.RawMessage, serviceNames []string) []string {
	services := make([]string, 0)
	for _, name := range serviceNames {
		if _, ok := data[name]; ok {
			services = append(services, name)
		}
	}
	return services
}

func IsUnsupportedFormat(err error) bool {
	var unsupported *UnsupportedFormatError
	return errors.As(err, &unsupported)
}

func loadFile(fullPath string, sourceName string) (*LoadResult, error) {
	format, err := FormatForPath(fullPath)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(fullPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("%w: %s", ErrNotFound, sourceName)
		}
		return nil, err
	}

	data := map[string]json.RawMessage{}
	switch format {
	case FormatJSON:
		if err := json.Unmarshal(raw, &data); err != nil {
			return nil, fmt.Errorf("parse %s: %w", sourceName, err)
		}
	case FormatYAML:
		parsed, err := parseYAMLDocument(raw)
		if err != nil {
			return nil, fmt.Errorf("parse %s: %w", sourceName, err)
		}
		data = parsed
	default:
		return nil, &UnsupportedFormatError{Path: sourceName, Format: format}
	}
	return &LoadResult{
		Path:     fullPath,
		Filename: sourceName,
		Format:   format,
		Data:     data,
	}, nil
}

func FormatForPath(filename string) (Format, error) {
	switch strings.ToLower(filepath.Ext(filename)) {
	case ".json":
		return FormatJSON, nil
	case ".yaml", ".yml":
		return FormatYAML, nil
	default:
		return "", fmt.Errorf("unsupported config extension: %s", filepath.Ext(filename))
	}
}

func SortedKeys(data map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(data))
	for key := range data {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
