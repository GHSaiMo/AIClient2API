package main

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
)

func TestHealthEndpoint(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	handleHealth(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
}

func TestHTTP11ConnectionReuseAndHeaderStripping(t *testing.T) {
	var hits int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		if r.Header.Get("X-Target-Url") != "" || r.Header.Get("X-Forwarded-For") != "" {
			t.Errorf("proxy leaked internal/forwarded headers: %v", r.Header)
		}
		if r.Header.Get("Authorization") != "Bearer test-123" {
			t.Errorf("missing expected Authorization header")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("data: hello\n\n"))
	}))
	defer upstream.Close()

	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodPost, "/", nil)
			req.Header.Set("X-Target-Url", upstream.URL+"/v1/chat/completions")
			req.Header.Set("X-Forwarded-For", "1.2.3.4")
			req.Header.Set("Authorization", "Bearer test-123")
			rec := httptest.NewRecorder()
			handleProxy(rec, req)
			if rec.Code != http.StatusOK {
				t.Errorf("expected 200, got %d", rec.Code)
			}
		}()
	}
	wg.Wait()

	if atomic.LoadInt32(&hits) != 10 {
		t.Fatalf("expected 10 upstream hits, got %d", hits)
	}
}
