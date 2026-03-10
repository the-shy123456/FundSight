from __future__ import annotations


def normalize_name_display(name: str | None) -> str:
    if name is None:
        return ""
    return str(name).replace("发起式联接", "联接")


def attach_name_display(
    item: dict[str, object],
    *,
    name_key: str = "name",
    display_key: str = "name_display",
) -> dict[str, object]:
    next_item = dict(item)
    name_value = item.get(name_key)
    if name_value is None:
        return next_item
    next_item[display_key] = normalize_name_display(str(name_value))
    return next_item
