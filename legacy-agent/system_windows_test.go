package main

import (
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestRunCommand(t *testing.T) {
	dir := t.TempDir()
	out, code, err := runCommand(t.Context(), dir, `echo "a b"& exit /b 3`, 30*time.Second)
	if err != nil || code != 3 || strings.TrimSpace(out) != `"a b"` {
		t.Fatalf("quoting or exit code: %q %d %v", out, code, err)
	}
	if ansiCodePage() == 936 {
		// cmd.exe prints in the console code page (GBK): it must come back as Chinese, not mojibake.
		if out, _, err := runCommand(t.Context(), dir, "echo 中文输出", 30*time.Second); err != nil || strings.TrimSpace(out) != "中文输出" {
			t.Fatalf("GBK output: %q %v", out, err)
		}
	}
	// No input: a command that waits for it ends at once instead of hanging.
	if _, _, err := runCommand(t.Context(), dir, "set /p x=", 10*time.Second); err != nil {
		t.Fatal(err)
	}
	// A timeout stops the whole tree (ping is a child of cmd.exe) without waiting for it.
	started := time.Now()
	out, code, err = runCommand(t.Context(), dir, "ping -n 30 127.0.0.1", time.Second)
	if err != nil || code != -1 || !strings.Contains(out, "已停止") || time.Since(started) > 10*time.Second {
		t.Fatalf("timeout: code %d, %v, took %v", code, err, time.Since(started))
	}
}

func TestOutputDecodingAndHeadTail(t *testing.T) {
	if got := decodeOutput([]byte{0xff, 0xfe, 'o', 0, 'k', 0, '\r', 0, '\n', 0}); got != "ok\r\n" {
		t.Fatalf("UTF-16 output: %q", got)
	}
	var h headTail
	for i := 0; i < 5000; i++ {
		io.WriteString(&h, "0123456789")
	}
	if h.dropped != 50000-2*outputKeep || len(h.head) != outputKeep || len(h.tail) != outputKeep {
		t.Fatalf("head %d tail %d dropped %d", len(h.head), len(h.tail), h.dropped)
	}
	if d := osDescription(); !strings.Contains(d, "Windows") {
		t.Fatalf("OS description: %q", d)
	}
}

// GBK files (the ANSI code page of Chinese Windows) are read as text and edited without changing encoding.
func TestGBKFiles(t *testing.T) {
	if ansiCodePage() != 936 {
		t.Skip("needs a Chinese (GBK) Windows")
	}
	dir := t.TempDir()
	original, err := encodeANSI("状态：旧\r\n结束\r\n")
	if err != nil || utf8.Valid(original) {
		t.Fatalf("GBK sample: %v", err)
	}
	name := filepath.Join(dir, "gbk.ini")
	os.WriteFile(name, original, 0600)
	w, err := openWorkspace(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer w.root.Close()
	if got, err := w.read("gbk.ini", false); err != nil || got != "状态：旧\r\n结束\r\n" {
		t.Fatalf("read GBK: %q %v", got, err)
	}
	if _, err := w.propose("gbk.ini", "旧", "😀"); err == nil {
		t.Fatal("accepted a character GBK cannot hold")
	}
	p, err := w.propose("gbk.ini", "旧", "新")
	if err != nil {
		t.Fatal(err)
	}
	if err := w.apply(p); err != nil {
		t.Fatal(err)
	}
	want, _ := encodeANSI("状态：新\r\n结束\r\n")
	if got, _ := os.ReadFile(name); string(got) != string(want) {
		t.Fatalf("edited file is not GBK any more: %q", got)
	}
}

func TestWriteFileTool(t *testing.T) {
	dir := t.TempDir()
	w, err := openWorkspace(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer w.root.Close()
	s := session{ws: w, out: io.Discard, confirm: func(string) string { return "y" }}
	input, _ := json.Marshal(map[string]string{"path": "out.bat", "content": "@echo off\necho 完成\n"})
	call := block{ID: "t1", Name: "write_file", Input: input}
	if got := s.callTool(t.Context(), call); got.Failed {
		t.Fatal(got.Result)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "out.bat")); string(got) != "@echo off\r\necho 完成\r\n" {
		t.Fatalf("content or CRLF: %q", got)
	}
	if got := s.callTool(t.Context(), call); !got.Failed || !strings.Contains(got.Result, "已存在") {
		t.Fatal("overwrote an existing file")
	}
	for _, bad := range []string{"../escape.txt", "missing-dir/x.txt", ".hidden"} {
		input, _ := json.Marshal(map[string]string{"path": bad, "content": "x"})
		if got := s.callTool(t.Context(), block{ID: "t2", Name: "write_file", Input: input}); !got.Failed {
			t.Errorf("created %q", bad)
		}
	}
}

// The embedded roots are Let's Encrypt's ISRG Root X1 and X2, as published.
func TestEmbeddedRoots(t *testing.T) {
	want := map[string]string{
		"ISRG Root X1": "96bcec06264976f37460779acf28c5a7cfe8a3c0aae11a8ffcee05c0bddf08c6",
		"ISRG Root X2": "69729b8e15a86efc177a57afb7171dfc64add28c2fca8cf1507e34453ccb1470",
	}
	rest := extraRoots
	for {
		var b *pem.Block
		if b, rest = pem.Decode(rest); b == nil {
			break
		}
		c, err := x509.ParseCertificate(b.Bytes)
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(b.Bytes)
		if want[c.Subject.CommonName] != hex.EncodeToString(sum[:]) {
			t.Fatalf("unexpected root %q", c.Subject.CommonName)
		}
		delete(want, c.Subject.CommonName)
	}
	if len(want) != 0 {
		t.Fatalf("missing roots: %v", want)
	}
}
