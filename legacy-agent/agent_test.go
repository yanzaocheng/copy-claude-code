package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunDirectKeyAndToolLoop(t *testing.T) {
	const key = "mock-key-only"
	t.Setenv(keyEnv, key)
	dir := t.TempDir()
	file := filepath.Join(dir, "运行日志.txt")
	if err := os.WriteFile(file, []byte("状态：正常\r\n"), 0600); err != nil {
		t.Fatal(err)
	}
	calls := 0
	var sessionID string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+key || r.Header.Get("Anthropic-Version") != "2023-06-01" {
			t.Error("missing gateway protocol headers")
		}
		if r.Method == "GET" && r.URL.Path == "/v1/models" {
			fmt.Fprint(w, `{"data":[{"id":"mock-model"}]}`)
			return
		}
		if r.Method != "POST" || r.URL.Path != "/v1/messages" {
			t.Errorf("unexpected route %s %s (must not log in)", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		var payload struct {
			Model    string     `json:"model"`
			Messages []message  `json:"messages"`
			Tools    []toolSpec `json:"tools"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("request: %v", err)
			w.WriteHeader(400)
			return
		}
		if payload.Model != "mock-model" || len(payload.Tools) != 5 {
			t.Errorf("configured model and the 5 tools were not sent (%d tools)", len(payload.Tools))
		}
		id := r.Header.Get("X-Claude-Code-Session-Id")
		if id == "" || (sessionID != "" && id != sessionID) {
			t.Error("missing or changed session ID")
		}
		sessionID = id
		calls++
		switch calls {
		case 1:
			fmt.Fprint(w, `{"stop_reason":"tool_use","content":[{"type":"thinking","thinking":"hidden","signature":"sig"},{"type":"tool_use","id":"toolu_1","name":"read_text","input":{"path":"运行日志.txt","tail":true}}]}`)
		case 2:
			if len(payload.Messages) != 3 {
				t.Errorf("got %d messages, want 3", len(payload.Messages))
			} else {
				b := payload.Messages[2].Content[0]
				if b.CallID != "toolu_1" || b.Failed || b.Result != "状态：正常\r\n" {
					t.Errorf("unexpected tool result: %+v", b)
				}
				if !bytes.Contains(payload.Messages[1].Content[0].raw, []byte(`"signature":"sig"`)) {
					t.Error("provider signature lost from assistant blocks")
				}
			}
			fmt.Fprint(w, `{"stop_reason":"end_turn","content":[{"type":"text","text":"日志状态正常。"}]}`)
		default:
			t.Error("unexpected extra model request")
			w.WriteHeader(400)
		}
	}))
	defer server.Close()
	conf := filepath.Join(t.TempDir(), configFile)
	var out bytes.Buffer
	if err := run(t.Context(), []string{"-config", conf, "-gateway", server.URL, "-check"}, os.Stdin, &out, io.Discard); err != nil || !strings.Contains(out.String(), "1 个模型") {
		t.Fatalf("check: %v; %s", err, &out)
	}
	out.Reset()
	args := []string{"-config", conf, "-gateway", server.URL + "/v1/messages", "-dir", dir, "-model", "mock-model", "-p", "看日志"}
	if err := run(t.Context(), args, os.Stdin, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "日志状态正常。") || strings.Contains(out.String(), key) {
		t.Fatalf("unexpected output: %s", &out)
	}
}

func TestWorkspacePathAndConfirmedEdits(t *testing.T) {
	dir := t.TempDir()
	name := filepath.Join(dir, "demo.txt")
	data := append([]byte(nil), utf8BOM...)
	data = append(data, "状态：旧\r\n状态：新\r\n"...)
	if err := os.WriteFile(name, data, 0600); err != nil {
		t.Fatal(err)
	}
	w, err := openWorkspace(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer w.root.Close()
	for _, path := range []string{"../demo.txt", `C:\demo.txt`, "demo.txt:other", ".env", "gateway.json", "demo.txt."} {
		if _, err := w.read(path, false); err == nil {
			t.Errorf("accepted unsafe path %q", path)
		}
	}
	if _, err := w.propose("demo.txt", "状态", "进度"); err == nil {
		t.Error("accepted non-unique edit")
	}
	call := block{ID: "tool_1", Name: "replace_text", Input: json.RawMessage(`{"path":"demo.txt","old_text":"状态：旧\r\n","new_text":"状态：已更新\r\n"}`)}
	s := session{ws: w, out: io.Discard, confirm: func(string) string { return "n" }}
	if got := s.callTool(t.Context(), call); !got.Failed {
		t.Fatal("edit ran without approval")
	}
	if got, _ := os.ReadFile(name); !bytes.Equal(got, data) {
		t.Fatalf("file changed without approval: %q", got)
	}
	s.confirm = func(preview string) string {
		if strings.Contains(preview, "状态：已更新") {
			return "y"
		}
		return ""
	}
	s.readOnly = true
	if got := s.callTool(t.Context(), call); !got.Failed {
		t.Fatal("edit ran in read-only mode")
	}
	s.readOnly = false
	if got := s.callTool(t.Context(), call); got.Failed {
		t.Fatalf("confirmed edit: %s", got.Result)
	}
	if got, _ := os.ReadFile(name); string(got) != "\ufeff状态：已更新\r\n状态：新\r\n" {
		t.Fatalf("edited file has unexpected content or encoding: %q", got)
	}
	stale, err := w.propose("demo.txt", "已更新", "再次更新")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, []byte("其他进程已修改"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := w.apply(stale); err == nil {
		t.Fatal("overwrote a concurrent change")
	}
}

// A command the model asks for is not run on typed-ahead or redirected input: only a person at the console
// confirms.
func TestCommandNeedsConsoleConfirmation(t *testing.T) {
	t.Setenv(keyEnv, "mock-key-only")
	dir := t.TempDir()
	var result block
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/models" {
			fmt.Fprint(w, `{"data":[]}`)
			return
		}
		var payload struct {
			Messages []message `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&payload)
		if calls++; calls == 1 {
			fmt.Fprint(w, `{"stop_reason":"tool_use","content":[{"type":"tool_use","id":"toolu_1","name":"run_command","input":{"command":"echo x> marker.txt"}}]}`)
			return
		}
		result = payload.Messages[len(payload.Messages)-1].Content[0]
		fmt.Fprint(w, `{"stop_reason":"end_turn","content":[{"type":"text","text":"ok"}]}`)
	}))
	defer server.Close()
	in, err := os.CreateTemp(t.TempDir(), "stdin-*")
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	in.WriteString("y\na\n")
	in.Seek(0, io.SeekStart)
	args := []string{"-config", filepath.Join(t.TempDir(), configFile), "-gateway", server.URL, "-dir", dir, "-p", "建个文件"}
	if err := run(t.Context(), args, in, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "marker.txt")); !os.IsNotExist(err) {
		t.Fatal("the command ran without a confirmation at the console")
	}
	if !result.Failed || !strings.Contains(result.Result, "未确认") {
		t.Fatalf("the model was not told the command was refused: %+v", result)
	}
}

