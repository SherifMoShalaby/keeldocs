import os
from fastapi import FastAPI
from .routers import items
from .routers.users import router as users_router

app = FastAPI(title="fixture")
app.include_router(items.router, prefix="/api")
app.include_router(users_router, prefix="/api/v1")

DEBUG = os.getenv("APP_DEBUG")
DB_URL = os.environ["DATABASE_URL"]


@app.get("/health")
def health() -> dict:
    return {"ok": True}
