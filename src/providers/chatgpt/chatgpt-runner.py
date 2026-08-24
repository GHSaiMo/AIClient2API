import os
import sys
import time
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

# Add chatgpt2api project directory to sys.path
CHATGPT2API_DIR = os.environ.get('CHATGPT2API_DIR', '/Users/hal9000/Projects/chatgpt2api')
if os.path.exists(CHATGPT2API_DIR) and CHATGPT2API_DIR not in sys.path:
    sys.path.insert(0, CHATGPT2API_DIR)

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import uvicorn

try:
    from services.openai_backend_api import OpenAIBackendAPI
    from services.protocol.conversation import (
        ConversationRequest,
        stream_image_outputs,
        collect_image_outputs,
        conversation_events
    )
    from services.account_service import AccountService
except ImportError as e:
    print(f"[ChatGPT Runner] Error importing chatgpt2api dependencies: {e}", file=sys.stderr)

app = FastAPI(title="ChatGPT-Web Core Bridge Service")

class UserInfoRequest(BaseModel):
    access_token: str
    proxy_url: Optional[str] = None

class RefreshTokenRequest(BaseModel):
    refresh_token: str
    proxy_url: Optional[str] = None

class ImageGenRequest(BaseModel):
    access_token: str
    prompt: str
    model: str = "gpt-image-2"
    proxy_url: Optional[str] = None
    response_format: str = "url"
    n: int = 1
    size: Optional[str] = None
    quality: str = "auto"
    base_url: Optional[str] = None
    references: Optional[List[Dict[str, Any]]] = None

class ChatConversationRequest(BaseModel):
    access_token: str
    prompt: str
    model: str = "auto"
    proxy_url: Optional[str] = None
    images: Optional[List[str]] = None

def get_backend(access_token: str, proxy_url: Optional[str] = None) -> OpenAIBackendAPI:
    backend = OpenAIBackendAPI(access_token=access_token)
    if proxy_url:
        backend.proxy = proxy_url
        backend.session.proxies = {'http': proxy_url, 'https': proxy_url}
    return backend

@app.get("/health")
def health():
    return {"status": "ok", "engine": "chatgpt2api-curl-cffi", "timestamp": int(time.time())}

@app.post("/user-info")
def get_user_info(req: UserInfoRequest):
    try:
        backend = get_backend(req.access_token, req.proxy_url)
        return backend.get_user_info()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/refresh-token")
def refresh_token(req: RefreshTokenRequest):
    try:
        acct = AccountService(storage=None)
        res = acct.refresh_oauth_token(req.refresh_token, proxy=req.proxy_url)
        return res
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/images/generations")
def generate_images(req: ImageGenRequest):
    try:
        backend = get_backend(req.access_token, req.proxy_url)
        conv_req = ConversationRequest(
            prompt=req.prompt,
            model=req.model,
            n=req.n,
            size=req.size,
            quality=req.quality,
            response_format=req.response_format,
            base_url=req.base_url or "",
            message_as_error=True
        )
        outputs = stream_image_outputs(backend, conv_req)
        result = collect_image_outputs(outputs)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/conversation")
def stream_conversation(req: ChatConversationRequest):
    try:
        backend = get_backend(req.access_token, req.proxy_url)
        
        def event_generator():
            for event in conversation_events(
                backend,
                prompt=req.prompt,
                model=req.model,
                images=req.images or []
            ):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(event_generator(), media_type="text/event-stream")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == '__main__':
    port = int(os.environ.get('CHATGPT_RUNNER_PORT', 9092))
    host = os.environ.get('CHATGPT_RUNNER_HOST', '127.0.0.1')
    print(f"[ChatGPT Runner] Starting server on {host}:{port} with chatgpt2api engine...", flush=True)
    uvicorn.run(app, host=host, port=port, log_level="warning")
