//go:build !windows

package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
)

func isConsole(*os.File) bool         { return false }
func clearConsoleInput(*os.File) bool { return false }

func promptKey(*os.File, *bufio.Reader, io.Writer) (string, error) {
	return "", fmt.Errorf("非 Windows 平台请通过 %s 环境变量提供 Key", keyEnv)
}
