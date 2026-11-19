package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

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
		{"read_text", "Read up to 24 KiB of a text file (UTF-8, UTF-16 with BOM, or the system ANSI code page such as GBK). Use tail=true for the end of a log.", toolSchema{Type: "object", Properties: map[string]toolProperty{"path": path, "tail": {"boolean", "Read the end instead of the beginning."}}, Required: []string{"path"}}},
	}
	if readOnly {
		return specs
	}
	return append(specs,
		toolSpec{"replace_text", "Replace one unique exact snippet in an existing text file (UTF-8 or the system ANSI code page; the encoding is kept). The user confirms first. Match the original line endings (usually CRLF).", toolSchema{Type: "object", Properties: map[string]toolProperty{"path": path, "old_text": {"string", "Exact old text; must appear once."}, "new_text": {"string", "Replacement text."}}, Required: []string{"path", "old_text", "new_text"}}},
		toolSpec{"write_file", "Create a NEW text file (fails if it exists; the parent directory must exist). Saved as UTF-8 without BOM; LF line endings become CRLF. The user confirms first. For an existing file use replace_text.", toolSchema{Type: "object", Properties: map[string]toolProperty{"path": path, "content": {"string", "The whole file content."}}, Required: []string{"path", "content"}}},
		toolSpec{"run_command", "Run one cmd.exe command line in the workspace directory, with no input (stdin is empty, so interactive prompts fail). Returns the exit code and up to 24 KiB of combined output. The user confirms each command unless they chose to allow all. Use commands that exist on this Windows version.", toolSchema{Type: "object", Properties: map[string]toolProperty{"command": {"string", "The command line, as typed in cmd.exe."}, "timeout_seconds": {"integer", "Stop the command after this many seconds (default 120, at most 600)."}}, Required: []string{"command"}}},
	)
}

func (s *session) callTool(ctx context.Context, call block) block {
	result := block{Type: "tool_result", CallID: call.ID}
	finish := func(text string, err error) block {
		if err != nil {
			text, result.Failed = err.Error(), true
			fmt.Fprintln(s.out, "  未完成："+terminalText(text))
		}
		result.Result = text
		return result
	}
	args := bytes.TrimSpace(call.Input)
	if len(args) == 0 || args[0] != '{' || len(args) > 1<<20 {
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
	writing := call.Name == "replace_text" || call.Name == "write_file" || call.Name == "run_command"
	if writing && s.readOnly {
		return finish("", errors.New("当前为只读模式（配置文件 readOnly 为 true），不能修改文件或执行命令"))
	}
	switch call.Name {
	case "list_files":
		var a struct{ Path string }
		if err := decode(&a); err != nil {
			return finish("", err)
		}
		fmt.Fprintf(s.out, "· 列出目录 %s\n", displayPath(a.Path))
		return finish(s.ws.list(a.Path))
	case "read_text":
		var a struct {
			Path string
			Tail bool
		}
		if err := decode(&a); err != nil {
			return finish("", err)
		}
		fmt.Fprintf(s.out, "· 读取 %s\n", displayPath(a.Path))
		return finish(s.ws.read(a.Path, a.Tail))
	case "replace_text":
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
		preview := fmt.Sprintf("\n== 修改文件 %s ==\n--- 原文\n%s\n+++ 改为\n%s\n输入 y 确认写入，其它输入取消：", p.name, previewText(a.Old, 20), previewText(*a.New, 20))
		if s.ask(ctx, preview) != "y" {
			return finish("", errors.New("用户未确认，文件未修改"))
		}
		if err := s.ws.apply(p); err != nil {
			return finish("", err)
		}
		fmt.Fprintln(s.out, "  已写入。")
		return finish("用户已确认，文件已修改。", nil)
	case "write_file":
		var a struct {
			Path    string  `json:"path"`
			Content *string `json:"content"`
		}
		if err := decode(&a); err != nil {
			return finish("", err)
		}
		if a.Content == nil {
			return finish("", errors.New("必须提供 content"))
		}
		content := crlf(*a.Content)
		preview := fmt.Sprintf("\n== 新建文件 %s（%d 字节）==\n%s\n输入 y 确认创建，其它输入取消：", displayPath(a.Path), len(content), previewText(content, 20))
		if s.ask(ctx, preview) != "y" {
			return finish("", errors.New("用户未确认，文件未创建"))
		}
		name, err := s.ws.create(a.Path, content)
		if err != nil {
			return finish("", err)
		}
		fmt.Fprintln(s.out, "  已创建 "+name)
		return finish("用户已确认，文件已创建。", nil)
	case "run_command":
		var a struct {
			Command string `json:"command"`
			Timeout int    `json:"timeout_seconds"`
		}
		if err := decode(&a); err != nil {
			return finish("", err)
		}
		command := strings.TrimSpace(a.Command)
		if command == "" || len(command) > 8000 || strings.ContainsAny(command, "\r\n\x00") {
			return finish("", errors.New("命令必须是一行，且不超过 8000 字符"))
		}
		timeout := 120 * time.Second
		if a.Timeout > 0 {
			timeout = time.Duration(min(a.Timeout, 600)) * time.Second
		}
		if s.allowCommands {
			fmt.Fprintf(s.out, "· 执行命令：%s\n", terminalText(command))
		} else {
			preview := fmt.Sprintf("\n== 执行命令（目录 %s）==\n  %s\n输入 y 执行，a 本次运行都不再询问，其它输入取消：", s.ws.dir, terminalText(command))
			switch s.ask(ctx, preview) {
			case "a":
				s.allowCommands = true
			case "y":
			default:
				return finish("", errors.New("用户未确认，命令未执行"))
			}
		}
		started := time.Now()
		output, code, err := runCommand(ctx, s.ws.dir, command, timeout)
		if err != nil {
			return finish("", err)
		}
		fmt.Fprintf(s.out, "  结束，退出码 %d，用时 %.1f 秒。\n", code, time.Since(started).Seconds())
		return finish(fmt.Sprintf("exit code %d\n%s", code, output), nil)
	default:
		return finish("", errors.New("不支持的工具"))
	}
}

// ask: an answer typed after Ctrl+C stopped the turn does not count.
func (s *session) ask(ctx context.Context, preview string) string {
	answer := s.confirm(preview)
	if ctx.Err() != nil {
		return ""
	}
	return answer
}

func displayPath(p string) string {
	if p == "" || p == "." {
		return "（工作目录）"
	}
	return terminalText(p)
}

// previewText shows at most maxLines lines of a snippet, indented, for a confirmation.
func previewText(text string, maxLines int) string {
	lines := strings.Split(strings.ReplaceAll(terminalText(text), "\r", ""), "\n")
	more := 0
	if len(lines) > maxLines {
		more = len(lines) - maxLines
		lines = lines[:maxLines]
	}
	out := "  " + strings.Join(lines, "\n  ")
	if more > 0 {
		out += fmt.Sprintf("\n  …（另有 %d 行）", more)
	}
	return out
}

// crlf turns LF line endings into CRLF (the Notepad of old Windows shows LF-only text on one line).
func crlf(text string) string {
	return strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\n", "\r\n")
}
