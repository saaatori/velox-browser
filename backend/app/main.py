import os
from datetime import UTC, datetime

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Velox AI Backend", version="0.1.0", description="Local AI services for Velox Browser.")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
async def health() -> dict[str, str]:
    return {
        "status": "ok",
        "service": "velox-ai-backend",
        "python": "3.13",
        "timestamp": datetime.now(UTC).isoformat(),
    }

@app.get("/api/meta")
async def meta() -> dict[str, str | None]:
    return {
        "name": "Velox Browser",
        "version": "0.1.0",
        "backend_port": os.getenv("VELOX_BACKEND_PORT"),
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.app.main:app", host="127.0.0.1", port=int(os.getenv("VELOX_BACKEND_PORT", "18765")))
