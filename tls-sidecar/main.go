package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	utls "github.com/refraction-networking/utls"
	"golang.org/x/net/http2"
	"golang.org/x/net/proxy"
)

// ──────────────────────────────────────────────
// TLS Sidecar — Go uTLS reverse proxy
//
// Node.js 发请求到 http://127.0.0.1:<port>，
// 通过以下自定义 Header 传递目标信息：
//   X-Target-Url:   实际目标 URL（必填）
//   X-Proxy-Url:    上游代理（可选，支持 http/socks5）
//
// 所有其他 Header 原样转发给目标服务器。
// 响应（包括 SSE 流式）透传回 Node.js。
//
// uTLS 使用 Chrome 最新指纹，ALPN 协商 h2/http1.1，
// 根据服务器返回的 ALPN 自动选择 HTTP/2 或 HTTP/1.1 传输。
// ──────────────────────────────────────────────

const (
	defaultPort       = 9090
	headerTarget      = "X-Target-Url"
	headerProxy       = "X-Proxy-Url"
	readHeaderTimeout = 15 * time.Second
	writeTimeout      = 0 // SSE 流式响应不设写超时（仅监听 localhost，安全）
	idleTimeout       = 120 * time.Second
	maxH2ConnsPerHost = 4
)

// 32KB 流式转发缓冲池，消除每请求堆内存分配
var streamBufPool = sync.Pool{
	New: func() any {
		b := make([]byte, 32*1024)
		return &b
	},
}

// 全局 RoundTripper 缓存（按 proxyURL 分组，复用 H2 与 H1 连接池）
var (
	rtCacheMu sync.Mutex
	rtCache   = make(map[string]*utlsRoundTripper)
)

func getOrCreateRT(proxyURL string) *utlsRoundTripper {
	rtCacheMu.Lock()
	defer rtCacheMu.Unlock()
	if rt, ok := rtCache[proxyURL]; ok {
		return rt
	}
	rt := newUTLSRoundTripper(proxyURL)
	rtCache[proxyURL] = rt
	return rt
}

func closeAllRoundTrippers() {
	rtCacheMu.Lock()
	defer rtCacheMu.Unlock()
	for _, rt := range rtCache {
		rt.CloseIdleConnections()
	}
}

type preDialedConnHolder struct {
	mu   sync.Mutex
	conn net.Conn
}

func (h *preDialedConnHolder) take() net.Conn {
	h.mu.Lock()
	defer h.mu.Unlock()
	c := h.conn
	h.conn = nil
	return c
}

type preDialedConnKey struct{}

type h2DialCall struct {
	done chan struct{}
	cc   *http2.ClientConn
	isH1 bool
	err  error
}

// ──────────────── uTLS RoundTripper ────────────────
// 根据 ALPN 协商结果自动选择 H2 多连接池或共享 H1 Keep-Alive 连接池，带并发建连 Singleflight 防惊群

type utlsRoundTripper struct {
	proxyURL    string
	h2Transport *http2.Transport
	h1Transport *http.Transport

	mu       sync.Mutex
	h2Conns  map[string][]*http2.ClientConn // H2 多连接池 (per host)
	h1Hosts  map[string]bool                // 已确认为 HTTP/1.1 的 host 缓存
	inflight map[string]*h2DialCall         // Singleflight 并发握手合并
}

func newUTLSRoundTripper(proxyURL string) *utlsRoundTripper {
	rt := &utlsRoundTripper{
		proxyURL: proxyURL,
		h2Transport: &http2.Transport{
			StrictMaxConcurrentStreams: true,
			AllowHTTP:                  false,
			ReadIdleTimeout:            45 * time.Second,
			PingTimeout:                15 * time.Second,
		},
		h2Conns:  make(map[string][]*http2.ClientConn),
		h1Hosts:  make(map[string]bool),
		inflight: make(map[string]*h2DialCall),
	}

	rt.h1Transport = &http.Transport{
		DialTLSContext: func(ctx context.Context, network, a string) (net.Conn, error) {
			if holder, ok := ctx.Value(preDialedConnKey{}).(*preDialedConnHolder); ok && holder != nil {
				if c := holder.take(); c != nil {
					return c, nil
				}
			}
			return dialUTLS(ctx, network, a, rt.proxyURL, []string{"http/1.1"})
		},
		DialContext: func(ctx context.Context, network, a string) (net.Conn, error) {
			if rt.proxyURL != "" {
				return dialViaProxy(ctx, network, a, rt.proxyURL)
			}
			var d net.Dialer
			return d.DialContext(ctx, network, a)
		},
		MaxIdleConns:          128,
		MaxIdleConnsPerHost:   16,
		IdleConnTimeout:       90 * time.Second,
		ResponseHeaderTimeout: 0,
	}

	return rt
}

