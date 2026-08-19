"""Build training examples from user text and documents."""

from __future__ import annotations

import json
from pathlib import Path


SUPPORTED_SUFFIXES = {".txt", ".md", ".csv", ".json", ".jsonl", ".pdf", ".docx"}


def extract_text(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in {".txt", ".md", ".csv", ".json", ".jsonl"}:
        return path.read_text(encoding="utf-8", errors="replace")
    if suffix == ".pdf":
        try:
            from pypdf import PdfReader  # type: ignore

            reader = PdfReader(str(path))
            return "\n".join((p.extract_text() or "") for p in reader.pages)
        except Exception as e:
            return f"[Could not read PDF {path.name}: {e}]"
    if suffix == ".docx":
        try:
            import docx  # type: ignore

            doc = docx.Document(str(path))
            return "\n".join(p.text for p in doc.paragraphs)
        except Exception as e:
            return f"[Could not read Word document {path.name}: {e}]"
    return path.read_text(encoding="utf-8", errors="replace")


def chunk_text(text: str, max_chars: int = 1200) -> list[str]:
    text = text.strip()
    if not text:
        return []
    chunks: list[str] = []
    buf: list[str] = []
    size = 0
    for para in text.splitlines():
        para = para.strip()
        if not para:
            continue
        if size + len(para) + 1 > max_chars and buf:
            chunks.append("\n".join(buf))
            buf = [para]
            size = len(para)
        else:
            buf.append(para)
            size += len(para) + 1
    if buf:
        chunks.append("\n".join(buf))
    return chunks


def build_examples(
    skill_name: str,
    skill_description: str,
    pasted_text: str,
    file_paths: list[str],
) -> list[dict[str, str]]:
    """Create simple instruction/response pairs for supervised fine-tuning."""
    materials: list[str] = []
    if pasted_text.strip():
        materials.extend(chunk_text(pasted_text))
    for fp in file_paths:
        p = Path(fp)
        if not p.exists():
            continue
        materials.extend(chunk_text(extract_text(p)))

    examples: list[dict[str, str]] = []
    # Seed with skill framing
    examples.append(
        {
            "instruction": f"You are improving at: {skill_name}. What is your focus?",
            "input": "",
            "output": skill_description.strip(),
        }
    )

    for i, chunk in enumerate(materials):
        examples.append(
            {
                "instruction": (
                    f"Using your knowledge for '{skill_name}', explain or apply the following material clearly."
                ),
                "input": chunk,
                "output": (
                    f"Here is a clear application of this material in the context of {skill_name}:\n\n{chunk}"
                ),
            }
        )
        if i >= 500:
            break

    return examples


def write_jsonl(examples: list[dict[str, str]], out_path: Path) -> int:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        for ex in examples:
            f.write(json.dumps(ex, ensure_ascii=False) + "\n")
    return len(examples)
