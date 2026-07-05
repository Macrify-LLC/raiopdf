"""OCRmyPDF progress plugin for RaioPDF."""

from __future__ import annotations

import json
import sys
from typing import Any

from ocrmypdf import hookimpl


PREFIX = "@@RAIOPDF_OCR_PROGRESS@@ "


def emit(payload: dict[str, Any]) -> None:
    sys.stderr.write(PREFIX)
    sys.stderr.write(json.dumps(payload, separators=(",", ":"), ensure_ascii=True))
    sys.stderr.write("\n")
    sys.stderr.flush()


class RaioPdfProgressBar:
    def __init__(
        self,
        *,
        total: float | int | None = None,
        desc: str | None = None,
        unit: str | None = None,
        disable: bool = False,
        **_: Any,
    ) -> None:
        self.total = normalize_total(total)
        self.description = desc or "OCR"
        self.unit = unit or "unit"
        self.disable = disable
        self.completed = 0.0
        if not self.disable:
            self._emit()

    def __enter__(self) -> "RaioPdfProgressBar":
        return self

    def __exit__(self, *_: Any) -> None:
        return None

    def update(self, n: float | int = 1, completed: float | int | None = None) -> None:
        if self.disable:
            return
        if completed is not None:
            self.completed = float(completed)
        else:
            self.completed += float(n)
        self._emit()

    def _emit(self) -> None:
        emit(
            {
                "phase": normalize_phase(self.description),
                "description": self.description,
                "completed": self.completed,
                "total": self.total,
                "unit": self.unit,
            }
        )


def normalize_phase(description: str) -> str:
    text = description.strip().lower()
    if "ocr" in text:
        return "ocr"
    if "pdf/a" in text or "conversion" in text:
        return "postprocess"
    if any(word in text for word in ("optimiz", "lineariz", "recompress", "deflat", "jbig2")):
        return "postprocess"
    return "processing"


def normalize_total(total: float | int | None) -> float | None:
    if total is None:
        return None
    value = float(total)
    return value if value > 0 else None


@hookimpl
def get_progressbar_class() -> type[RaioPdfProgressBar]:
    return RaioPdfProgressBar
