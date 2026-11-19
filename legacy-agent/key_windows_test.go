package main

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestKeyPersistenceAndReplacement(t *testing.T) {
	t.Setenv(keyEnv, "")
	var checks atomic.Int32
	const accepted = "sk-demo-not-a-real-api-key-Q7h"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		checks.Add(1)
		if r.Method != "GET" || r.URL.Path != "/v1/models" {
			t.Error("Key verification used the wrong endpoint")
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+accepted {
			w.WriteHeader(401)
			return
		}
		fmt.Fprint(w, `{"data":[]}`)
	}))
	defer server.Close()
	path := filepath.Join(t.TempDir(), keyFile)
	var out bytes.Buffer
	first := func() (string, error) { return accepted, nil }
	if _, err := acquireGateway(t.Context(), server.URL, false, false, path, &out, first); err != nil {
		t.Fatal(err)
	}
	blob, err := os.ReadFile(path)
	if err != nil || len(blob) == 0 || bytes.Contains(blob, []byte(accepted)) {
		t.Fatal("Key was not saved as a nonempty encrypted file")
	}
	if strings.Contains(out.String(), "sk-") || strings.Contains(out.String(), "Q7h") || !strings.Contains(out.String(), "****") || !strings.Contains(out.String(), "验证通过") {
		t.Fatal("redirected output should contain no Key characters and should report validation")
	}
	if got := keyPreview(accepted, true); !strings.HasPrefix(got, "sk-…Q7h") || strings.Contains(got, accepted) {
		t.Fatal("console Key preview is not redacted correctly")
	}
	if _, err := loadKey(path, "https://another-gateway.invalid"); err == nil {
		t.Fatal("a saved Key could be reused at a different gateway")
	}
	out.Reset()
	noPrompt := func() (string, error) { t.Fatal("unexpected prompt after Key was saved"); return "", nil }
	gw, err := acquireGateway(t.Context(), server.URL, false, false, path, &out, noPrompt)
	if err != nil || gw.key != accepted || !strings.Contains(out.String(), "已保存") || checks.Load() != 1 {
		t.Fatal("second startup did not reuse the saved Key without validating it again")
	}
	invalid := func() (string, error) { return "sk-demo-invalid-\x1b-char", nil }
	if _, err := acquireGateway(t.Context(), server.URL, true, true, path, &out, invalid); err == nil || !strings.Contains(err.Error(), "第 17 个字符无效") || checks.Load() != 1 {
		t.Fatalf("invalid header character not caught locally: %v", err)
	}
	rejected := func() (string, error) { return "sk-demo-rejected-by-mock-gateway", nil }
	if _, err := acquireGateway(t.Context(), server.URL, true, true, path, &out, rejected); err == nil || !strings.Contains(err.Error(), "HTTP 401") {
		t.Fatalf("unexpected validation result: %v", err)
	}
	if unchanged, _ := os.ReadFile(path); !bytes.Equal(unchanged, blob) {
		t.Fatal("rejected Key overwrote the existing saved Key")
	}
	if _, err := acquireGateway(t.Context(), server.URL, true, true, path, &out, first); err != nil {
		t.Fatalf("could not replace an existing encrypted Key: %v", err)
	}
}
