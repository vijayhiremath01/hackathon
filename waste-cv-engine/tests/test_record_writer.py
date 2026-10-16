"""Tests for record_writer module."""

import json
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest

from waste_cv_engine.record_writer import (
    write_scan_record,
    write_failure_record,
    _generate_scan_id,
    _utc_now_iso,
    _get_relative_path,
    ScanRecord,
    CaptureInfo,
    ModelInfo,
    DetectionRecord,
    BoundingBox,
    SummaryInfo,
    ArtifactsInfo,
)
from waste_cv_engine.detector import Detection


class TestRecordWriter:
    """Tests for JSON record writing."""

    def test_generate_unique_scan_id(self):
        """Test that scan IDs are unique UUIDs."""
        ids = {_generate_scan_id() for _ in range(100)}
        assert len(ids) == 100
        for scan_id in ids:
            uuid.UUID(scan_id, version=4)

    def test_utc_timestamp_format(self):
        """Test UTC timestamp format ends with Z."""
        ts = _utc_now_iso()
        assert ts.endswith("Z")
        datetime.fromisoformat(ts.replace("Z", "+00:00"))

    def test_relative_path_calculation(self):
        """Test relative path computation."""
        base = Path("/project")
        file_path = base / "captured_images" / "2026" / "10" / "15" / "test.jpg"
        rel = _get_relative_path(file_path, base)
        assert rel == "captured_images/2026/10/15/test.jpg"

    def test_write_scan_record_empty_detections(self, tmp_path):
        """Test writing record with no detections."""
        image_path = tmp_path / "test.jpg"
        image_path.write_bytes(b"fake image data")

        json_path = write_scan_record(
            image_path=image_path,
            image_width=640,
            image_height=480,
            detections=[],
        )

        assert json_path is not None
        assert json_path.exists()

        with open(json_path) as f:
            record = json.load(f)

        assert record["schema_version"] == "1.0"
        assert record["status"] == "completed"
        assert record["detections"] == []
        assert record["summary"]["total_detections"] == 0
        assert record["summary"]["unique_object_classes"] == []
        assert "sha256" in record["capture"]
        assert record["capture"]["sha256"] != ""

    def test_write_scan_record_with_detections(self, tmp_path):
        """Test writing record with detections."""
        image_path = tmp_path / "test.jpg"
        image_path.write_bytes(b"fake image data")

        detections = [
            Detection(class_id=39, label="bottle", confidence=0.92, x1=100, y1=120, x2=250, y2=400),
            Detection(class_id=41, label="cup", confidence=0.85, x1=300, y1=100, x2=400, y2=300),
        ]

        json_path = write_scan_record(
            image_path=image_path,
            image_width=640,
            image_height=480,
            detections=detections,
        )

        assert json_path is not None
        assert json_path.exists()

        with open(json_path) as f:
            record = json.load(f)

        assert record["summary"]["total_detections"] == 2
        assert set(record["summary"]["unique_object_classes"]) == {"bottle", "cup"}
        assert len(record["detections"]) == 2

        for det in record["detections"]:
            assert "class_id" in det
            assert "label" in det
            assert "confidence" in det
            assert "bounding_box" in det
            assert "material" not in det  # Material classification removed

    def test_write_failure_record(self, tmp_path):
        """Test writing failure record."""
        image_path = tmp_path / "test.jpg"
        image_path.write_bytes(b"fake image data")
        scan_id = str(uuid.uuid4())
        created_at = _utc_now_iso()

        json_path = write_failure_record(
            scan_id=scan_id,
            created_at=created_at,
            image_path=image_path,
            image_width=640,
            image_height=480,
            error="Model inference failed",
        )

        assert json_path is not None
        assert json_path.exists()

        with open(json_path) as f:
            record = json.load(f)

        assert record["scan_id"] == scan_id
        assert record["status"] == "failed"
        assert "Model inference failed" in record["errors"]
        assert record["detections"] == []

    def test_no_overwrite_same_scan_id(self, tmp_path):
        """Test that writing with same scan_id is prevented."""
        image_path = tmp_path / "test.jpg"
        image_path.write_bytes(b"fake image data")

        # Write first record with a specific scan_id
        scan_id = "11111111-1111-1111-1111-111111111111"
        created_at = _utc_now_iso()

        # We need to test the internal collision check by directly calling
        # the function that would create the same path. Since write_scan_record
        # generates its own UUID, we test the collision logic by calling
        # the internal function or by writing twice with a pre-existing file.

        dated_dir = tmp_path / "2026" / "10" / "15"
        dated_dir.mkdir(parents=True, exist_ok=True)
        json_path = dated_dir / f"{scan_id}.json"

        # Pre-create the JSON file
        json_path.write_text("{}")

        # Now try to write - should fail because file exists
        # But write_scan_record generates new UUID, so let's test
        # the secure_write_text collision prevention directly
        from waste_cv_engine.integrity import secure_write_text
        result = secure_write_text(json_path, '{"test": "data"}')
        assert result is False  # Should refuse to overwrite


class TestScanRecordSchema:
    """Tests for JSON schema compliance."""

    def test_schema_fields_present(self, tmp_path):
        """Test all required schema fields are present."""
        image_path = tmp_path / "test.jpg"
        image_path.write_bytes(b"fake image data")

        json_path = write_scan_record(
            image_path=image_path,
            image_width=640,
            image_height=480,
            detections=[],
        )

        with open(json_path) as f:
            record = json.load(f)

        required_fields = [
            "schema_version", "scan_id", "created_at", "completed_at", "status",
            "capture", "model", "detections", "summary", "artifacts", "errors"
        ]
        for field in required_fields:
            assert field in record, f"Missing field: {field}"

        assert "source" in record["capture"]
        assert "image_path" in record["capture"]
        assert "format" in record["capture"]
        assert "width" in record["capture"]
        assert "height" in record["capture"]
        assert "sha256" in record["capture"]

        assert "name" in record["model"]
        assert "weights_path" in record["model"]
        assert "task" in record["model"]
        assert "confidence_threshold" in record["model"]

        assert "original_image" in record["artifacts"]
        assert "json_record" in record["artifacts"]
        assert "annotated_image" in record["artifacts"]

    def test_detection_record_structure(self, tmp_path):
        """Test detection record has correct structure without material."""
        image_path = tmp_path / "test.jpg"
        image_path.write_bytes(b"fake image data")

        detections = [
            Detection(class_id=39, label="bottle", confidence=0.92, x1=100, y1=120, x2=250, y2=400),
        ]

        json_path = write_scan_record(
            image_path=image_path,
            image_width=640,
            image_height=480,
            detections=detections,
        )

        with open(json_path) as f:
            record = json.load(f)

        det = record["detections"][0]
        required_det_fields = ["class_id", "label", "confidence", "bounding_box"]
        for field in required_det_fields:
            assert field in det, f"Missing detection field: {field}"

        assert "material" not in det
        assert det["bounding_box"] == {"x1": 100, "y1": 120, "x2": 250, "y2": 400}