"""Unit tests for genuine per-format dataset text extraction.

These tests prove that the formats advertised by the frontend are actually
readable by the backend — including PDF — and that unsupported or binary files
fail with a clear, user-facing error instead of producing mojibake.
"""
import pytest

from app.services.text_extraction import (
    DatasetTextError,
    extract_text,
    is_supported_format,
)


def make_pdf(*lines: str) -> bytes:
    """Build a tiny, structurally valid single-page PDF with a text layer."""
    text = ") Tj T* (".join(lines)
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
    ]
    stream = ("BT /F1 12 Tf 20 150 Td (" + text + ") Tj ET").encode("latin-1")
    objects.append(b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream")
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for index, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += str(index).encode() + b" 0 obj\n" + body + b"\nendobj\n"
    xref_at = len(out)
    size = len(objects) + 1
    out += b"xref\n0 " + str(size).encode() + b"\n0000000000 65535 f \n"
    for offset in offsets:
        out += ("%010d 00000 n \n" % offset).encode()
    out += (
        b"trailer\n<< /Size " + str(size).encode() + b" /Root 1 0 R >>\nstartxref\n"
        + str(xref_at).encode() + b"\n%%EOF\n"
    )
    return bytes(out)


def test_txt_returns_text_and_accepts_bom():
    raw = "\ufeffThe corpus starts here.\nSecond line.".encode("utf-8")
    assert extract_text(raw, "corpus.txt") == "The corpus starts here.\nSecond line."


def test_csv_is_parsed_into_readable_rows():
    raw = b"title,body\nFirst,Hello there\nSecond,Another row\n"
    text = extract_text(raw, "pairs.csv")
    assert "title body" in text
    assert "First Hello there" in text
    assert "Second Another row" in text
    assert "," not in text.splitlines()[0]


def test_json_collects_nested_strings():
    raw = b'{"title": "Doc", "chapters": [{"text": "alpha"}, {"text": "beta"}], "count": 2}'
    text = extract_text(raw, "doc.json")
    for expected in ("title", "Doc", "chapters", "text", "alpha", "beta", "2"):
        assert expected in text


def test_jsonl_reads_every_line():
    raw = b'{"prompt": "one"}\n{"prompt": "two"}\n'
    text = extract_text(raw, "pairs.jsonl")
    assert "one" in text and "two" in text


def test_jsonl_reports_the_broken_line():
    with pytest.raises(DatasetTextError) as excinfo:
        extract_text(b'{"ok": 1}\nnot json\n', "broken.jsonl")
    assert "line 2" in str(excinfo.value)


def test_pdf_text_layer_is_extracted():
    raw = make_pdf("Hello PDF corpus text", "second PDF line")
    text = extract_text(raw, "paper.pdf")
    assert "Hello PDF corpus text" in text
    assert "second PDF line" in text


def test_pdf_without_text_layer_is_rejected():
    raw = make_pdf("")
    with pytest.raises(DatasetTextError) as excinfo:
        extract_text(raw, "scan.pdf")
    assert "no extractable text" in str(excinfo.value)


def test_pdf_extension_without_pdf_header_is_rejected():
    with pytest.raises(DatasetTextError) as excinfo:
        extract_text(b"just plain text", "fake.pdf")
    assert "%PDF" in str(excinfo.value)


def test_unsupported_extension_lists_supported_formats():
    with pytest.raises(DatasetTextError) as excinfo:
        extract_text(b"\x00\x01binary", "image.png")
    assert "Unsupported dataset format" in str(excinfo.value)
    assert "PDF" in str(excinfo.value)


def test_binary_payload_named_txt_is_rejected():
    with pytest.raises(DatasetTextError) as excinfo:
        extract_text(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR", "image.txt")
    assert "binary" in str(excinfo.value).lower()


def test_invalid_utf8_is_rejected_with_a_clear_message():
    with pytest.raises(DatasetTextError) as excinfo:
        extract_text(b"\xff\xfe\x00\x01\x02", "latin.txt")
    assert "UTF-8" in str(excinfo.value)


def test_empty_file_is_rejected():
    with pytest.raises(DatasetTextError) as excinfo:
        extract_text(b"", "empty.txt")
    assert "empty" in str(excinfo.value)


def test_supported_format_helper():
    assert is_supported_format("a.txt")
    assert is_supported_format("a.PDF")
    assert is_supported_format("a.jsonl")
    assert not is_supported_format("a.exe")
    assert not is_supported_format("noextension")
