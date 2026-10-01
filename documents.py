"""
documents.py -- local extraction of PDF / DOC / DOCX / TXT / CSV into
ContentItem objects.

    PDF   PyMuPDF text per page, OCR fallback for scanned pages, page_number kept
    DOCX  python-docx paragraphs + tables, section kept (never a page number)
    DOC   LibreOffice headless -> DOCX -> the DOCX path above
    TXT   read and chunk
    CSV   pandas, one searchable row representation per row, row_index kept

Nothing here touches the network.
"""
from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
from pathlib import Path

from config import settings
from schemas import (
    ContentItem,
    ErrorCode,
    IngestionResult,
    Modality,
    Relationship,
    RelationshipType,
    Source,
    SourceLocation,
    SourceType,
    content_hash,
    derive_id,
)

logger = logging.getLogger(__name__)

EXTENSION_TO_TYPE = {
    ".pdf": SourceType.PDF,
    ".doc": SourceType.DOC,
    ".docx": SourceType.DOCX,
    ".txt": SourceType.TXT,
    ".md": SourceType.TXT,
    ".csv": SourceType.CSV,
}

# A page yielding fewer characters than this is treated as scanned and
# routed through OCR instead of being indexed as an empty page.
MIN_PAGE_CHARS_BEFORE_OCR = 80


# ---------------------------------------------------------------------------
# Chunking
# ---------------------------------------------------------------------------

def chunk_text(
    text: str,
    chunk_size: int | None = None,
    overlap: int | None = None,
) -> list[str]:
    """Split on a character window with overlap, preferring to break at a
    sentence or whitespace boundary so chunks stay readable as citations."""
    size = chunk_size or settings.chunk_size
    over = overlap if overlap is not None else settings.chunk_overlap
    text = " ".join(text.split())
    if not text:
        return []
    if len(text) <= size:
        return [text]

    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = min(start + size, len(text))
        if end < len(text):
            window = text[start:end]
            # Prefer a sentence end, then any whitespace, in the last 30%.
            pivot = max(window.rfind(". "), window.rfind("! "), window.rfind("? "))
            if pivot < size * 0.7:
                pivot = window.rfind(" ")
            if pivot > size * 0.5:
                end = start + pivot + 1
        chunk = text[start:end].strip()
        if len(chunk) >= settings.min_chunk_chars or not chunks:
            chunks.append(chunk)
        if end >= len(text):
            break
        start = max(end - over, start + 1)
    return chunks


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------

def resolve_source_type(path: Path) -> SourceType:
    return EXTENSION_TO_TYPE.get(path.suffix.lower(), SourceType.UNKNOWN)


def _validate(path_str: str) -> tuple[Path, SourceType]:
    path = Path(path_str).resolve()
    if not path.exists() or not path.is_file():
        raise FileNotFoundError(f"{ErrorCode.FILE_NOT_FOUND.value}: {path_str}")
    if path.stat().st_size > settings.max_file_bytes:
        raise ValueError(f"{ErrorCode.FILE_TOO_LARGE.value}: {path.name}")
    source_type = resolve_source_type(path)
    if source_type is SourceType.UNKNOWN:
        raise ValueError(f"{ErrorCode.UNSUPPORTED_FILE_TYPE.value}: {path.suffix}")
    return path, source_type


def _build_source(path: Path, source_type: SourceType) -> Source:
    data = path.read_bytes()
    return Source(
        source_id=content_hash(data),
        filename=path.name,
        source_type=source_type,
        file_path=str(path),
        mime_type=_mime_for(source_type),
        file_size=len(data),
    )


def _mime_for(source_type: SourceType) -> str:
    return {
        SourceType.PDF: "application/pdf",
        SourceType.DOC: "application/msword",
        SourceType.DOCX: (
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        ),
        SourceType.TXT: "text/plain",
        SourceType.CSV: "text/csv",
    }.get(source_type, "application/octet-stream")


# ---------------------------------------------------------------------------
# Per-format extraction -> list of (text, SourceLocation, extra_metadata)
# ---------------------------------------------------------------------------

Extracted = tuple[str, SourceLocation, dict]


