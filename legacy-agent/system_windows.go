package main

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"syscall"
	"time"
	"unicode/utf16"
	"unicode/utf8"
	"unsafe"
)

var (
	multiByteToWideChar = kernel32.NewProc("MultiByteToWideChar")
	wideCharToMultiByte = kernel32.NewProc("WideCharToMultiByte")
	getACP              = kernel32.NewProc("GetACP")
)

const (
	cpACP = 0 // the system ANSI code page: 936 (GBK) on Chinese Windows
	cpOEM = 1 // the console code page of cmd.exe and its built-in commands
)

func decodeCP(cp uintptr, b []byte) string {
	if len(b) == 0 {
		return ""
	}
	n, _, _ := multiByteToWideChar.Call(cp, 0, uintptr(unsafe.Pointer(&b[0])), uintptr(len(b)), 0, 0)
	if n == 0 {
		return string(b)
	}
	buf := make([]uint16, n)
	n, _, _ = multiByteToWideChar.Call(cp, 0, uintptr(unsafe.Pointer(&b[0])), uintptr(len(b)), uintptr(unsafe.Pointer(&buf[0])), n)
	return string(utf16.Decode(buf[:n]))
}

func decodeANSI(b []byte) string { return decodeCP(cpACP, b) }

// encodeANSI converts to the system ANSI code page, refusing characters it cannot hold (rather than writing '?').
func encodeANSI(s string) ([]byte, error) {
	u := utf16.Encode([]rune(s))
	if len(u) == 0 {
		return nil, nil
	}
	const noBestFit = 0x400 // WC_NO_BEST_FIT_CHARS
	var usedDefault int32
	n, _, _ := wideCharToMultiByte.Call(cpACP, noBestFit, uintptr(unsafe.Pointer(&u[0])), uintptr(len(u)), 0, 0, 0, uintptr(unsafe.Pointer(&usedDefault)))
	if n == 0 {
		return nil, errors.New("无法转换为系统编码")
	}
	buf := make([]byte, n)
	n, _, _ = wideCharToMultiByte.Call(cpACP, noBestFit, uintptr(unsafe.Pointer(&u[0])), uintptr(len(u)), uintptr(unsafe.Pointer(&buf[0])), n, 0, uintptr(unsafe.Pointer(&usedDefault)))
	if usedDefault != 0 {
		return nil, errors.New("新文本包含系统编码（如 GBK）无法保存的字符")
	}
	return buf[:n], nil
}

func ansiCodePage() int {
	cp, _, _ := getACP.Call()
	return int(cp)
}

// decodeOutput turns what a command printed into text: UTF-8 as is, UTF-16 (wmic and some tools when
// redirected), otherwise the console code page.
func decodeOutput(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	if len(b) >= 4 && len(b)%2 == 0 {
		zeros := 0
		for i := 1; i < len(b); i += 2 {
			if b[i] == 0 {
				zeros++
			}
		}
		if zeros*3 > len(b)/2 {
			if b[0] == 0xff && b[1] == 0xfe {
				b = b[2:]
			}
			u := make([]uint16, len(b)/2)
			for i := range u {
				u[i] = uint16(b[2*i]) | uint16(b[2*i+1])<<8
			}
			return string(utf16.Decode(u))
		}
	}
	return decodeCP(cpOEM, b)
}

// runCommand runs a command line through cmd.exe with empty input. The whole process tree is stopped on
// timeout or when the user presses Ctrl+C.
func runCommand(ctx context.Context, dir, command string, timeout time.Duration) (string, int, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "cmd.exe")
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: `cmd.exe /d /s /c "` + command + `"`}
	cmd.Dir = dir
	var out headTail
	cmd.Stdout, cmd.Stderr = &out, &out
	cmd.Cancel = func() error {
		// cmd.exe's children (ping, a script...) are not stopped with it.
		_ = exec.Command("taskkill.exe", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid)).Run()
		return cmd.Process.Kill()
	}
	cmd.WaitDelay = 3 * time.Second
	err := cmd.Run()
	text := decodeOutput(out.bytes())
	if out.dropped > 0 {
		text = fmt.Sprintf("%s\n[中间省略了 %d 字节输出]\n%s", decodeOutput(out.head), out.dropped, decodeOutput(out.tail))
	}
	var exit *exec.ExitError
	switch {
	case ctx.Err() == context.DeadlineExceeded:
		return text + fmt.Sprintf("\n[命令超过 %d 秒，已停止]", int(timeout.Seconds())), -1, nil
	case ctx.Err() != nil:
		return "", 0, errors.New("命令被用户中止")
	case errors.As(err, &exit):
		return text, exit.ExitCode(), nil
	case err != nil:
		return "", 0, fmt.Errorf("无法执行命令：%w", err)
	}
	return text, 0, nil
}

// headTail keeps the first and the last 12 KiB of the output.
type headTail struct {
	head, tail []byte
	dropped    int
}

const outputKeep = 12 << 10

func (h *headTail) Write(p []byte) (int, error) {
	n := len(p)
	if room := outputKeep - len(h.head); room > 0 {
		take := min(room, len(p))
		h.head = append(h.head, p[:take]...)
		p = p[take:]
	}
	h.tail = append(h.tail, p...)
	if extra := len(h.tail) - outputKeep; extra > 0 {
		h.dropped += extra
		h.tail = append(h.tail[:0:0], h.tail[extra:]...)
	}
	return n, nil
}

func (h *headTail) bytes() []byte { return append(append([]byte(nil), h.head...), h.tail...) }

// osDescription names the Windows version for the system prompt, e.g. "Windows Server 2008 R2 Enterprise
// Service Pack 1 (6.1.7601)".
func osDescription() string {
	ver, _ := syscall.GetVersion()
	numbers := fmt.Sprintf("%d.%d.%d", byte(ver), uint8(ver>>8), uint16(ver>>16))
	const key = `SOFTWARE\Microsoft\Windows NT\CurrentVersion`
	name := regString(key, "ProductName")
	if name == "" {
		return "Windows " + numbers
	}
	if sp := regString(key, "CSDVersion"); sp != "" {
		name += " " + sp
	}
	return name + " (" + numbers + ")"
}

func regString(path, value string) string {
	p, _ := syscall.UTF16PtrFromString(path)
	var h syscall.Handle
	if syscall.RegOpenKeyEx(syscall.HKEY_LOCAL_MACHINE, p, 0, syscall.KEY_READ, &h) != nil {
		return ""
	}
	defer syscall.RegCloseKey(h)
	v, _ := syscall.UTF16PtrFromString(value)
	var typ uint32
	buf := make([]uint16, 256)
	n := uint32(len(buf) * 2)
	if syscall.RegQueryValueEx(h, v, nil, &typ, (*byte)(unsafe.Pointer(&buf[0])), &n) != nil || typ != syscall.REG_SZ {
		return ""
	}
	return syscall.UTF16ToString(buf[:n/2])
}