func (rt *utlsRoundTripper) pickH2ConnLocked(addr string) *http2.ClientConn {
	conns := rt.h2Conns[addr]
	if len(conns) == 0 {
		return nil
	}
	alive := conns[:0]
	var chosen *http2.ClientConn
	for _, cc := range conns {
		st := cc.State()
		if st.Closed || st.Closing {
			continue
		}
		alive = append(alive, cc)
		if chosen == nil && cc.CanTakeNewRequest() {
			chosen = cc
		}
	}
	if len(alive) == 0 {
		delete(rt.h2Conns, addr)
	} else {
		rt.h2Conns[addr] = alive
	}
	return chosen
}

func (rt *utlsRoundTripper) removeH2Conn(addr string, target *http2.ClientConn) {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	conns := rt.h2Conns[addr]
	if len(conns) == 0 {
		return
	}
	alive := conns[:0]
	for _, cc := range conns {
		if cc != target {
			alive = append(alive, cc)
		}
	}
	if len(alive) == 0 {
		delete(rt.h2Conns, addr)
	} else {
		rt.h2Conns[addr] = alive
	}
}

func (rt *utlsRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	// 纯明文 HTTP 请求直接走共享 H1 连接池
	if req.URL.Scheme != "https" {
		return rt.h1Transport.RoundTrip(req)
	}

	addr := req.URL.Host
	if !strings.Contains(addr, ":") {
		addr += ":443"
	}

	rt.mu.Lock()
	// 1. 尝试复用已有可用 H2 连接
	if cc := rt.pickH2ConnLocked(addr); cc != nil {
		rt.mu.Unlock()
		resp, err := cc.RoundTrip(req)
		if err == nil {
			return resp, nil
		}
		log.Printf("[TLS-Sidecar] Cached H2 conn failed for %s: %v", addr, err)
		rt.removeH2Conn(addr, cc)
		// 若请求体已被消费且不可重放，直接返回错误交给上层处理
		if req.Body != nil && req.Body != http.NoBody && req.GetBody == nil {
			return nil, err
		}
		rt.mu.Lock()
	}

	// 2. 若该 Host 已确认为 HTTP/1.1，直接走共享 H1 Keep-Alive 连接池
	if rt.h1Hosts[addr] && len(rt.h2Conns[addr]) == 0 {
		rt.mu.Unlock()
		return rt.h1Transport.RoundTrip(req)
	}

	// 3. Singleflight 合并冷启动/重连时的并发握手，杜绝并发拨号惊群（仅当当前无满载 H2 连接或正在建连时合并）
	if call, waiting := rt.inflight[addr]; waiting {
		rt.mu.Unlock()
		select {
		case <-call.done:
		case <-req.Context().Done():
			return nil, req.Context().Err()
		}
		if call.err != nil {
			return nil, call.err
		}
		if call.isH1 {
			return rt.h1Transport.RoundTrip(req)
		}
		if call.cc != nil && call.cc.CanTakeNewRequest() {
			return call.cc.RoundTrip(req)
		}
		// 若共享连接瞬间打满并发流，继续向下独立建连扩容
		rt.mu.Lock()
	}

	call := &h2DialCall{done: make(chan struct{})}
	rt.inflight[addr] = call
	rt.mu.Unlock()

	// 使用独立超时 Context 完成握手，避免首个请求取消导致同批等待的并发请求集体失败
	dialCtx, cancelDial := context.WithTimeout(context.Background(), 20*time.Second)
	conn, dialErr := dialUTLS(dialCtx, "tcp", addr, rt.proxyURL, []string{"h2", "http/1.1"})
	cancelDial()

	if dialErr != nil {
		rt.mu.Lock()
		call.err = dialErr
		delete(rt.inflight, addr)
		close(call.done)
		rt.mu.Unlock()
		return nil, dialErr
	}

	alpn := conn.ConnectionState().NegotiatedProtocol
	log.Printf("[TLS-Sidecar] Connected to %s, ALPN: %q", addr, alpn)

	if alpn == "h2" {
		cc, h2Err := rt.h2Transport.NewClientConn(conn)
		if h2Err != nil {
			conn.Close()
			wrappedErr := fmt.Errorf("h2 client conn: %w", h2Err)
			rt.mu.Lock()
			call.err = wrappedErr
			delete(rt.inflight, addr)
			close(call.done)
			rt.mu.Unlock()
			return nil, wrappedErr
		}

		rt.mu.Lock()
		delete(rt.h1Hosts, addr)
		conns := rt.h2Conns[addr]
		if len(conns) < maxH2ConnsPerHost {
			rt.h2Conns[addr] = append(conns, cc)
		}
		call.cc = cc
		delete(rt.inflight, addr)
		close(call.done)
		rt.mu.Unlock()

		return cc.RoundTrip(req)
	}

	// HTTP/1.1：标记 Host 并通过 Context 将已握手连接无损移交给共享 h1Transport 连接池复用
	rt.mu.Lock()
	rt.h1Hosts[addr] = true
	call.isH1 = true
	delete(rt.inflight, addr)
	close(call.done)
	rt.mu.Unlock()

	holder := &preDialedConnHolder{conn: conn}
	reqWithConn := req.WithContext(context.WithValue(req.Context(), preDialedConnKey{}, holder))
	resp, err := rt.h1Transport.RoundTrip(reqWithConn)
	if leftover := holder.take(); leftover != nil {
		// 若 h1Transport 复用了池中其它空闲连接而未消费本次预拨号连接，安全关闭避免泄漏
		leftover.Close()
	}
	return resp, err
}