def classify_pdf(path: Path) -> dict:
    """Analyze PDF structure: clean text, scanned, or image/table-heavy, as per architecture."""
    import pymupdf

    info = {
        "pages": 0,
        "has_images": False,
        "image_count": 0,
        "is_scanned": False,
        "has_tables": False,
        "category": "clean_text",
    }
    with pymupdf.open(path) as doc:
        info["pages"] = len(doc)
        total_images = sum(len(page.get_images()) for page in doc)
        info["image_count"] = total_images
        info["has_images"] = total_images > 0

        total_chars = sum(len(page.get_text("text").strip()) for page in doc)
        avg_chars = total_chars / max(1, len(doc))
        info["is_scanned"] = avg_chars < MIN_PAGE_CHARS_BEFORE_OCR

        try:
            for page in doc:
                tables = page.find_tables()
                if tables and len(tables.tables) > 0:
                    info["has_tables"] = True
                    break
        except Exception:
            pass

    if info["has_images"]:
        info["category"] = "has_images"
    elif info["is_scanned"]:
        info["category"] = "scanned"
    elif info["has_tables"]:
        info["category"] = "table_heavy"
    else:
        info["category"] = "clean_text"

    return info


def _extract_with_docling(path: Path, warnings: list[str], info: dict) -> list[Extracted]:
    """Extract complex PDFs with embedded images, scanned pages, or structured tables using Docling."""
    try:
        from docling.document_converter import DocumentConverter
        from docling_core.types.doc import TableItem, PictureItem
    except ImportError as e:
        warnings.append(f"Docling not available: {e}")
        return []

    logger.info(
        "Extracting %s with Docling (images: %d, tables: %s, category: %s)",
        path.name, info["image_count"], info["has_tables"], info["category"],
    )
    converter = DocumentConverter()
    conv_res = converter.convert(str(path))
    doc = conv_res.document

    pages_items: dict[int, list[tuple[str, dict]]] = {}
    for item, _level in doc.iterate_items():
        page = item.prov[0].page_no if (hasattr(item, "prov") and item.prov) else 1
        is_table = isinstance(item, TableItem)
        is_picture = isinstance(item, PictureItem)

        if is_table:
            text = item.export_to_markdown(doc=doc).strip()
        elif hasattr(item, "text"):
            text = item.text.strip()
        elif is_picture and hasattr(item, "caption") and item.caption:
            text = f"[Figure on Page {page}: {item.caption.text.strip()}]"
        else:
            text = ""

        if text:
            pages_items.setdefault(page, []).append((
                text,
                {"is_table": is_table, "has_image": is_picture or info["has_images"]},
            ))

    out: list[Extracted] = []
    for page_no in sorted(pages_items.keys()):
        items_on_page = pages_items[page_no]
        current_text_buf: list[str] = []
        for text, meta in items_on_page:
            if meta.get("is_table"):
                if current_text_buf:
                    combined = " ".join(current_text_buf)
                    for chunk in chunk_text(combined):
                        out.append((
                            chunk,
                            SourceLocation(page_number=page_no),
                            {
                                "page": page_no,
                                "page_number": page_no,
                                "extractor": "docling",
                                "has_images": info["has_images"],
                            },
                        ))
                    current_text_buf.clear()
                # Tables stay intact as dedicated searchable chunks
                out.append((
                    text,
                    SourceLocation(page_number=page_no, section="Table"),
                    {
                        "page": page_no,
                        "page_number": page_no,
                        "is_table": True,
                        "extractor": "docling",
                        "has_images": info["has_images"],
                    },
                ))
            else:
                current_text_buf.append(text)

        if current_text_buf:
            combined = " ".join(current_text_buf)
            for chunk in chunk_text(combined):
                out.append((
                    chunk,
                    SourceLocation(page_number=page_no),
                    {
                        "page": page_no,
                        "page_number": page_no,
                        "extractor": "docling",
                        "has_images": info["has_images"],
                    },
                ))

    return out


def _extract_pdf_standard(path: Path, warnings: list[str]) -> list[Extracted]:
    """Standard fast PyMuPDF extraction for clean digital text PDFs."""
    import pymupdf

    out: list[Extracted] = []
    with pymupdf.open(path) as doc:
        for page_index, page in enumerate(doc, start=1):
            text = page.get_text("text").strip()
            ocr_used = False

            if len(text) < MIN_PAGE_CHARS_BEFORE_OCR:
                ocr_text = _ocr_pdf_page(page, warnings, page_index)
                if len(ocr_text) > len(text):
                    text, ocr_used = ocr_text, True
            else:
                # If page has text but also has images, OCR those images specifically
                image_list = page.get_images(full=True)
                for img in image_list:
                    try:
                        xref = img[0]
                        pix = pymupdf.Pixmap(doc, xref)
                        if pix.n - pix.alpha > 3:
                            pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
                        import io
                        from PIL import Image
                        import pytesseract
                        pytesseract.pytesseract.tesseract_cmd = settings.tesseract_cmd
                        img_pil = Image.open(io.BytesIO(pix.tobytes("png")))
                        img_text = pytesseract.image_to_string(img_pil).strip()
                        if img_text:
                            text += f"\n\n[Image Text]: {img_text}"
                    except Exception as e:
                        pass

            if not text:
                continue
            for chunk_idx, chunk in enumerate(chunk_text(text), start=1):
                out.append((
                    chunk,
                    SourceLocation(page_number=page_index),
                    {
                        "page": page_index,
                        "page_number": page_index,
                        "chunk_in_page": chunk_idx,
                        "ocr_used": ocr_used,
                        "extractor": "pymupdf",
                    },
                ))
    return out


