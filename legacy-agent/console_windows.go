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
	if !isConsole(in) {
		return "", fmt.Errorf("没有交互式控制台，请设置 %s 环境变量", keyEnv)
	}
	fmt.Fprint(out, "粘贴网关 API Key 后按回车（验证通过后加密保存）：")
	return readLine(input)
}