func (rt *utlsRoundTripper) CloseIdleConnections() {
	rt.mu.Lock()
	for k, conns := range rt.h2Conns {
		for _, cc := range conns {
			cc.Close()
		}
		delete(rt.h2Conns, k)
	}
	rt.mu.Unlock()
	rt.h1Transport.CloseIdleConnections()
}

// ──────────────── Main ────────────────

func main() {
	// 强制将日志输出到 Stdout，避免 Node.js 侧将其误判为 Error
	log.SetOutput(os.Stdout)

	port := defaultPort
	if p := os.Getenv("TLS_SIDECAR_PORT"); p != "" {
		if v, err := strconv.Atoi(p); err == nil {
			port = v
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/", handleProxy)

	srv := &http.Server{
		Addr:              fmt.Sprintf("127.0.0.1:%d", port),
		Handler:           mux,
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       0, // 允许大体积图片/长上下文流式上传，仅限制 Header 读取超时防慢速攻击
		WriteTimeout:      writeTimeout,
		IdleTimeout:       idleTimeout,
	}

	// Graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		log.Println("[TLS-Sidecar] Shutting down...")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
		closeAllRoundTrippers()
	}()

	log.Printf("[TLS-Sidecar] Listening on 127.0.0.1:%d (Chrome uTLS, H2+H1 pooled)\n", port)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("[TLS-Sidecar] Fatal: %v", err)
	}
}

// ──────────────── Health ────────────────

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(200)
	fmt.Fprintf(w, `{"status":"ok","tls":"utls-chrome-auto","protocols":"h2,http/1.1"}`)
}

// ──────────────── Proxy Handler ────────────────

