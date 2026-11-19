package main

import (
	"os"
	"syscall"
	"unsafe"
)

var (
	kernel32                = syscall.NewLazyDLL("kernel32.dll")
	flushConsoleInputBuffer = kernel32.NewProc("FlushConsoleInputBuffer")
	getConsoleProcessList   = kernel32.NewProc("GetConsoleProcessList")
)

func isConsole(in *os.File) bool {
	var mode uint32
	return syscall.GetConsoleMode(syscall.Handle(in.Fd()), &mode) == nil
}

func clearConsoleInput(in *os.File) bool {
	r, _, _ := flushConsoleInputBuffer.Call(in.Fd())
	return r != 0
}

// ownConsole: the console window belongs to this process alone (started by double-click in Explorer), so it
// closes when the process exits.
func ownConsole() bool {
	var ids [2]uint32
	n, _, _ := getConsoleProcessList.Call(uintptr(unsafe.Pointer(&ids[0])), uintptr(len(ids)))
	return n == 1
}
