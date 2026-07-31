"""The SAME surface as app.js, on purpose - see app.js."""
from fastapi import FastAPI

app = FastAPI(title="polyglot")


@app.get("/health")
def health() -> dict:
    return {"ok": True}