func handleProxy(w http.ResponseWriter, r *http.Request) {
	targetURL := r.Header.Get(headerTarget)
	if targetURL == "" {
		http.Error(w, `{"error":"missing X-Target-Url header"}`, http.StatusBadRequest)
		return
	}

	proxyURL := r.Header.Get(headerProxy)

	// Parse target
	parsed, err := url.Parse(targetURL)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"invalid target url: %s"}`, err), http.StatusBadRequest)
		return
	}

	// Build outgoing request
	outReq, err := http.NewRequestWithContext(r.Context(), r.Method, targetURL, r.Body)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"failed to create request: %s"}`, err), http.StatusInternalServerError)
		return
	}

	// Copy headers (skip internal + hop-by-hop)
	// 403 关键修复：彻底清理所有非浏览器标头，严格保持小写
	for key, vals := range r.Header {
		lk := strings.ToLower(key)
		if lk == strings.ToLower(headerTarget) || lk == strings.ToLower(headerProxy) {
			continue
		}
		// 移除所有代理、本地网络特征标头，防止 Cloudflare 识别
		if lk == "connection" || lk == "keep-alive" || lk == "transfer-encoding" ||
			lk == "te" || lk == "trailer" || lk == "upgrade" || lk == "host" ||
			lk == "x-forwarded-for" || lk == "x-real-ip" || lk == "x-forwarded-proto" ||
			lk == "x-forwarded-host" || lk == "via" || lk == "proxy-connection" ||
			lk == "cf-connecting-ip" || lk == "true-client-ip" {
			continue
		}
		// 直接通过 map 赋值，确保 Go 的 http2 栈能识别并以原始（小写）形式发出
		outReq.Header[key] = vals
	}
	outReq.Host = parsed.Host

	// 针对 Grok 的特殊处理：如果 Accept-Encoding 包含 br 且环境可能存在压缩协商问题
	// 强制设置为标准的浏览器组合
	if ae := outReq.Header["Accept-Encoding"]; len(ae) > 0 {
		outReq.Header["Accept-Encoding"] = []string{"gzip, deflate, br, zstd"}
	}

	// Execute via uTLS RoundTripper
	rt := getOrCreateRT(proxyURL)
	resp, err := rt.RoundTrip(outReq)
	if err != nil {
		if r.Context().Err() != nil {
			// 客户端主动取消连接，无需刷屏上游错误
			return
		}
		log.Printf("[TLS-Sidecar] RoundTrip error → %s: %v", parsed.Host, err)
		http.Error(w, fmt.Sprintf(`{"error":"upstream request failed: %s"}`, err), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Copy response headers
	for key, vals := range resp.Header {
		for _, v := range vals {
			w.Header().Add(key, v)
		}
	}
	w.WriteHeader(resp.StatusCode)

	// Stream body (SSE-friendly: flush after every read, reusing 32KB pooled buffer)
	flusher, canFlush := w.(http.Flusher)
	bufPtr := streamBufPool.Get().(*[]byte)
	buf := *bufPtr
	defer streamBufPool.Put(bufPtr)

	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, writeErr := w.Write(buf[:n]); writeErr != nil {
				if r.Context().Err() == nil {
					log.Printf("[TLS-Sidecar] Write error: %v", writeErr)
				}
				return
			}
			if canFlush {
				flusher.Flush()
			}
		}
		if readErr != nil {
			if readErr != io.EOF && r.Context().Err() == nil {
				log.Printf("[TLS-Sidecar] Read error: %v", readErr)
			}
			return
		}
	}
}

// ──────────────── uTLS Dial ────────────────

func dialUTLS(ctx context.Context, network, addr string, proxyURL string, nextProtos []string) (*utls.UConn, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}

	// TCP 连接（可能经过代理）
	var rawConn net.Conn
	if proxyURL != "" {
		rawConn, err = dialViaProxy(ctx, network, addr, proxyURL)
	} else {
		d := net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
		rawConn, err = d.DialContext(ctx, network, addr)
	}
	if err != nil {
		return nil, fmt.Errorf("tcp dial failed: %w", err)
	}

	if len(nextProtos) == 0 {
		nextProtos = []string{"h2", "http/1.1"}
	}

	// uTLS 握手 — 使用 Chrome 最新自动指纹
	tlsConn := utls.UClient(rawConn, &utls.Config{
		ServerName: host,
		NextProtos: nextProtos,
	}, utls.HelloChrome_Auto)

	// 握手超时
	if deadline, ok := ctx.Deadline(); ok {
		_ = tlsConn.SetDeadline(deadline)
	} else {
		_ = tlsConn.SetDeadline(time.Now().Add(15 * time.Second))
	}

	if err := tlsConn.HandshakeContext(ctx); err != nil {
		rawConn.Close()
		return nil, fmt.Errorf("utls handshake failed: %w", err)
	}

	// 握手完成，清除超时
	_ = tlsConn.SetDeadline(time.Time{})
	return tlsConn, nil
}

