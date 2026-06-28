"""File processing tools — extract structured text from uploaded files.

这是 server/tools/file_processor.py 的 Termux 友好版本：
把 PyMuPDF 换成纯 Python 的 pypdf，避免在 Termux/ARM 上长时间编译。

使用方式：
1. 用 requirements-termux.txt 安装依赖
2. 把本文件内容覆盖 server/tools/file_processor.py 中对应的 _process_pdf 函数
   （或者直接用本文件替换原文件）
"""
from __future__ import annotations
import csv
import io
import json
import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger("ds-mcp-bridge.file_processor")

MAX_TEXT_LENGTH = 100_000  # Truncate text beyond this
MAX_PREVIEW_LINES = 500


@dataclass
class FileResult:
    """Structured result from file processing."""
    filename: str
    mime_type: str
    file_size: int
    content_type: str  # "text", "pdf", "image", "unknown"
    text: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
    truncated: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "filename": self.filename,
            "mime_type": self.mime_type,
            "file_size": self.file_size,
            "content_type": self.content_type,
            "text": self.text,
            "metadata": self.metadata,
            "truncated": self.truncated,
        }


def _truncate(text: str, max_len: int = MAX_TEXT_LENGTH) -> tuple[str, bool]:
    if len(text) <= max_len:
        return text, False
    return text[:max_len] + f"\n\n... [截断: 原文 {len(text)} 字符，已截断至 {max_len}]", True


def _process_text(file_bytes: bytes, filename: str, mime_type: str) -> FileResult:
    """Process plain text / markdown / JSON / CSV files."""
    result = FileResult(filename=filename, mime_type=mime_type, file_size=len(file_bytes), content_type="text")
    try:
        text = file_bytes.decode("utf-8")
    except UnicodeDecodeError:
        try:
            text = file_bytes.decode("gbk")
        except UnicodeDecodeError:
            text = file_bytes.decode("latin-1")

    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

    if ext == "json" or mime_type == "application/json":
        try:
            parsed = json.loads(text)
            formatted = json.dumps(parsed, indent=2, ensure_ascii=False)
            text, result.truncated = _truncate(formatted)
            result.metadata["json_keys"] = (
                list(parsed.keys()) if isinstance(parsed, dict)
                else f"array[{len(parsed)}]" if isinstance(parsed, list)
                else type(parsed).__name__
            )
        except json.JSONDecodeError:
            text, result.truncated = _truncate(text)
    elif ext == "csv" or mime_type == "text/csv":
        reader = csv.reader(io.StringIO(text))
        rows = list(reader)
        result.metadata["rows"] = len(rows)
        result.metadata["columns"] = len(rows[0]) if rows else 0
        if rows:
            result.metadata["headers"] = rows[0]
        preview = rows[:MAX_PREVIEW_LINES]
        lines = [",".join(row) for row in preview]
        text = "\n".join(lines)
        if len(rows) > MAX_PREVIEW_LINES:
            text += f"\n\n... [截断: 共 {len(rows)} 行，显示前 {MAX_PREVIEW_LINES} 行]"
            result.truncated = True
    else:
        text, result.truncated = _truncate(text)

    result.text = text
    result.metadata["char_count"] = len(text)
    return result


def _process_pdf(file_bytes: bytes, filename: str, mime_type: str) -> FileResult:
    """Extract text from PDF using pypdf (pure Python, no compilation)."""
    result = FileResult(filename=filename, mime_type=mime_type, file_size=len(file_bytes), content_type="pdf")
    try:
        from pypdf import PdfReader
    except ImportError:
        result.text = "[错误] pypdf 未安装。运行: pip install pypdf"
        return result

    try:
        doc = PdfReader(io.BytesIO(file_bytes))
        result.metadata["page_count"] = len(doc.pages)
        pages_text = []
        for i, page in enumerate(doc.pages):
            page_text = page.extract_text() or ""
            if page_text.strip():
                pages_text.append(f"--- 第 {i + 1} 页 ---\n{page_text.strip()}")
        full_text = "\n\n".join(pages_text)
        result.text, result.truncated = _truncate(full_text)
        result.metadata["total_chars"] = len(full_text)
        result.metadata["pages_with_text"] = len(pages_text)
    except Exception as e:
        result.text = f"[错误] PDF 解析失败: {e}"
    return result


