package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const keyFile = "claude-pro-lite.key"
const maxKeyBlob = 64 << 10

func validKey(key string) error {
	if key == "" || len(key) > 4096 {
		return errors.New("API Key 为空或太长，请只粘贴 Key 本身")
	}
	padding := false
	for i, r := range key {
		if r == '=' && i > 0 {
			padding = true
			continue
		}
		if !padding && (r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("-._~+/", r)) {
			continue
		}
		return fmt.Errorf("API Key 第 %d 个字符无效；请切到英文输入法，只粘贴 Key 本身，不带引号、空格或 Bearer 前缀", i+1)
	}
	return nil
}

func keyPreview(key string, interactive bool) string {
	if !interactive || len(key) < 24 {
		return fmt.Sprintf("****（%d 字符）", len(key))
	}
	return fmt.Sprintf("%s…%s（%d 字符）", key[:3], key[len(key)-3:], len(key))
}

func acquireGateway(ctx context.Context, endpoint string, replace, check bool, path string, out io.Writer, input func() (string, error)) (*gateway, error) {
	key, source := "", ""
	if !replace {
		key = strings.TrimSpace(os.Getenv(keyEnv))
		if key != "" {
			source = "环境变量"
		}
	}
	if key == "" && path == "" {
		exe, err := os.Executable()
		if err != nil {
			return nil, fmt.Errorf("无法定位 EXE 同级的 Key 文件：%w", err)
		}
		path = filepath.Join(filepath.Dir(exe), keyFile)
	}
	if key == "" && !replace {
		var err error
		key, err = loadKey(path, endpoint)
		if err == nil {
			source = "已保存"
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("无法读取或解密保存的 API Key；请确认 Windows 用户和网关地址未变，或运行 claude-pro-lite.exe -set-key：%w", err)
		}
	}
	entered := source == ""
	if entered {
		var err error
		key, err = input()
		if err != nil {
			return nil, err
		}
		key, source = strings.TrimSpace(key), "本次输入"
	}
	if err := validKey(key); err != nil {
		return nil, err
	}
	terminal, isFile := out.(*os.File)
	fmt.Fprintf(out, "API Key（%s）：%s\n", source, keyPreview(key, isFile && isConsole(terminal)))
	gw := newGateway(endpoint, key)
	if entered || check {
		fmt.Fprintln(out, "正在验证 API Key（不调用模型）…")
		count, err := gw.check(ctx)
		if err != nil {
			return nil, err
		}
		fmt.Fprintf(out, "API Key 验证通过，网关返回 %d 个模型。\n", count)
	}
	if entered {
		if err := saveKey(path, endpoint, key); err != nil {
			return nil, fmt.Errorf("API Key 已验证，但无法加密保存到 EXE 同级目录：%w", err)
		}
		fmt.Fprintln(out, "已加密保存到 EXE 同级目录的 "+keyFile+"；下次启动无需再输入。")
	}
	return gw, nil
}

func loadKey(path, endpoint string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > maxKeyBlob {
		return "", errors.New("Key 文件格式无效")
	}
	blob, err := io.ReadAll(io.LimitReader(f, maxKeyBlob+1))
	if err != nil {
		return "", err
	}
	if len(blob) == 0 || len(blob) > maxKeyBlob {
		return "", errors.New("Key 文件格式无效")
	}
	data, err := keyDPAPI(blob, endpoint, false)
	if err != nil {
		return "", err
	}
	defer clear(data)
	key := string(data)
	if err := validKey(key); err != nil {
		return "", err
	}
	return key, nil
}

func saveKey(path, endpoint, key string) error {
	input := []byte(key)
	defer clear(input)
	blob, err := keyDPAPI(input, endpoint, true)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".claude-pro-lite-key-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, err = f.Write(blob)
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
	return os.Rename(f.Name(), path)
}
