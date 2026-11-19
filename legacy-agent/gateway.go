package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type block struct {
	Type   string          `json:"type"`
	Text   string          `json:"text,omitempty"`
	ID     string          `json:"id,omitempty"`
	Name   string          `json:"name,omitempty"`
	Input  json.RawMessage `json:"input,omitempty"`
	CallID string          `json:"tool_use_id,omitempty"`
	Result string          `json:"content,omitempty"`
	Failed bool            `json:"is_error,omitempty"`
	raw    json.RawMessage
}

func (b *block) UnmarshalJSON(data []byte) error {
	type wire block
	if err := json.Unmarshal(data, (*wire)(b)); err != nil {
		return err
	}
	b.raw = append(b.raw[:0], data...)
	return nil
}

func (b block) MarshalJSON() ([]byte, error) {
	// Echo tool calls and signed reasoning blocks without removing provider-specific fields.
	if b.raw != nil {
		return b.raw, nil
	}
	type wire block
	return json.Marshal(wire(b))
}

type message struct {
	Role    string  `json:"role"`
	Content []block `json:"content"`
}

type reply struct {
	Content    []block `json:"content"`
	StopReason string  `json:"stop_reason"`
}

type gateway struct {
	base, key string
	client    *http.Client
}

func normalizeGateway(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.RawPath != "" {
		return "", errors.New("请提供不带账号、查询参数或片段的网关地址")
	}
	// Permit plaintext only to a literal loopback address (for local gateways/tests).
	if u.Scheme != "https" && !(u.Scheme == "http" && net.ParseIP(u.Hostname()).IsLoopback()) {
		return "", errors.New("网关必须使用 HTTPS（仅回环 IP 可使用 HTTP）")
	}
	u.Path = strings.TrimRight(u.Path, "/")
	u.Path = strings.TrimSuffix(strings.TrimSuffix(u.Path, "/v1/messages"), "/v1")
	return u.String(), nil
}

func newGateway(base, key string) *gateway {
	return &gateway{base: base, key: key, client: &http.Client{
		Timeout: 3 * time.Minute,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}}
}

func (g *gateway) ask(ctx context.Context, sessionID, model string, messages []message, readOnly bool) (reply, error) {
	payload := struct {
		Model     string     `json:"model"`
		MaxTokens int        `json:"max_tokens"`
		System    string     `json:"system"`
		Messages  []message  `json:"messages"`
		Tools     []toolSpec `json:"tools"`
		Stream    bool       `json:"stream"`
	}{model, 4096, systemPrompt, messages, tools(readOnly), false}
	var answer reply
	err := g.request(ctx, http.MethodPost, "/v1/messages", sessionID, payload, &answer)
	if err == nil && (len(answer.Content) == 0 || answer.StopReason == "") {
		err = errors.New("网关未返回可识别的模型消息")
	}
	return answer, err
}

func (g *gateway) check(ctx context.Context) (int, error) {
	var response struct {
		Data []json.RawMessage `json:"data"`
	}
	if err := g.request(ctx, http.MethodGet, "/v1/models", "", nil, &response); err != nil {
		return 0, err
	}
	if response.Data == nil {
		return 0, errors.New("网关未返回可识别的模型列表")
	}
	return len(response.Data), nil
}

func (g *gateway) request(ctx context.Context, method, path, sessionID string, payload any, dest any) error {
	var body io.Reader
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		if len(data) > 2<<20 {
			return errors.New("请求超过 2 MiB；请用 /new 清空上下文，或缩小读取范围")
		}
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, g.base+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+g.key)
	req.Header.Set("Anthropic-Version", "2023-06-01")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "claude-pro-lite/0.1")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if sessionID != "" {
		req.Header.Set("X-Claude-Code-Session-Id", sessionID)
	}
	res, err := g.client.Do(req)
	if err != nil {
		return fmt.Errorf("连接网关失败：%s", g.redact(err.Error()))
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return g.statusError(res)
	}
	const maxResponse = 2 << 20
	data, err := io.ReadAll(io.LimitReader(res.Body, maxResponse+1))
	if err != nil {
		return fmt.Errorf("读取网关响应失败：%s", g.redact(err.Error()))
	}
	if len(data) > maxResponse {
		return errors.New("网关响应超过 2 MiB，已停止")
	}
	if err := json.Unmarshal(data, dest); err != nil {
		return errors.New("网关返回的不是预期的 JSON；请检查网关地址和协议")
	}
	return nil
}

func (g *gateway) statusError(res *http.Response) error {
	status := res.StatusCode
	var hint string
	switch {
	case status >= 300 && status < 400:
		hint = "网关重定向已拒绝；请使用最终 HTTPS 地址"
	case status == 401 || status == 403:
		hint = "API Key 无效或无权使用此接口；要更换 Key，请运行 claude-pro-lite.exe -set-key"
	case status == 402:
		hint = "网关账户余额不足"
	case status == 429:
		hint = "网关限流，请稍后重试"
	case status == 404:
		hint = "请检查网关地址、接口和模型 ID"
	default:
		var response struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.NewDecoder(io.LimitReader(res.Body, 16<<10)).Decode(&response) == nil {
			runes := []rune(g.redact(response.Error.Message))
			if len(runes) > 250 {
				runes = runes[:250]
			}
			hint = strings.Join(strings.Fields(terminalText(string(runes))), " ")
		}
		if hint == "" {
			hint = "请求未成功"
		}
	}
	return fmt.Errorf("网关返回 HTTP %d：%s", status, hint)
}

func (g *gateway) redact(text string) string {
	return strings.ReplaceAll(text, g.key, "[REDACTED]")
}
