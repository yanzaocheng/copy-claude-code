package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

const (
	configFile     = "claude-pro-lite.json"
	defaultGateway = "https://7bit.fun"
	defaultModel   = "claude-sonnet-5-5"
	maxConfigBytes = 64 << 10
)

// appConfig is the settings file next to the EXE. It is plain JSON so it can be read and edited in Notepad.
type appConfig struct {
	Gateway string `json:"gateway"`
	Model   string `json:"model"`
	APIKey  string `json:"apiKey"`
	WorkDir string `json:"workDir"`
	// ReadOnly: the agent may only list and read files (no edits, no commands).
	ReadOnly bool `json:"readOnly"`
	// Confirm: ask before every file change or command (default: act without asking).
	Confirm bool `json:"confirm"`
	path    string
}

func defaultConfigPath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("无法定位 EXE 所在目录：%w", err)
	}
	return filepath.Join(filepath.Dir(exe), configFile), nil
}

// loadConfig reads the settings file, creating it with the defaults when it does not exist yet.
func loadConfig(path string, out io.Writer) (*appConfig, error) {
	if path == "" {
		var err error
		if path, err = defaultConfigPath(); err != nil {
			return nil, err
		}
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	cfg := &appConfig{Gateway: defaultGateway, Model: defaultModel, path: abs}
	data, err := os.ReadFile(abs)
	if errors.Is(err, os.ErrNotExist) {
		if err := cfg.save(); err != nil {
			return nil, fmt.Errorf("无法生成配置文件 %s：%w（请把 EXE 放到可写的目录）", abs, err)
		}
		fmt.Fprintln(out, "已生成配置文件："+abs)
		return cfg, nil
	}
	if err != nil {
		return nil, fmt.Errorf("无法读取配置文件 %s：%w", abs, err)
	}
	if len(data) > maxConfigBytes {
		return nil, fmt.Errorf("配置文件 %s 太大", abs)
	}
	// Notepad saves UTF-8 with a BOM.
	data = bytes.TrimPrefix(data, utf8BOM)
	if err := json.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("配置文件 %s 不是有效的 JSON（%v）；可以删除它，下次启动会重新生成", abs, err)
	}
	if cfg.Gateway == "" {
		cfg.Gateway = defaultGateway
	}
	if cfg.Model == "" {
		cfg.Model = defaultModel
	}
	fmt.Fprintln(out, "配置文件："+abs)
	return cfg, nil
}

func (c *appConfig) save() error {
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	// CRLF: the Notepad of Windows Server 2008 R2 shows LF-only text on one line.
	data = append(bytes.ReplaceAll(data, []byte("\n"), []byte("\r\n")), '\r', '\n')
	f, err := os.CreateTemp(filepath.Dir(c.path), ".claude-pro-lite-config-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(f.Name(), c.path)
}
