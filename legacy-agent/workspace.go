package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

const (
	readBytes = 24 << 10
	editBytes = 1 << 20
)

var utf8BOM = []byte{0xef, 0xbb, 0xbf}

type workspace struct {
	dir  string
	root *os.Root
}

func openWorkspace(dir string) (*workspace, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	abs, err = nativeWorkspace(abs)
	if err != nil {
		return nil, fmt.Errorf("无法定位本地工作目录：%w", err)
	}
	if filepath.Dir(abs) == abs {
		return nil, errors.New("请指定工作子目录，不要把整个磁盘作为工作目录")
	}
	r, err := os.OpenRoot(abs)
	if err != nil {
		return nil, fmt.Errorf("无法打开工作目录：%w", err)
	}
	return &workspace{dir: abs, root: r}, nil
}

func allowedName(name string) bool {
	lower := strings.ToLower(name)
	if !filepath.IsLocal(name) || strings.HasPrefix(name, ".") || strings.TrimRight(name, " .") != name || strings.ContainsAny(name, `:/\<>|"*?`) {
		return false
	}
	if strings.ContainsFunc(name, func(r rune) bool { return r < 32 || r == 127 }) {
		return false
	}
	switch lower {
	case "gateway.json", "credentials.json", "secrets.json", "id_rsa", "id_ed25519":
		return false
	}
	switch filepath.Ext(lower) {
	case ".key", ".pem", ".pfx", ".p12", ".kdbx":
		return false
	}
	return true
}

