"""Token helpers - overload amendment coverage (no __all__: public = non-underscore)."""
from typing import overload


@overload
def parse(raw: str) -> int: ...
@overload
def parse(raw: bytes) -> int: ...
def parse(raw):
    return 0


def _internal() -> None:
    pass