def _process_image(file_bytes: bytes, filename: str, mime_type: str) -> FileResult:
    """Return basic info about an image file."""
    result = FileResult(filename=filename, mime_type=mime_type, file_size=len(file_bytes), content_type="image")
    result.metadata["file_size_kb"] = round(len(file_bytes) / 1024, 1)
    result.text = f"[图片文件] {filename} ({result.metadata['file_size_kb']} KB)"
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(file_bytes))
        result.metadata["width"] = img.width
        result.metadata["height"] = img.height
        result.metadata["format"] = img.format
        result.text = f"[图片] {filename} — {img.width}x{img.height} {img.format or ''} ({result.metadata['file_size_kb']} KB)"
    except ImportError:
        pass
    except Exception as e:
        logger.warning(f"Image info extraction failed: {e}")
    return result


_MIME_MAP = {
    "text/plain": _process_text,
    "text/markdown": _process_text,
    "text/csv": _process_text,
    "application/json": _process_text,
    "text/x-python": _process_text,
    "text/javascript": _process_text,
    "text/html": _process_text,
    "text/css": _process_text,
    "application/pdf": _process_pdf,
    "image/png": _process_image,
    "image/jpeg": _process_image,
    "image/gif": _process_image,
    "image/webp": _process_image,
    "image/svg+xml": _process_text,
}

_TEXT_EXTENSIONS = {
    "txt", "md", "markdown", "json", "csv", "tsv", "py", "js", "ts",
    "jsx", "tsx", "html", "htm", "css", "scss", "less", "xml", "yaml",
    "yml", "toml", "ini", "cfg", "conf", "sh", "bash", "zsh", "fish",
    "bat", "cmd", "ps1", "sql", "r", "rb", "go", "rs", "java", "kt",
    "swift", "c", "cpp", "h", "hpp", "cs", "php", "lua", "dart",
    "vue", "svelte", "astro", "log", "env", "gitignore", "dockerfile",
    "makefile", "cmake", "gradle", "properties",
}

_IMAGE_EXTENSIONS = {"png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"}
_PDF_EXTENSIONS = {"pdf"}


def process_file(file_bytes: bytes, filename: str, mime_type: str = "") -> FileResult:
    """
    Process an uploaded file and return structured text content.
    Supports: TXT, MD, JSON, CSV, PDF (via pypdf), images (basic info).
    """
    if not file_bytes:
        return FileResult(filename=filename, mime_type=mime_type, file_size=0,
                          content_type="unknown", text="[错误] 文件为空")

    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    processor = _MIME_MAP.get(mime_type)
    if not processor:
        if ext in _TEXT_EXTENSIONS:
            processor = _process_text
        elif ext in _PDF_EXTENSIONS:
            processor = _process_pdf
        elif ext in _IMAGE_EXTENSIONS:
            processor = _process_image
        else:
            processor = _process_text

    logger.info(f"Processing file: {filename} ({mime_type}, {len(file_bytes)} bytes) → {processor.__name__}")
    return processor(file_bytes, filename, mime_type)


TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {
        "name": "process_file",
        "description": "处理上传的文件并提取结构化文本内容。支持 TXT、MD、JSON、CSV、PDF 和图片。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "filename": {"type": "string", "description": "文件名"},
                "file_size": {"type": "integer", "description": "文件大小（字节）"},
                "content_type": {"type": "string", "description": "文件内容类型提示"},
            },
            "required": ["filename"],
        },
    }
]
