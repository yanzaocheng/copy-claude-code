package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

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

// keyRejected: the Key itself is wrong (format, or refused by the gateway), so asking for another one helps.
func keyRejected(err error) bool {
	var se *statusErr
	return errors.As(err, &se) && (se.status == 401 || se.status == 403) || errors.Is(err, errKeyFormat)
}

var errKeyFormat = errors.New("API Key 格式无效")

func checkKeyFormat(key string) error {
	if err := validKey(key); err != nil {
		return fmt.Errorf("%w：%s", errKeyFormat, err.Error())
	}
	return nil
}

// acquireGateway finds the Key (environment variable, then the config file, then the keyboard), checks it with
// the gateway (GET /v1/models, free) and saves a typed one to the config file.
func acquireGateway(ctx context.Context, cfg *appConfig, endpoint string, replace, check bool, out io.Writer, input func() (string, error)) (*gateway, error) {
	if key := strings.TrimSpace(os.Getenv(keyEnv)); key != "" && !replace {
		fmt.Fprintln(out, "API Key：来自环境变量 "+keyEnv)
		if err := checkKeyFormat(key); err != nil {
			return nil, err
		}
		gw := newGateway(endpoint, key)
		if check {
			if err := verifyKey(ctx, gw, out); err != nil {
				return nil, err
			}
		}
		return gw, nil
	}
	if key := strings.TrimSpace(cfg.APIKey); key != "" && !replace {
		fmt.Fprintln(out, "API Key：来自配置文件 "+key)
		gw := newGateway(endpoint, key)
		err := checkKeyFormat(key)
		if err == nil {
			err = verifyKey(ctx, gw, out)
		}
		if err == nil {
			return gw, nil
		}
		if !keyRejected(err) {
			return nil, err
		}
		fmt.Fprintln(out, "错误："+terminalText(err.Error()))
		fmt.Fprintln(out, "配置文件里的 API Key 不能用，请重新粘贴。")
	}
	// Typed in: ask again after every mistake, until a Key is accepted or the input ends.
	var lastErr error
	for {
		typed, err := input()
		if err != nil {
			if lastErr != nil {
				return nil, lastErr
			}
			return nil, err
		}
		key := strings.TrimSpace(typed)
		if key == "" {
			continue
		}
		gw := newGateway(endpoint, key)
		if err = checkKeyFormat(key); err == nil {
			err = verifyKey(ctx, gw, out)
		}
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			lastErr = err
			fmt.Fprintln(out, "错误："+terminalText(err.Error()))
			fmt.Fprintln(out, "请重新粘贴 API Key（直接关闭窗口可退出）。")
			continue
		}
		cfg.APIKey = key
		if err := cfg.save(); err != nil {
			fmt.Fprintln(out, "API Key 已验证，但无法写入配置文件（本次照常使用，下次需重新输入）："+terminalText(err.Error()))
		} else {
			fmt.Fprintln(out, "API Key 已保存到配置文件："+cfg.path)
		}
		return gw, nil
	}
}

func verifyKey(ctx context.Context, gw *gateway, out io.Writer) error {
	fmt.Fprintln(out, "正在验证 API Key（不调用模型）…")
	count, err := gw.check(ctx)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "API Key 验证通过，网关返回 %d 个模型。\n", count)
	return nil
}

// promptKey asks for the Key on standard input; the input is shown as it is typed.
func promptKey(input *bufio.Reader, out io.Writer) (string, error) {
	fmt.Fprint(out, "粘贴网关 API Key 后按回车（验证通过后保存到配置文件）：")
	key, err := readLine(input)
	if errors.Is(err, io.EOF) && key == "" {
		return "", errors.New("没有读到 API Key")
	}
	return key, err
}