def _extract_pdf(path: Path, warnings: list[str]) -> list[Extracted]:
    """Classify PDF and route:
    - Use fast PyMuPDF extraction for maximum speed
    """
    return _extract_pdf_standard(path, warnings)


def _ocr_pdf_page(page, warnings: list[str], page_index: int) -> str:
    """Rasterise one PDF page and OCR it. Returns '' on any failure -- a
    scanned page we cannot read is skipped, never fabricated."""
    try:
        import io

        import pytesseract
        from PIL import Image

        pytesseract.pytesseract.tesseract_cmd = settings.tesseract_cmd
        pixmap = page.get_pixmap(dpi=200)
        image = Image.open(io.BytesIO(pixmap.tobytes("png")))
        return pytesseract.image_to_string(image).strip()
    except Exception as exc:
        warnings.append(f"OCR failed on page {page_index}: {exc}")
        logger.warning("PDF OCR failed on page %s: %s", page_index, exc)
        return ""


def _extract_docx(path: Path, warnings: list[str]) -> list[Extracted]:
    """Extract paragraphs and tables from DOCX. Estimates page numbers (~400 words
    per page) and keeps section headings so chunks carry both page and section."""
    import docx

    document = docx.Document(str(path))
    out: list[Extracted] = []
    current_section = "Document body"
    current_page = 1
    page_words = 0
    buffer: list[str] = []

    def flush() -> None:
        nonlocal page_words, current_page
        if not buffer:
            return
        joined = " ".join(buffer)
        for chunk in chunk_text(joined):
            out.append((
                chunk,
                SourceLocation(page_number=current_page, section=current_section),
                {
                    "page": current_page,
                    "page_number": current_page,
                    "section": current_section,
                },
            ))
        buffer.clear()

    for para in document.paragraphs:
        text = para.text.strip()
        if not text:
            continue
        words = len(text.split())
        page_words += words
        if page_words >= 450:
            flush()
            current_page += 1
            page_words = 0

        if para.style is not None and para.style.name.lower().startswith("heading"):
            flush()
            current_section = text
            continue
        buffer.append(text)
    flush()

    for table_index, table in enumerate(document.tables, start=1):
        rows: list[str] = []
        for row in table.rows:
            cells = [c.text.strip() for c in row.cells]
            if any(cells):
                rows.append(" | ".join(cells))
        if not rows:
            continue
        table_text = f"Table {table_index}: " + "; ".join(rows)
        for chunk in chunk_text(table_text):
            out.append((
                chunk,
                SourceLocation(page_number=current_page, section=f"Table {table_index}"),
                {
                    "page": current_page,
                    "page_number": current_page,
                    "section": f"Table {table_index}",
                    "is_table": True,
                },
            ))
    return out


def _convert_doc_to_docx(path: Path) -> Path:
    """LibreOffice headless conversion. Raises if LibreOffice is absent --
    we never pretend .doc was read."""
    soffice = settings.soffice_cmd
    if not Path(soffice).exists():
        found = shutil.which("soffice")
        if not found:
            raise RuntimeError(
                f"{ErrorCode.CONVERSION_UNAVAILABLE.value}: LibreOffice not found. "
                "Install it to enable legacy .doc support."
            )
        soffice = found

    tmpdir = Path(tempfile.mkdtemp(prefix="evidenceai_doc_"))
    # An isolated user profile lets conversion work even while the user has
    # LibreOffice open; without it the second instance refuses to start.
    # stdin is closed because soffice waits on console input when attached.
    profile = (tmpdir / "profile").as_uri()
    proc = subprocess.run(
        [soffice, "--headless", "--norestore", "--invisible",
         f"-env:UserInstallation={profile}",
         "--convert-to", "docx", "--outdir", str(tmpdir), str(path)],
        capture_output=True,
        text=True,
        timeout=180,
        stdin=subprocess.DEVNULL,
    )
    converted = tmpdir / (path.stem + ".docx")
    if not converted.exists():
        raise RuntimeError(
            f"{ErrorCode.CONVERSION_UNAVAILABLE.value}: LibreOffice conversion "
            f"produced no output. stderr={proc.stderr[:300]}"
        )
    return converted


