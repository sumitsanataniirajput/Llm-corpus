"""Dataset API tests: real PostgreSQL, fake private storage bucket."""
import pytest

from app.config import settings
from tests.conftest import USER_ID


async def _create_dataset(http, name="Training corpus", fmt="txt", size=0):
    resp = await http.post("/api/v1/datasets/", json={"name": name, "format": fmt, "size": size})
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _upload(http, dataset_id, content=b"hello corpus world\n" * 20, filename="corpus.txt"):
    files = {"file": (filename, content, "text/plain")}
    resp = await http.post(f"/api/v1/datasets/{dataset_id}/upload", files=files)
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.mark.asyncio
async def test_new_dataset_is_pending_and_has_no_file(http):
    dataset = await _create_dataset(http)
    assert dataset["status"] == "pending"
    assert dataset["has_file"] is False
    assert dataset["trainable"] is False
    assert dataset["file_name"] is None


@pytest.mark.asyncio
async def test_upload_exposes_file_metadata_and_marks_dataset_uploaded(http, storage):
    dataset = await _create_dataset(http)
    payload = await _upload(http, dataset["id"])

    assert payload["ok"] is True
    assert payload["file_name"] == "corpus.txt"
    stored = payload["dataset"]
    assert stored["status"] == "uploaded"
    assert stored["has_file"] is True
    assert stored["trainable"] is True
    assert stored["file_name"] == "corpus.txt"
    assert stored["file_size"] > 0
    assert stored["uploaded_at"] is not None
    assert stored["storage_path"].startswith(f"{USER_ID}/datasets/{dataset['id']}/")

    # Bytes really landed in the (fake) private bucket under the owner prefix.
    paths = storage.paths(settings.STORAGE_BUCKET)
    assert len(paths) == 1
    assert paths[0].endswith("_corpus.txt")
    assert storage.get(settings.STORAGE_BUCKET, paths[0]) == b"hello corpus world\n" * 20


@pytest.mark.asyncio
async def test_list_datasets_includes_latest_file_metadata(http):
    ds = await _create_dataset(http, name="First")
    await _upload(http, ds["id"], content=b"first file body\n" * 4, filename="first.txt")

    resp = await http.get("/api/v1/datasets/")
    assert resp.status_code == 200
    datasets = resp.json()
    assert len(datasets) == 1
    listed = datasets[0]
    assert listed["id"] == ds["id"]
    assert listed["file_name"] == "first.txt"
    assert listed["file_size"] == len(b"first file body\n" * 4)
    assert listed["has_file"] is True
    assert listed["status"] == "uploaded"


@pytest.mark.asyncio
async def test_reupload_updates_latest_file_metadata(http, storage):
    ds = await _create_dataset(http)
    await _upload(http, ds["id"], content=b"old\n" * 10, filename="old.txt")
    await _upload(http, ds["id"], content=b"new dataset body\n" * 30, filename="new.txt")

    detail = (await http.get(f"/api/v1/datasets/{ds['id']}")).json()
    assert detail["file_name"] == "new.txt"
    assert detail["file_size"] == len(b"new dataset body\n" * 30)
    # Both uploads are preserved in storage history.
    assert len(storage.paths(settings.STORAGE_BUCKET)) == 2


@pytest.mark.asyncio
async def test_preview_returns_real_stored_text(http):
    ds = await _create_dataset(http)
    body = "line one\nline two\nline three\n"
    await _upload(http, ds["id"], content=body.encode())

    resp = await http.get(f"/api/v1/datasets/{ds['id']}/preview")
    assert resp.status_code == 200, resp.text
    preview = resp.json()
    assert preview["preview"] == body
    assert preview["total_characters"] == len(body)
    assert preview["total_lines"] == 3
    assert preview["file_name"] == "corpus.txt"


@pytest.mark.asyncio
async def test_preview_requires_an_uploaded_file(http):
    ds = await _create_dataset(http)
    resp = await http.get(f"/api/v1/datasets/{ds['id']}/preview")
    assert resp.status_code == 400
    assert "no uploaded file" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_dataset_isolation_between_users(http, http_as_other):
    ds = await _create_dataset(http)
    await _upload(http, ds["id"])

    other_list = (await http_as_other.get("/api/v1/datasets/")).json()
    assert other_list == []

    assert (await http_as_other.get(f"/api/v1/datasets/{ds['id']}")).status_code == 403
    assert (await http_as_other.get(f"/api/v1/datasets/{ds['id']}/preview")).status_code == 403
    files = {"file": ("x.txt", b"nope", "text/plain")}
    assert (await http_as_other.post(f"/api/v1/datasets/{ds['id']}/upload", files=files)).status_code == 403


