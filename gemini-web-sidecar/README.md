# Gemini Web Sidecar

This directory holds the compiled binary for `gemini-web-to-api` acting as a native Sidecar for AIClient2API.

## Binary Naming Convention
- macOS (Apple Silicon): `gemini-web-sidecar-darwin-arm64`
- Linux (x86_64): `gemini-web-sidecar-linux-amd64`

## Build Command
From `https://github.com/ntthanh2603/gemini-web-to-api`:
```bash
# Darwin arm64
CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -ldflags="-s -w" -o gemini-web-sidecar-darwin-arm64 ./cmd/server

# Linux amd64
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o gemini-web-sidecar-linux-amd64 ./cmd/server
```
