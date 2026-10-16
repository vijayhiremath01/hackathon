"""Tests for integrity module."""

import hashlib
import tempfile
from pathlib import Path

import pytest

from waste_cv_engine.integrity import (
    calculate_sha256,
    verify_integrity,
    secure_write,
    secure_write_text,
    validate_output_path,
    cleanup_temp_files,
    IntegrityResult,
)


class TestIntegrity:
    """Tests for SHA-256 calculation and verification."""

    def test_calculate_sha256(self, tmp_path):
        """Test SHA-256 calculation."""
        test_data = b"Hello, World!"
        file_path = tmp_path / "test.txt"
        file_path.write_bytes(test_data)

        hash_result = calculate_sha256(file_path)
        expected = hashlib.sha256(test_data).hexdigest()

        assert hash_result == expected
        assert len(hash_result) == 64

    def test_calculate_sha256_empty_file(self, tmp_path):
        """Test SHA-256 of empty file."""
        file_path = tmp_path / "empty.txt"
        file_path.write_bytes(b"")

        hash_result = calculate_sha256(file_path)
        expected = hashlib.sha256(b"").hexdigest()

        assert hash_result == expected

    def test_calculate_sha256_large_file(self, tmp_path):
        """Test SHA-256 of larger file (multiple chunks)."""
        test_data = b"x" * 100000
        file_path = tmp_path / "large.bin"
        file_path.write_bytes(test_data)

        hash_result = calculate_sha256(file_path)
        expected = hashlib.sha256(test_data).hexdigest()

        assert hash_result == expected

    def test_calculate_sha256_missing_file(self, tmp_path):
        """Test SHA-256 of missing file raises error."""
        missing_path = tmp_path / "missing.txt"
        with pytest.raises(FileNotFoundError):
            calculate_sha256(missing_path)

    def test_verify_integrity_success(self, tmp_path):
        """Test successful integrity verification."""
        test_data = b"test data for verification"
        file_path = tmp_path / "test.txt"
        file_path.write_bytes(test_data)

        expected_hash = hashlib.sha256(test_data).hexdigest()
        result = verify_integrity(file_path, expected_hash)

        assert isinstance(result, IntegrityResult)
        assert result.verified is True
        assert result.expected_hash == expected_hash
        assert result.actual_hash == expected_hash
        assert result.error == ""

    def test_verify_integrity_failure(self, tmp_path):
        """Test failed integrity verification."""
        file_path = tmp_path / "test.txt"
        file_path.write_bytes(b"original data")

        wrong_hash = hashlib.sha256(b"different data").hexdigest()
        result = verify_integrity(file_path, wrong_hash)

        assert result.verified is False
        assert result.expected_hash == wrong_hash
        assert result.actual_hash != wrong_hash

    def test_verify_integrity_missing_file(self, tmp_path):
        """Test integrity verification of missing file."""
        missing_path = tmp_path / "missing.txt"
        result = verify_integrity(missing_path, "abc123")

        assert result.verified is False
        assert result.error != ""

    def test_secure_write_atomic(self, tmp_path):
        """Test secure atomic write."""
        file_path = tmp_path / "secure.txt"
        test_data = b"secure write test"

        result = secure_write(file_path, test_data)
        assert result is True
        assert file_path.exists()
        assert file_path.read_bytes() == test_data

    def test_secure_write_prevents_overwrite(self, tmp_path):
        """Test secure write refuses to overwrite."""
        file_path = tmp_path / "secure.txt"
        file_path.write_bytes(b"original")

        result = secure_write(file_path, b"new data")
        assert result is False
        assert file_path.read_bytes() == b"original"

    def test_secure_write_text(self, tmp_path):
        """Test secure text write."""
        file_path = tmp_path / "text.txt"
        test_text = "Hello, 世界!"

        result = secure_write_text(file_path, test_text)
        assert result is True
        assert file_path.read_text(encoding="utf-8") == test_text

    def test_validate_output_path_within_base(self, tmp_path):
        """Test path validation within base directory."""
        base = tmp_path / "output"
        base.mkdir()
        file_path = base / "subdir" / "file.txt"

        assert validate_output_path(file_path, base) is True

    def test_validate_output_path_outside_base(self, tmp_path):
        """Test path validation rejects paths outside base."""
        base = tmp_path / "output"
        base.mkdir()
        outside = tmp_path / "outside" / "file.txt"

        assert validate_output_path(outside, base) is False

    def test_cleanup_temp_files(self, tmp_path):
        """Test temp file cleanup."""
        (tmp_path / "file1.tmp").write_text("temp1")
        (tmp_path / "file2.tmp").write_text("temp2")
        (tmp_path / "keep.txt").write_text("keep")

        count = cleanup_temp_files(tmp_path, "*.tmp")
        assert count == 2
        assert not (tmp_path / "file1.tmp").exists()
        assert not (tmp_path / "file2.tmp").exists()
        assert (tmp_path / "keep.txt").exists()