@pytest.mark.asyncio
async def test_delete_removes_row_and_stored_object(http, storage):
    ds = await _create_dataset(http)
    await _upload(http, ds["id"])
    assert len(storage.paths(settings.STORAGE_BUCKET)) == 1

    resp = await http.delete(f"/api/v1/datasets/{ds['id']}")
    assert resp.status_code == 200
    assert resp.json()["removed_files"] == 1
    assert (await http.get("/api/v1/datasets/")).json() == []
    assert storage.paths(settings.STORAGE_BUCKET) == []


@pytest.mark.asyncio
async def test_upload_rejects_unsupported_extension(http):
    ds = await _create_dataset(http)
    files = {"file": ("archive.zip", b"PK\x03\x04binary", "application/zip")}
    resp = await http.post(f"/api/v1/datasets/{ds['id']}/upload", files=files)
    assert resp.status_code == 400
    detail = resp.json()["detail"]
    assert "Unsupported dataset file" in detail
    assert "PDF" in detail


@pytest.mark.asyncio
async def test_preview_extracts_real_pdf_text(http):
    from tests.test_text_extraction import make_pdf

    ds = await _create_dataset(http, name="Paper", fmt="pdf")
    pdf = make_pdf("Extracted from a genuine PDF")
    files = {"file": ("paper.pdf", pdf, "application/pdf")}
    up = await http.post(f"/api/v1/datasets/{ds['id']}/upload", files=files)
    assert up.status_code == 200, up.text

    resp = await http.get(f"/api/v1/datasets/{ds['id']}/preview")
    assert resp.status_code == 200, resp.text
    preview = resp.json()
    assert "Extracted from a genuine PDF" in preview["preview"]
    assert "%PDF" not in preview["preview"]
    assert preview["file_name"] == "paper.pdf"


@pytest.mark.asyncio
async def test_preview_extracts_csv_cells(http):
    ds = await _create_dataset(http, name="Pairs", fmt="csv")
    csv_body = b"question,answer\nWhat,That\n"
    files = {"file": ("pairs.csv", csv_body, "text/csv")}
    up = await http.post(f"/api/v1/datasets/{ds['id']}/upload", files=files)
    assert up.status_code == 200, up.text

    resp = await http.get(f"/api/v1/datasets/{ds['id']}/preview")
    assert resp.status_code == 200, resp.text
    assert "question answer" in resp.json()["preview"]


@pytest.mark.asyncio
async def test_preview_reports_broken_pdf_clearly(http):
    ds = await _create_dataset(http, name="Broken", fmt="pdf")
    files = {"file": ("broken.pdf", b"not really a pdf", "application/pdf")}
    up = await http.post(f"/api/v1/datasets/{ds['id']}/upload", files=files)
    assert up.status_code == 200, up.text

    resp = await http.get(f"/api/v1/datasets/{ds['id']}/preview")
    assert resp.status_code == 400
    assert "%PDF" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_failed_storage_upload_marks_dataset_failed_and_allows_retry(http, storage, monkeypatch):
    ds = await _create_dataset(http, name="Retry corpus", fmt="txt")

    def boom(*args, **kwargs):
        raise RuntimeError("Storage network glitch")

    orig_from = storage.storage.from_
    monkeypatch.setattr(storage.storage, "from_", lambda _bucket: type("FailBucket", (), {"upload": boom})())

    files = {"file": ("retry.txt", b"retryable text content\n" * 10, "text/plain")}
    fail_resp = await http.post(f"/api/v1/datasets/{ds['id']}/upload", files=files)
    assert fail_resp.status_code == 502

    detail = (await http.get(f"/api/v1/datasets/{ds['id']}")).json()
    assert detail["status"] == "failed"
    assert detail["has_file"] is False
    assert detail["trainable"] is False

    # Retry succeeds once storage recovers.
    monkeypatch.setattr(storage.storage, "from_", orig_from)
    ok_resp = await http.post(f"/api/v1/datasets/{ds['id']}/upload", files=files)
    assert ok_resp.status_code == 200, ok_resp.text
    assert ok_resp.json()["dataset"]["status"] == "uploaded"
    assert ok_resp.json()["dataset"]["has_file"] is True
