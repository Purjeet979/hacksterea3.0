"""
retriever.py -- query -> RetrievalResult[].

    query text -> MiniLM embedding -> FAISS cosine search -> ranked results

All modalities compete in one ranked list. That is what makes a cross-modal
query genuinely cross-modal rather than a stitched-together per-modality
search.
"""
from __future__ import annotations

import logging

from config import settings
from embeddings import embed_query
from schemas import Modality, RetrievalResult
from vector_store import VectorStore

logger = logging.getLogger(__name__)


class Retriever:
    def __init__(self, store: VectorStore):
        self.store = store

    def retrieve(
        self,
        query: str,
        top_k: int | None = None,
        modality_filter: Modality | None = None,
        exclude_source_ids: set[str] | None = None,
    ) -> list[RetrievalResult]:
        """Semantic search over the whole index.

        `modality_filter` and `exclude_source_ids` over-fetch then filter, so
        a constrained search still returns up to top_k results rather than a
        truncated handful.

        `exclude_source_ids` is what makes "find sources related to this
        file" meaningful: without it a document query retrieves mostly its
        own chunks, which are trivially its own nearest neighbours.
        """
        k = top_k or settings.top_k
        if not query.strip():
            return []

        excluded = exclude_source_ids or set()
        fetch_k = k * 4 if (modality_filter or excluded) else k
        query_vector = embed_query(query)
        hits = self.store.search(query_vector, fetch_k)

        results: list[RetrievalResult] = []
        for item, score in hits:
            if modality_filter and item.modality is not modality_filter:
                continue
            if item.source_id in excluded:
                continue
            results.append(RetrievalResult(item=item, score=score, rank=len(results) + 1))
            if len(results) >= k:
                break

        # Filename & document matching: if the query mentions a filename or keywords
        # matching an ingested source, ensure chunks from that source are retrieved.
        from pathlib import Path
        sources = self.store.list_sources()
        q_lower = query.lower()
        matched_source_ids: set[str] = set()
        for s in sources:
            fname = s.filename.lower()
            stem = Path(s.filename).stem.lower()
            if fname in q_lower or (len(stem) > 4 and stem in q_lower):
                matched_source_ids.add(s.source_id)
            else:
                parts = [p for p in stem.replace("_", " ").replace("-", " ").split() if len(p) >= 4]
                if any(p in q_lower for p in parts):
                    matched_source_ids.add(s.source_id)

        # Check if the query specifically references PDF or DOCX/DOC formats
        if "docx" in q_lower or "doc" in q_lower:
            for s in sources:
                if s.filename.lower().endswith((".docx", ".doc")):
                    matched_source_ids.add(s.source_id)
        if "pdf" in q_lower:
            for s in sources:
                if s.filename.lower().endswith(".pdf"):
                    matched_source_ids.add(s.source_id)

        # If a general summary or overview of "the document" / "the pdf" / "the docx" is requested,
        # ensure top introductory chunks from the source(s) are included.
        is_generic_doc_query = any(w in q_lower for w in [
            "the document", "this document", "the pdf", "this pdf",
            "the docx", "this docx", "the doc", "this doc",
            "the file", "this file", "the report", "this report",
            "the image", "this image", "the picture", "this picture",
            "what was the document", "what is the document", "what does the document",
            "what was the pdf", "what is the pdf", "what does the pdf",
            "what was the docx", "what is the docx", "what does the docx",
            "what is in the pdf", "what is in the docx", "what is in the document",
            "what is in the image", "about the image",
            "in the pdf", "in the docx", "in the document", "in the image",
            "about the pdf", "about the docx", "about the document",
            "summarize", "summarise", "summary", "overview", "what is this about", "explain the", "explain this"
        ])
        if not matched_source_ids and is_generic_doc_query and len(sources) <= 4:
            for s in sources:
                matched_source_ids.add(s.source_id)

        for sid in matched_source_ids:
            if sid in excluded:
                continue
            source_items = self.store.get_items_by_source(sid)
            for item in source_items[:4]:
                if not any(r.item.item_id == item.item_id for r in results):
                    results.insert(0, RetrievalResult(item=item, score=0.95, rank=1))

        # Re-index ranks
        for idx, res in enumerate(results, start=1):
            res.rank = idx

        return results[:max(k, 10)]
