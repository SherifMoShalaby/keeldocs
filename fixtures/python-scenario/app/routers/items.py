from fastapi import APIRouter

router = APIRouter(prefix="/items")


@router.get("/")
def list_items(limit: int = 20) -> list:
    return []


@router.get("/{item_id}")
def get_item(item_id: int) -> dict:
    return {}


@router.api_route("/bulk", methods=["POST", "DELETE"])
def bulk(payload: dict) -> dict:
    return {}
