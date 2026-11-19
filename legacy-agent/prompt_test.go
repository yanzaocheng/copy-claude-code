package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"
)

func TestPromptFileEncodingsAndComments(t *testing.T) {
	path := filepath.Join(t.TempDir(), promptFile)
	if created, err := ensurePromptFile(path); err != nil || !created {
		t.Fatalf("template not created: %v", err)
	}
	if created, err := ensurePromptFile(path); err != nil || created {
		t.Fatalf("an existing prompt file must be kept: %v", err)
	}
	if extra, err := readExtraPrompt(path); err != nil || extra != "" {
		t.Fatalf("the template is only comments, got %q (%v)", extra, err)
	}

	// Notepad "Unicode": UTF-16 LE with a BOM.
	units := utf16.Encode([]rune("第一行\r\n  # 注释\r\n第二行  \r\n"))
	data := []byte{0xff, 0xfe}
	for _, u := range units {
		data = append(data, byte(u), byte(u>>8))
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if extra, err := readExtraPrompt(path); err != nil || extra != "第一行\n第二行" {
		t.Fatalf("UTF-16 prompt: %q (%v)", extra, err)
	}

	// Notepad "ANSI": GBK on a Chinese Windows.
	if ansiCodePage() == 936 {
		gbk, err := encodeANSI("只用中文回答\r\n")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, gbk, 0o600); err != nil {
			t.Fatal(err)
		}
		if extra, err := readExtraPrompt(path); err != nil || extra != "只用中文回答" {
			t.Fatalf("GBK prompt: %q (%v)", extra, err)
		}
	}

	if extra, err := readExtraPrompt(filepath.Join(t.TempDir(), "missing.txt")); err != nil || extra != "" {
		t.Fatalf("a missing prompt file is no instructions: %q (%v)", extra, err)
	}
}

// The prompt file is created next to the config file, and what is written in it reaches the model on the
// next request, without a restart.
func TestPromptFileReachesTheModel(t *testing.T) {
	t.Setenv(keyEnv, "mock-key-only")
	var system string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/models" {
			fmt.Fprint(w, `{"data":[{"id":"m"}]}`)
			return
		}
		var payload struct {
			System string `json:"system"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		system = payload.System
		fmt.Fprint(w, `{"stop_reason":"end_turn","content":[{"type":"text","text":"好"}]}`)
	}))
	defer server.Close()
	confDir := t.TempDir()
	conf := filepath.Join(confDir, configFile)
	args := []string{"-config", conf, "-gateway", server.URL, "-dir", t.TempDir(), "-model", "m", "-p", "你好"}

	var out bytes.Buffer
	if err := run(t.Context(), args, os.Stdin, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(confDir, promptFile)
	if !strings.Contains(out.String(), "已生成提示词文件："+path) {
		t.Fatalf("the prompt file location was not shown:\n%s", &out)
	}
	if strings.Contains(system, "Instructions from the user") || !strings.Contains(system, "runs right away, without asking") {
		t.Fatalf("unexpected system prompt for an empty prompt file:\n%s", system)
	}

	if err := os.WriteFile(path, []byte("# 注释不发送\r\n回答前先说 OK\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if err := run(t.Context(), args, os.Stdin, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(system, "take precedence over the defaults above):\n回答前先说 OK") || strings.Contains(system, "注释不发送") {
		t.Fatalf("the prompt file did not reach the model:\n%s", system)
	}
	if !strings.Contains(out.String(), "（已生效，8 字）") {
		t.Fatalf("the prompt file status was not shown:\n%s", &out)
	}
}
