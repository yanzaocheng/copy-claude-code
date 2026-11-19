package main

import (
	"errors"
	"fmt"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
	"unsafe"
)

var getSystemDirectory = kernel32.NewProc("GetSystemDirectoryW")
var keyLocalFree = kernel32.NewProc("LocalFree")
var keyCrypt32 = sync.OnceValues(func() (*syscall.LazyDLL, error) {
	var buf [260]uint16
	n, _, err := getSystemDirectory.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	if n == 0 || n >= uintptr(len(buf)) {
		return nil, fmt.Errorf("无法定位 Windows 系统目录：%w", err)
	}
	return syscall.NewLazyDLL(filepath.Join(syscall.UTF16ToString(buf[:n]), "crypt32.dll")), nil
})

type keyDataBlob struct {
	size uint32
	data *byte
}

func keyDPAPI(input []byte, endpoint string, protect bool) ([]byte, error) {
	if len(input) == 0 || len(input) > maxKeyBlob {
		return nil, errors.New("Key 数据的长度无效")
	}
	dll, err := keyCrypt32()
	if err != nil {
		return nil, err
	}
	op := "CryptUnprotectData"
	if protect {
		op = "CryptProtectData"
	}
	proc := dll.NewProc(op)
	if err := proc.Find(); err != nil {
		return nil, err
	}
	// Bind the saved Key to the gateway URL as well as the current Windows account.
	extra := []byte("claude-pro-lite\x00" + endpoint)
	in := keyDataBlob{uint32(len(input)), &input[0]}
	entropy := keyDataBlob{uint32(len(extra)), &extra[0]}
	var out keyDataBlob
	const prohibitUI = 0x1 // CRYPTPROTECT_UI_FORBIDDEN
	r, _, err := proc.Call(uintptr(unsafe.Pointer(&in)), 0, uintptr(unsafe.Pointer(&entropy)), 0, 0, prohibitUI, uintptr(unsafe.Pointer(&out)))
	runtime.KeepAlive(input)
	runtime.KeepAlive(extra)
	if r == 0 {
		return nil, err
	}
	if out.data == nil {
		return nil, errors.New("Windows 未返回 Key 数据")
	}
	defer keyLocalFree.Call(uintptr(unsafe.Pointer(out.data)))
	if out.size == 0 || out.size > maxKeyBlob {
		return nil, errors.New("Windows 返回的 Key 数据长度无效")
	}
	result := unsafe.Slice(out.data, int(out.size))
	if !protect {
		defer clear(result)
	}
	return append([]byte(nil), result...), nil
}