// ──────────────── Proxy Dialer ────────────────

func dialViaProxy(ctx context.Context, network, addr string, proxyURL string) (net.Conn, error) {
	parsed, err := url.Parse(proxyURL)
	if err != nil {
		return nil, fmt.Errorf("invalid proxy url: %w", err)
	}

	switch strings.ToLower(parsed.Scheme) {
	case "socks5", "socks5h", "socks4", "socks":
		var auth *proxy.Auth
		if parsed.User != nil {
			auth = &proxy.Auth{
				User: parsed.User.Username(),
			}
			auth.Password, _ = parsed.User.Password()
		}
		dialer, err := proxy.SOCKS5("tcp", parsed.Host, auth, &net.Dialer{
			Timeout:   15 * time.Second,
			KeepAlive: 30 * time.Second,
		})
		if err != nil {
			return nil, fmt.Errorf("socks5 dialer: %w", err)
		}
		if ctxDialer, ok := dialer.(proxy.ContextDialer); ok {
			return ctxDialer.DialContext(ctx, network, addr)
		}
		return dialer.Dial(network, addr)

	case "http", "https":
		dialer := net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
		proxyConn, err := dialer.DialContext(ctx, "tcp", parsed.Host)
		if err != nil {
			return nil, fmt.Errorf("connect to http proxy: %w", err)
		}

		if deadline, ok := ctx.Deadline(); ok {
			_ = proxyConn.SetDeadline(deadline)
		} else {
			_ = proxyConn.SetDeadline(time.Now().Add(15 * time.Second))
		}

		connectReq := fmt.Sprintf("CONNECT %s HTTP/1.1\r\nHost: %s\r\n", addr, addr)
		if parsed.User != nil {
			username := parsed.User.Username()
			password, _ := parsed.User.Password()
			cred := base64.StdEncoding.EncodeToString([]byte(username + ":" + password))
			connectReq += fmt.Sprintf("Proxy-Authorization: Basic %s\r\n", cred)
		}
		connectReq += "\r\n"

		if _, err = proxyConn.Write([]byte(connectReq)); err != nil {
			proxyConn.Close()
			return nil, fmt.Errorf("proxy CONNECT write: %w", err)
		}

		// 精确读取至 \r\n\r\n 结束符，防止粘包预读吞掉后续 TLS 握手字节
		var hdrBuf bytes.Buffer
		oneByte := make([]byte, 1)
		for hdrBuf.Len() < 8192 {
			_, err = proxyConn.Read(oneByte)
			if err != nil {
				proxyConn.Close()
				return nil, fmt.Errorf("proxy CONNECT read: %w", err)
			}
			hdrBuf.WriteByte(oneByte[0])
			if bytes.HasSuffix(hdrBuf.Bytes(), []byte("\r\n\r\n")) {
				break
			}
		}

		respHeader := hdrBuf.String()
		firstLineEnd := strings.Index(respHeader, "\r\n")
		statusLine := respHeader
		if firstLineEnd != -1 {
			statusLine = respHeader[:firstLineEnd]
		}
		if !strings.Contains(statusLine, " 200") {
			proxyConn.Close()
			return nil, fmt.Errorf("proxy CONNECT rejected: %s", strings.TrimSpace(statusLine))
		}

		_ = proxyConn.SetDeadline(time.Time{})
		return proxyConn, nil

	default:
		return nil, fmt.Errorf("unsupported proxy scheme: %s", parsed.Scheme)
	}
}