def _extract_txt(path: Path, warnings: list[str]) -> list[Extracted]:
    text = path.read_text(encoding="utf-8", errors="replace")
    return [(chunk, SourceLocation(), {}) for chunk in chunk_text(text)]


def _extract_csv(path: Path, warnings: list[str]) -> list[Extracted]:
    """Each row becomes one searchable 'column: value' sentence, which
    embeds far better than a raw comma-separated line."""
    import pandas as pd

    frame = pd.read_csv(path)
    columns = [str(c) for c in frame.columns]
    out: list[Extracted] = []
    for row_index, row in frame.iterrows():
        parts = [
            f"{col}: {row[col]}"
            for col in columns
            if str(row[col]).strip() not in ("", "nan", "None")
        ]
        if not parts:
            continue
        text = f"Row {int(row_index) + 1} -- " + "; ".join(parts)
        out.append((
            text,
            SourceLocation(section=f"Row {int(row_index) + 1}"),
            {"row_index": int(row_index)},
        ))
    return out


EXTRACTORS = {
    SourceType.PDF: _extract_pdf,
    SourceType.DOCX: _extract_docx,
    SourceType.TXT: _extract_txt,
    SourceType.CSV: _extract_csv,
}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def process_document(path_str: str) -> IngestionResult:
    """Turn one document into an IngestionResult. Never raises: failures come
    back as success=False with an error_code the caller can act on."""
    source: Source | None = None
    warnings: list[str] = []
    try:
        path, source_type = _validate(path_str)
        source = _build_source(path, source_type)

        working_path, working_type = path, source_type
        if source_type is SourceType.DOC:
            working_path = _convert_doc_to_docx(path)
            working_type = SourceType.DOCX
            warnings.append("Converted .doc to .docx via LibreOffice headless.")

        extractor = EXTRACTORS.get(working_type)
        if extractor is None:
            raise ValueError(f"{ErrorCode.UNSUPPORTED_FILE_TYPE.value}: {working_type}")

        extracted = extractor(working_path, warnings)
        if not extracted:
            return IngestionResult(
                source=source,
                items=[],
                success=False,
                error="No extractable text found in document.",
                error_code=ErrorCode.CORRUPT_FILE,
                warnings=warnings,
            )

        items = [
            ContentItem(
                item_id=derive_id(source.source_id, "doc", index),
                source_id=source.source_id,
                modality=Modality.TEXT,
                content=text,
                location=location,
                metadata={
                    "chunk_index": index + 1,
                    "page": location.page_number or 1,
                    "page_number": location.page_number or 1,
                    "section": location.section or "",
                    "source_type": source_type.value,
                    "text": text,
                    **extra,
                },
            )
            for index, (text, location, extra) in enumerate(extracted)
        ]
        return IngestionResult(
            source=source,
            items=items,
            relationships=build_document_relationships(items),
            success=True,
            warnings=warnings,
        )

    except Exception as exc:
        logger.error("process_document failed for %s: %s", path_str, exc)
        return _failure(path_str, source, exc, warnings)


def build_document_relationships(items: list[ContentItem]) -> list[Relationship]:
    """SAME_PAGE between chunks sharing a page. SAME_SOURCE is derivable from
    source_id alone and is computed at query time rather than stored O(n^2)."""
    by_page: dict[int, list[ContentItem]] = {}
    for item in items:
        if item.location.page_number is not None:
            by_page.setdefault(item.location.page_number, []).append(item)

    relationships: list[Relationship] = []
    for page, page_items in by_page.items():
        for i in range(len(page_items) - 1):
            a, b = page_items[i], page_items[i + 1]
            relationships.append(Relationship(
                relationship_id=derive_id(a.item_id, b.item_id, "same_page"),
                source_item_id=a.item_id,
                target_item_id=b.item_id,
                relationship_type=RelationshipType.SAME_PAGE,
                confidence=1.0,
                metadata={"page_number": page},
            ))
    return relationships


def _failure(
    path_str: str,
    source: Source | None,
    exc: Exception,
    warnings: list[str],
) -> IngestionResult:
    message = str(exc)
    code = ErrorCode.CORRUPT_FILE
    for candidate in ErrorCode:
        if message.startswith(candidate.value):
            code = candidate
            break

    if source is None:
        path = Path(path_str)
        source = Source(
            source_id=derive_id(path_str),
            filename=path.name or "unknown",
            source_type=resolve_source_type(path),
            file_path=str(path),
        )
    return IngestionResult(
        source=source,
        items=[],
        success=False,
        error=message,
        error_code=code,
        warnings=warnings,
    )
