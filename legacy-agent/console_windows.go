package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"syscall"
)

var (
	kernel32                = syscall.NewLazyDLL("kernel32.dll")
	setConsoleMode          = kernel32.NewProc("SetConsoleMode")
	flushConsoleInputBuffer = kernel32.NewProc("FlushConsoleInputBuffer")
)

func isConsole(in *os.File) bool {
	var mode uint32
	return syscall.GetConsoleMode(syscall.Handle(in.Fd()), &mode) == nil
}

func clearConsoleInput(in *os.File) bool {
	r, _, _ := flushConsoleInputBuffer.Call(in.Fd())
	return r != 0
}

func promptKey(in *os.File, input *bufio.Reader, out io.Writer) (string, error) {
	var mode uint32
	if err := syscall.GetConsoleMode(syscall.Handle(in.Fd()), &mode); err != nil {
		return "", fmt.Errorf("没有交互式控制台，请设置 %s 环境变量", keyEnv)
	}
	const echoInput = 0x0004
	if r, _, err := setConsoleMode.Call(in.Fd(), uintptr(mode&^echoInput)); r == 0 {
		return "", fmt.Errorf("无法关闭控制台回显：%w", err)
	}
	defer setConsoleMode.Call(in.Fd(), uintptr(mode))
	fmt.Fprint(out, "粘贴网关 API Key 后按回车（验证通过后加密保存，输入时不回显）：")
	key, err := readLine(input)
	fmt.Fprintln(out)
	return key, err
}
