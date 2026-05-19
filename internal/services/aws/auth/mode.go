package auth

import (
	"fmt"
	"strings"
)

type Mode string

const (
	ModeRelaxed   Mode = "relaxed"
	ModeKnownKeys Mode = "known-keys"
	ModeStrict    Mode = "strict"
)

func ParseMode(value string) (Mode, error) {
	mode := Mode(strings.TrimSpace(strings.ToLower(value)))
	if mode == "" {
		return ModeRelaxed, nil
	}
	if mode.Valid() {
		return mode, nil
	}
	return "", fmt.Errorf("unknown AWS auth mode %q", value)
}

func NormalizeMode(mode Mode) Mode {
	if mode == "" {
		return ModeRelaxed
	}
	if mode.Valid() {
		return mode
	}
	return ModeRelaxed
}

func (mode Mode) Valid() bool {
	switch mode {
	case ModeRelaxed, ModeKnownKeys, ModeStrict:
		return true
	default:
		return false
	}
}

func (mode Mode) String() string {
	return string(mode)
}
