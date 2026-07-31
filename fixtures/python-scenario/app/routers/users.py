import os
from fastapi import APIRouter

router = APIRouter()
PAGE_SIZE = int(os.environ.get("USERS_PAGE_SIZE", "50"))


@router.post("/users")
def create_user(name: str) -> dict:
    return {}