func (w *workspace) path(raw string, forDir bool) (string, error) {
	if forDir && (raw == "" || raw == ".") {
		return ".", nil
	}
	parts := strings.Split(strings.ReplaceAll(raw, `\`, "/"), "/")
	if len(raw) > 1024 {
		return "", errors.New("路径太长")
	}
	name := ""
	for _, part := range parts {
		if !allowedName(part) {
			return "", errors.New("只允许工作目录内的普通相对路径；不允许链接、隐藏路径或常见凭据文件")
		}
		name = filepath.Join(name, part)
		st, err := w.root.Lstat(name)
		if err != nil {
			return "", err
		}
		if !st.Mode().IsRegular() && !st.IsDir() {
			return "", errors.New("不允许访问链接或特殊文件")
		}
	}
	return name, nil
}

func (w *workspace) list(raw string) (string, error) {
	name, err := w.path(raw, true)
	if err != nil {
		return "", err
	}
	f, err := w.root.Open(name)
	if err != nil {
		return "", err
	}
	defer f.Close()
	const maxEntries = 100
	entries, err := f.ReadDir(maxEntries + 1)
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	var out strings.Builder
	for i, entry := range entries {
		if i == maxEntries {
			out.WriteString("[目录结果已截断]\n")
			break
		}
		if !allowedName(entry.Name()) || (!entry.IsDir() && !entry.Type().IsRegular()) {
			continue
		}
		label := "文件"
		if entry.IsDir() {
			label = "目录"
		}
		fmt.Fprintf(&out, "%s %q\n", label, entry.Name())
	}
	if out.Len() == 0 {
		return "没有可访问的文件。", nil
	}
	return out.String(), nil
}

func (w *workspace) openText(name string) (*os.File, os.FileInfo, error) {
	f, err := w.root.Open(name)
	if err != nil {
		return nil, nil, err
	}
	st, err := f.Stat()
	if err == nil {
		if !st.Mode().IsRegular() {
			err = errors.New("只允许读取普通文件")
		} else if err = verifyFile(f); err == nil {
			return f, st, nil
		}
	}
	f.Close()
	return nil, nil, err
}

func (w *workspace) read(raw string, tail bool) (string, error) {
	name, err := w.path(raw, false)
	if err != nil {
		return "", err
	}
	f, info, err := w.openText(name)
	if err != nil {
		return "", err
	}
	defer f.Close()
	var byteOrder binary.ByteOrder
	var bom [2]byte
	if _, err := f.ReadAt(bom[:], 0); err == nil {
		switch bom {
		case [2]byte{0xff, 0xfe}:
			byteOrder = binary.LittleEndian
		case [2]byte{0xfe, 0xff}:
			byteOrder = binary.BigEndian
		}
	}
	start := int64(0)
	if tail && info.Size() > readBytes {
		start = info.Size() - readBytes
		if byteOrder != nil {
			start += start % 2
		}
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return "", err
	}
	data, err := io.ReadAll(io.LimitReader(f, readBytes+1))
	if err != nil {
		return "", err
	}
	truncated := len(data) > readBytes || info.Size() > start+int64(len(data))
	if len(data) > readBytes {
		data = data[:readBytes]
	}
	if byteOrder != nil {
		if start == 0 && len(data) >= 2 {
			data = data[2:]
		}
		units := make([]uint16, 0, len(data)/2)
		for len(data) >= 2 {
			units = append(units, byteOrder.Uint16(data))
			data = data[2:]
		}
		data = []byte(string(utf16.Decode(units)))
	} else {
		raw := data
		if start > 0 {
			for len(data) > 0 && !utf8.RuneStart(data[0]) {
				data = data[1:]
			}
		} else {
			data = bytes.TrimPrefix(data, utf8BOM)
		}
		if truncated && len(data) > 0 {
			i := len(data) - 1
			for i > 0 && !utf8.RuneStart(data[i]) {
				i--
			}
			if !utf8.FullRune(data[i:]) {
				data = data[:i]
			}
		}
		if bytes.IndexByte(raw, 0) >= 0 {
			return "", errors.New("不是文本文件（含 NUL 字节）")
		}
		// Not UTF-8: the system ANSI code page (GBK on Chinese Windows), as most old programs write.
		if !utf8.Valid(data) {
			data = []byte(decodeANSI(raw))
		}
	}
	if bytes.IndexByte(data, 0) >= 0 {
		return "", errors.New("不是文本文件（含 NUL 字节）")
	}
	text := string(data)
	if start > 0 {
		text = "[仅显示文件末尾]\n" + text
	}
	if truncated {
		text += "\n[输出已截断]"
	}
	if text == "" {
		text = "[文件为空]"
	}
	return text, nil
}

type proposal struct {
	name     string
	original []byte
	updated  []byte
	info     os.FileInfo
}

func (w *workspace) editable(name string) ([]byte, os.FileInfo, error) {
	f, st, err := w.openText(name)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()
	if st.Size() > editBytes {
		return nil, nil, errors.New("不修改超过 1 MiB 的文件")
	}
	data, err := io.ReadAll(io.LimitReader(f, editBytes+1))
	if err != nil {
		return nil, nil, err
	}
	if len(data) > editBytes || bytes.IndexByte(data, 0) >= 0 {
		return nil, nil, errors.New("只允许修改不超过 1 MiB 的文本文件（UTF-16 文件不支持修改）")
	}
	return data, st, nil
}

func (w *workspace) propose(raw, old, replacement string) (*proposal, error) {
	if old == "" || old == replacement || len(old) > 8<<10 || len(replacement) > 8<<10 || strings.ContainsRune(replacement, 0) {
		return nil, errors.New("修改必须提供不同的新旧文本；旧文本非空，每段最多 8 KiB，且不能写入 NUL")
	}
	name, err := w.path(raw, false)
	if err != nil {
		return nil, err
	}
	data, info, err := w.editable(name)
	if err != nil {
		return nil, err
	}
	bom := data[:0]
	text := data
	if bytes.HasPrefix(data, utf8BOM) {
		bom, text = data[:len(utf8BOM)], data[len(utf8BOM):]
	}
	content, ansi := string(text), false
	if !utf8.Valid(text) {
		// The system ANSI code page (GBK): edited in Unicode, saved back in the same code page.
		content, ansi = decodeANSI(text), true
		if back, err := encodeANSI(content); err != nil || !bytes.Equal(back, text) {
			return nil, errors.New("文件既不是 UTF-8，也不是系统 ANSI 编码（如 GBK），不能安全修改")
		}
	}
	i := strings.Index(content, old)
	if i < 0 || strings.Contains(content[i+1:], old) {
		return nil, errors.New("旧文本必须在文件中恰好出现一次；请先读取并使用更精确的片段")
	}
	changed := []byte(content[:i] + replacement + content[i+len(old):])
	if ansi {
		if changed, err = encodeANSI(string(changed)); err != nil {
			return nil, err
		}
	}
	if len(bom)+len(changed) > editBytes {
		return nil, errors.New("修改后文件会超过 1 MiB")
	}
	updated := append(append([]byte(nil), bom...), changed...)
	return &proposal{name, data, updated, info}, nil
}

// create makes a new file; it never replaces an existing one.
func (w *workspace) create(raw, content string) (string, error) {
	if len(content) > editBytes || strings.ContainsRune(content, 0) {
		return "", errors.New("新文件最多 1 MiB，且不能包含 NUL")
	}
	parts := strings.Split(strings.ReplaceAll(raw, `\`, "/"), "/")
	base := parts[len(parts)-1]
	if !allowedName(base) {
		return "", errors.New("文件名无效；只允许工作目录内的普通相对路径")
	}
	parent, err := w.path(strings.Join(parts[:len(parts)-1], "/"), true)
	if err != nil {
		return "", err
	}
	name := filepath.Join(parent, base)
	f, err := w.root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if errors.Is(err, os.ErrExist) {
		return "", errors.New("文件已存在；修改已有文件请用 replace_text")
	}
	if err != nil {
		return "", err
	}
	_, err = f.WriteString(content)
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		w.root.Remove(name)
		return "", err
	}
	return name, nil
}

func (w *workspace) apply(p *proposal) error {
	name, err := w.path(p.name, false)
	if err != nil {
		return err
	}
	tmpName := filepath.Join(filepath.Dir(name), ".claude-pro-lite-"+newID()+".tmp")
	f, err := w.root.OpenFile(tmpName, os.O_CREATE|os.O_EXCL|os.O_WRONLY, p.info.Mode().Perm())
	if err != nil {
		return err
	}
	defer w.root.Remove(tmpName)
	_, err = f.Write(p.updated)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	// Re-read immediately before replacing; never overwrite a change made while the user was reviewing.
	current, info, err := w.editable(name)
	if err != nil {
		return err
	}
	if !os.SameFile(info, p.info) || !bytes.Equal(current, p.original) {
		return errors.New("文件在预览后发生变化，未修改")
	}
	return w.root.Rename(tmpName, name)
}
