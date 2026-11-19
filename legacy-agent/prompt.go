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
	promptFile     = "claude-pro-lite-prompt.txt"
	maxPromptBytes = 32 << 10
)

// promptTemplate is written on first start. Lines starting with # are comments and are not sent.
const promptTemplate = `# claude-pro-lite 附加系统提示词
# 这里写的内容会追加在内置系统提示词后面，每次提问都发给模型。
# 以 # 开头的行是注释，不会发送。保存后下一条消息就生效，不用重启。
# 在对话里输入 /prompt 可以查看实际发送的完整系统提示词。
#
# 例子（去掉行首的 # 即可生效）：
# 回答尽量简短，先给结论。
# 这台服务器运行游戏服务端，程序在 D:\game，数据库是本机 SQL Server。
# 不要停止或重启任何服务，除非我明确要求。
`

// promptPathFor: the prompt file sits next to the config file.
func promptPathFor(configPath string) string {
	return filepath.Join(filepath.Dir(configPath), promptFile)
}

// ensurePromptFile creates the template when the file does not exist yet; it reports whether it did.
func ensurePromptFile(path string) (bool, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if errors.Is(err, os.ErrExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	// UTF-8 with a BOM and CRLF, so the Notepad of Windows Server 2008 R2 shows the Chinese text correctly.
	_, err = f.Write(append(append([]byte(nil), utf8BOM...), strings.ReplaceAll(promptTemplate, "\n", "\r\n")...))
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		os.Remove(path)
		return false, err
	}
	return true, nil
}

// readExtraPrompt returns the user's instructions from the prompt file, without comment lines. A missing
// file is no instructions. Notepad may save it as ANSI (GBK), UTF-8 or "Unicode" (UTF-16 with a BOM).
func readExtraPrompt(path string) (string, error) {
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxPromptBytes+1))
	if err != nil {
		return "", err
	}
	if len(data) > maxPromptBytes {
		return "", fmt.Errorf("提示词文件 %s 超过 32 KiB", path)
	}
	var text string
	switch {
	case bytes.HasPrefix(data, []byte{0xff, 0xfe}):
		text = decodeUTF16(data[2:], binary.LittleEndian)
	case bytes.HasPrefix(data, []byte{0xfe, 0xff}):
		text = decodeUTF16(data[2:], binary.BigEndian)
	default:
		data = bytes.TrimPrefix(data, utf8BOM)
		if utf8.Valid(data) {
			text = string(data)
		} else {
			text = decodeANSI(data)
		}
	}
	var lines []string
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}
		lines = append(lines, strings.TrimRight(line, " \t\r"))
	}
	return strings.TrimSpace(strings.ReplaceAll(strings.Join(lines, "\n"), "\x00", "")), nil
}

func decodeUTF16(data []byte, order binary.ByteOrder) string {
	units := make([]uint16, 0, len(data)/2)
	for len(data) >= 2 {
		units = append(units, order.Uint16(data))
		data = data[2:]
	}
	return string(utf16.Decode(units))
}
