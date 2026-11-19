//go:build !windows

package main

import "errors"

func keyDPAPI([]byte, string, bool) ([]byte, error) {
	return nil, errors.New("加密保存 API Key 需要 Windows DPAPI")
}
