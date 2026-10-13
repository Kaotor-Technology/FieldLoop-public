import pytest
from fieldloop_assistant.chunking import MAX_CHARS, chunk_text


def test_pdf_pages_and_thai_clauses_are_preserved_without_inventing_pages() -> None:
    chunks = chunk_text(
        "--- PDF page 2 ---\nมาตรา ๕ ข้อความ\n--- PDF page 3 ---\nต่อจากหน้าเดิม\nมาตรา ๖ อีกข้อ"
    )
    assert [(c.page, c.clause) for c in chunks] == [(2, "มาตรา ๕"), (3, "มาตรา ๕"), (3, "มาตรา ๖")]
    assert chunk_text("## Procedure\nSYNTHETIC", format="markdown")[0].page is None


def test_markdown_metadata_is_not_embedded_and_long_thai_has_no_lost_characters() -> None:
    text = "ก" * 3500
    chunks = chunk_text("---\nrevision: B\n---\n## Purpose\n" + text, format="markdown")
    assert all(len(c.content) <= MAX_CHARS for c in chunks)
    assert all(c.clause == "Purpose" for c in chunks)
    assert "".join(c.content for c in chunks).count("ก") == 3500
    assert "revision:" not in chunks[0].content


def test_cfr_section_and_inline_xml_text_are_preserved() -> None:
    chunks = chunk_text(
        '<DIV5><DIV8 TYPE="SECTION" N="§ 192.1"><HEAD>Scope</HEAD>'
        '<P>Pipe <I>safety</I> rule.</P></DIV8></DIV5>',
        format="xml",
    )
    assert chunks[0].clause == "§ 192.1"
    assert "Pipe safety rule." in chunks[0].content
    assert chunks[0].page is None


@pytest.mark.parametrize("text", ["", "bad\ufffd", "bad\ue000", "<!DOCTYPE x><DIV5/>"])
def test_invalid_text_is_rejected(text: str) -> None:
    with pytest.raises(ValueError):
        chunk_text(text, format="xml" if text.startswith("<") else "text")
