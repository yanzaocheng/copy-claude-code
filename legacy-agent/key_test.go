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
	"sync/atomic"
	"testing"
)

const acceptedKey = "sk-demo-not-a-real-api-key-Q7h"

func keyServer(t *testing.T, checks *atomic.Int32) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		checks.Add(1)
		if r.Method != "GET" || r.URL.Path != "/v1/models" {
			t.Error("Key verification used the wrong endpoint")
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+acceptedKey {
			w.WriteHeader(401)
			return
		}
		fmt.Fprint(w, `{"data":[]}`)
	}))
	t.Cleanup(server.Close)
	return server
}

func TestConfigCreatedAndKeySaved(t *testing.T) {
	t.Setenv(keyEnv, "")
	var checks atomic.Int32
	server := keyServer(t, &checks)
	path := filepath.Join(t.TempDir(), configFile)

	var out bytes.Buffer
	cfg, err := loadConfig(path, &out)
	if err != nil || !strings.Contains(out.String(), "已生成配置文件："+path) {
		t.Fatalf("config not created: %v\n%s", err, &out)
	}
	if data, _ := os.ReadFile(path); !bytes.Contains(data, []byte("\r\n")) || !bytes.Contains(data, []byte(`"gateway": "https://7bit.fun"`)) {
		t.Fatalf("new config lacks CRLF or defaults:\n%s", data)
	}

	// Mistakes do not end the program: it asks again until a Key is accepted, then saves it.
	out.Reset()
	gw, err := acquireGateway(t.Context(), cfg, server.URL, false, false, &out, typed("sk-中文输入法", "", "sk-demo-rejected-by-mock-gateway", acceptedKey))
	if err != nil || gw.key != acceptedKey {
		t.Fatalf("retry did not end with the accepted Key: %v", err)
	}
	if strings.Count(out.String(), "请重新粘贴") != 2 || !strings.Contains(out.String(), "第 4 个字符无效") || !strings.Contains(out.String(), "HTTP 401") || !strings.Contains(out.String(), "API Key 已保存到配置文件："+path) {
		t.Fatalf("unexpected retry output:\n%s", &out)
	}
	var saved appConfig
	data, _ := os.ReadFile(path)
	if err := json.Unmarshal(data, &saved); err != nil || saved.APIKey != acceptedKey || saved.Model != defaultModel {
		t.Fatalf("Key not saved to the config file:\n%s", data)
	}

	// Next start: read from the config file (as Notepad would save it, with a BOM), no prompt.
	if err := os.WriteFile(path, append(append([]byte(nil), utf8BOM...), data...), 0600); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	cfg, err = loadConfig(path, &out)
	if err != nil || !strings.Contains(out.String(), "配置文件："+path) {
		t.Fatalf("config not reloaded: %v", err)
	}
	noPrompt := func() (string, error) { t.Fatal("unexpected prompt after Key was saved"); return "", nil }
	if gw, err = acquireGateway(t.Context(), cfg, server.URL, false, false, &out, noPrompt); err != nil || gw.key != acceptedKey {
		t.Fatalf("saved Key not reused: %v", err)
	}
}

func TestWrongKeyInConfigAsksAgain(t *testing.T) {
	t.Setenv(keyEnv, "")
	var checks atomic.Int32
	server := keyServer(t, &checks)
	cfg := &appConfig{Gateway: defaultGateway, Model: defaultModel, APIKey: "sk-edited-by-hand-wrong", path: filepath.Join(t.TempDir(), configFile)}
	var out bytes.Buffer
	gw, err := acquireGateway(t.Context(), cfg, server.URL, false, false, &out, typed(acceptedKey))
	if err != nil || gw.key != acceptedKey || cfg.APIKey != acceptedKey || !strings.Contains(out.String(), "配置文件里的 API Key 不能用") {
		t.Fatalf("wrong saved Key not replaced: %v\n%s", err, &out)
	}
}

func TestKeyInputEndsWithLastError(t *testing.T) {
	t.Setenv(keyEnv, "")
	var checks atomic.Int32
	server := keyServer(t, &checks)
	cfg := &appConfig{path: filepath.Join(t.TempDir(), configFile)}
	_, err := acquireGateway(t.Context(), cfg, server.URL, true, true, io.Discard, typed("sk-demo-invalid-\x1b-char"))
	if err == nil || !strings.Contains(err.Error(), "第 17 个字符无效") || checks.Load() != 0 {
		t.Fatalf("invalid header character not caught locally: %v", err)
	}
	if _, err := os.Stat(cfg.path); !os.IsNotExist(err) {
		t.Fatal("a rejected Key was saved")
	}
}

// typed answers the Key prompt with the given lines, then with the end of input.
func typed(lines ...string) func() (string, error) {
	return func() (string, error) {
		if len(lines) == 0 {
			return "", io.EOF
		}
		line := lines[0]
		lines = lines[1:]
		return line, nil
	}
}
