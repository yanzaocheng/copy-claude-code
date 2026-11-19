package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
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
	}
	if !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
		return "", errors.New("只能读取 UTF-8 或带 BOM 的 UTF-16 文本；不是文本或编码不受支持")
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
	if len(data) > editBytes || !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
		return nil, nil, errors.New("只允许修改不超过 1 MiB 的 UTF-8 文本文件")
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
	i := bytes.Index(text, []byte(old))
	if i < 0 || bytes.Contains(text[i+1:], []byte(old)) {
		return nil, errors.New("旧文本必须在文件中恰好出现一次；请先读取并使用更精确的片段")
	}
	if len(data)-len(old)+len(replacement) > editBytes {
		return nil, errors.New("修改后文件会超过 1 MiB")
	}
	updated := append([]byte(nil), bom...)
	updated = append(updated, text[:i]...)
	updated = append(updated, replacement...)
	updated = append(updated, text[i+len(old):]...)
	return &proposal{name, data, updated, info}, nil
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

type toolSpec struct {
	Name        string     `json:"name"`
	Description string     `json:"description"`
	Schema      toolSchema `json:"input_schema"`
}

type toolSchema struct {
	Type       string                  `json:"type"`
	Properties map[string]toolProperty `json:"properties"`
	Required   []string                `json:"required,omitempty"`
	Extra      bool                    `json:"additionalProperties"`
}

type toolProperty struct {
	Type        string `json:"type"`
	Description string `json:"description"`
}

func tools(readOnly bool) []toolSpec {
	path := toolProperty{"string", "Workspace-relative path. Use '.' for the root when listing."}
	specs := []toolSpec{
		{"list_files", "List at most 100 entries directly inside a workspace directory.", toolSchema{Type: "object", Properties: map[string]toolProperty{"path": path}}},
		{"read_text", "Read up to 24 KiB of a UTF-8 or BOM-marked UTF-16 file. Use tail=true for the end of a log.", toolSchema{Type: "object", Properties: map[string]toolProperty{"path": path, "tail": {"boolean", "Read the end instead of the beginning."}}, Required: []string{"path"}}},
	}
	if !readOnly {
		specs = append(specs, toolSpec{"replace_text", "Propose replacing one unique exact snippet in an existing UTF-8 file. Requires user confirmation. Match original line endings (including CRLF).", toolSchema{Type: "object", Properties: map[string]toolProperty{"path": path, "old_text": {"string", "Exact old text; must appear once."}, "new_text": {"string", "Replacement text."}}, Required: []string{"path", "old_text", "new_text"}}})
	}
	return specs
}

func (s *session) callTool(call block) block {
	result := block{Type: "tool_result", CallID: call.ID}
	finish := func(text string, err error) block {
		if err != nil {
			text, result.Failed = err.Error(), true
			fmt.Fprintln(s.out, "工具未完成："+terminalText(text))
		}
		result.Result = text
		return result
	}
	args := bytes.TrimSpace(call.Input)
	if len(args) == 0 || args[0] != '{' || len(args) > 128<<10 {
		return finish("", errors.New("工具输入无效"))
	}
	decode := func(dst any) error {
		dec := json.NewDecoder(bytes.NewReader(args))
		dec.DisallowUnknownFields()
		if err := dec.Decode(dst); err != nil {
			return errors.New("工具输入字段无效")
		}
		return nil
	}
	switch call.Name {
	case "list_files":
		var a struct{ Path string }
		if err := decode(&a); err != nil {
			return finish("", err)
		}
		fmt.Fprintf(s.out, "列出目录：%q\n", a.Path)
		return finish(s.ws.list(a.Path))
	case "read_text":
		var a struct {
			Path string
			Tail bool
		}
		if err := decode(&a); err != nil {
			return finish("", err)
		}
		fmt.Fprintf(s.out, "读取文本：%q\n", a.Path)
		return finish(s.ws.read(a.Path, a.Tail))
	case "replace_text":
		if s.readOnly {
			return finish("", errors.New("当前为只读模式，不能修改文件"))
		}
		var a struct {
			Path string  `json:"path"`
			Old  string  `json:"old_text"`
			New  *string `json:"new_text"`
		}
		if err := decode(&a); err != nil {
			return finish("", err)
		}
		if a.New == nil {
			return finish("", errors.New("必须明确提供 new_text"))
		}
		p, err := s.ws.propose(a.Path, a.Old, *a.New)
		if err != nil {
			return finish("", err)
		}
		preview := fmt.Sprintf("\n待确认修改：%q\n- %q\n+ %q\n输入 y 确认写入，其它输入取消：", p.name, a.Old, *a.New)
		if !s.approve(preview) {
			return finish("", errors.New("操作者未确认，文件未修改"))
		}
		if err := s.ws.apply(p); err != nil {
			return finish("", err)
		}
		fmt.Fprintln(s.out, "文件已修改。")
		return finish("已确认并写入文件。", nil)
	default:
		return finish("", errors.New("不支持的工具"))
	}
}