func TestReadTailAndUTF16(t *testing.T) {
	dir := t.TempDir()
	name := filepath.Join(dir, "tail.log")
	if err := os.WriteFile(name, []byte(strings.Repeat("开头\n", readBytes)+"最后一行\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "utf16.log"), []byte{0xff, 0xfe, 0x2d, 0x4e, 0x0d, 0, 0x0a, 0}, 0600); err != nil {
		t.Fatal(err)
	}
	w, err := openWorkspace(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer w.root.Close()
	if got, err := w.read("tail.log", true); err != nil || !strings.HasSuffix(got, "最后一行\n") || len(got) > readBytes+64 {
		t.Fatalf("tail length=%d error=%v", len(got), err)
	}
	if got, err := w.read("utf16.log", false); err != nil || got != "中\r\n" {
		t.Fatalf("UTF-16: %q error=%v", got, err)
	}
}

func TestGatewayRefusesCleartextAndRedirects(t *testing.T) {
	for _, url := range []string{"http://example.org", "https://user:secret@example.org", "https://example.org?foo=bar"} {
		if _, err := normalizeGateway(url); err == nil {
			t.Errorf("accepted unsafe URL %q", url)
		}
	}
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("followed a redirect")
	}))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	if _, err := newGateway(redirect.URL, "secret").check(context.Background()); err == nil || !strings.Contains(err.Error(), "307") {
		t.Fatalf("unexpected result: %v", err)
	}
}
