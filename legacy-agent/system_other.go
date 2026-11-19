//go:build !windows

package main

import (
	"bytes"
	"context"
	"errors"
	"runtime"
	"time"
)

func decodeANSI(b []byte) string { return string(bytes.ToValidUTF8(b, []byte("\uFFFD"))) }

func encodeANSI(s string) ([]byte, error) { return []byte(s), nil }

func ansiCodePage() int { return 65001 }

func runCommand(context.Context, string, string, time.Duration) (string, int, error) {
	return "", 0, errors.New("只支持 Windows")
}

func osDescription() string { return runtime.GOOS }
