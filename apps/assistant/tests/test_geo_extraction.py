import asyncio
import json
from collections.abc import Mapping
from typing import Any

import pytest
from fieldloop_assistant.geo_extraction import (
    LOW_CONFIDENCE_THRESHOLD,
    GeoExtractionBlockedError,
    GeoExtractionValidationError,
    extract_geo_references,
    parse_chainage,
    validate_geo_references,
)


def test_parses_kp_chainage_metres() -> None:
    assert parse_chainage("Inspection access at KP 45+200") == (45_200.0, None)


def test_parses_kp_chainage_range() -> None:
    assert parse_chainage("Work area KP 45+200–KP 45+450") == (45_200.0, 45_450.0)


def test_parses_labelled_chainage_range() -> None:
    assert parse_chainage("Chainage 45,200 to 45,450 m") == (45_200.0, 45_450.0)


def test_rejects_invalid_kp_remainder() -> None:
    assert parse_chainage("KP 45+1200") is None


def test_validates_exact_excerpt_and_deterministic_kp_value() -> None:
    excerpt = "Inspection access at KP 45+200–KP 45+450"
    candidate = {
        "latitude": None,
        "longitude": None,
        "chainageFrom": 1,
        "chainageTo": 2,
        "assetCode": None,
        "placeName": None,
        "sourceSnippet": excerpt,
        "confidence": 0.8,
    }
    parsed = validate_geo_references({"references": [candidate]}, f"Source: {excerpt}.")[0]
    assert parsed.chainage_from == 45_200
    assert parsed.chainage_to == 45_450


def test_rejects_unverifiable_coordinates_and_source_excerpt() -> None:
    candidate = {
        "latitude": 13.75,
        "longitude": 100.5,
        "chainageFrom": None,
        "chainageTo": None,
        "assetCode": None,
        "placeName": None,
        "sourceSnippet": "the site is near the river",
        "confidence": 0.7,
    }
    with pytest.raises(GeoExtractionValidationError):
        validate_geo_references({"references": [candidate]}, "A site is near the river.")


def test_validates_grounded_coordinate_pair() -> None:
    excerpt = "Valve marker at 13.756, 100.501 near the canal."
    candidate = {
        "latitude": 13.756,
        "longitude": 100.501,
        "chainageFrom": None,
        "chainageTo": None,
        "assetCode": None,
        "placeName": None,
        "sourceSnippet": excerpt,
        "confidence": 0.9,
    }

    parsed = validate_geo_references({"references": [candidate]}, excerpt)[0]

    assert parsed.latitude == 13.756
    assert parsed.longitude == 100.501


def test_validates_thai_place_name_from_exact_excerpt() -> None:
    excerpt = "จุดตรวจอยู่ใกล้บางกระเจ้า"
    candidate = {
        "latitude": None,
        "longitude": None,
        "chainageFrom": None,
        "chainageTo": None,
        "assetCode": None,
        "placeName": "บางกระเจ้า",
        "sourceSnippet": excerpt,
        "confidence": 0.75,
    }

    parsed = validate_geo_references({"references": [candidate]}, excerpt)[0]

    assert parsed.place_name == "บางกระเจ้า"


def test_ambiguous_thai_place_name_is_capped_at_low_confidence() -> None:
    excerpt = "พบรอยรั่วใกล้ท่าน้ำ"
    candidate = {
        "latitude": None,
        "longitude": None,
        "chainageFrom": None,
        "chainageTo": None,
        "assetCode": None,
        "placeName": "ท่าน้ำ",
        "sourceSnippet": excerpt,
        "confidence": 0.95,
    }

    parsed = validate_geo_references({"references": [candidate]}, excerpt)[0]

    assert parsed.confidence < LOW_CONFIDENCE_THRESHOLD
    assert parsed.latitude is None and parsed.chainage_from is None


def test_grounded_chainage_keeps_model_confidence() -> None:
    excerpt = "Valve marker at KP 45+200"
    candidate = {
        "latitude": None,
        "longitude": None,
        "chainageFrom": None,
        "chainageTo": None,
        "assetCode": None,
        "placeName": None,
        "sourceSnippet": excerpt,
        "confidence": 0.92,
    }

    parsed = validate_geo_references({"references": [candidate]}, excerpt)[0]

    assert parsed.chainage_from == 45_200
    assert parsed.confidence == 0.92


def test_validates_segment_and_facility_ids_from_table_rows() -> None:
    source = (
        "| Record | Code | Location |\n"
        "| Facility | FAC-17 | Pump House Alpha |\n"
        "| Segment | SEG-4 | บางกระเจ้า |"
    )
    candidates = [
        {
            "latitude": None,
            "longitude": None,
            "chainageFrom": None,
            "chainageTo": None,
            "assetCode": "FAC-17",
            "placeName": "Pump House Alpha",
            "sourceSnippet": "| Facility | FAC-17 | Pump House Alpha |",
            "confidence": 0.8,
        },
        {
            "latitude": None,
            "longitude": None,
            "chainageFrom": None,
            "chainageTo": None,
            "assetCode": "SEG-4",
            "placeName": "บางกระเจ้า",
            "sourceSnippet": "| Segment | SEG-4 | บางกระเจ้า |",
            "confidence": 0.8,
        },
    ]

    parsed = validate_geo_references({"references": candidates}, source)

    assert [(item.asset_code, item.place_name) for item in parsed] == [
        ("FAC-17", "Pump House Alpha"),
        ("SEG-4", "บางกระเจ้า"),
    ]


class FakePlatform:
    def __init__(self, text: str) -> None:
        self.text = text
        self.created: list[dict[str, Any]] = []

    async def get_geo_source(self, document_id: str, internal_user_token: str) -> Mapping[str, Any]:
        assert document_id == "doc-1"
        assert internal_user_token == "signed-token"
        return {
            "id": document_id,
            "title": "Synthetic inspection",
            "folder": "Safety",
            "text": self.text,
            "classification": "INTERNAL",
            "simulated": True,
        }

    async def create_geo_reference_drafts(
        self,
        document_id: str,
        internal_user_token: str,
        idempotency_key: str,
        references: list[dict[str, Any]],
    ) -> Mapping[str, Any]:
        self.created = references
        return {"references": references, "replayed": False}


class FakeGuardrail:
    def __init__(self, content: str, decision: str = "allow") -> None:
        self.content = content
        self.decision = decision
        self.scanned: list[str] = []
        self.scan_keys: list[str] = []
        self.completion: dict[str, Any] | None = None

    async def scan_geo_content(self, **kwargs: Any) -> Mapping[str, Any]:
        self.scanned.append(kwargs["content"])
        self.scan_keys.append(kwargs["idempotency_key"])
        return {
            "decision": self.decision,
            "content": kwargs["content"],
            "classification": kwargs["classification"],
            "policyId": "policy",
        }

    async def structured_chat_completion(self, **kwargs: Any) -> Mapping[str, Any] | str:
        self.completion = kwargs
        return {"choices": [{"message": {"content": self.content}}]}


def test_tool_scans_then_saves_only_grounded_drafts() -> None:
    async def exercise() -> None:
        source = "Valve marker at KP 45+200 near Ban Klang."
        model_output = json.dumps(
            {
                "references": [
                    {
                        "latitude": None,
                        "longitude": None,
                        "chainageFrom": 45_200,
                        "chainageTo": None,
                        "assetCode": None,
                        "placeName": "Ban Klang",
                        "sourceSnippet": "KP 45+200 near Ban Klang",
                        "confidence": 0.2,
                    }
                ]
            }
        )
        platform = FakePlatform(source)
        guardrail = FakeGuardrail(model_output)
        result = await extract_geo_references(
            "doc-1", "signed-token", platform, guardrail,
            allowed_folders=("Safety",), idempotency_key="geo-test-key-0001"
        )
        assert guardrail.scanned == [source]
        assert guardrail.scan_keys == ["geo-scan:geo-test-key-0001"]
        assert guardrail.completion is not None
        assert guardrail.completion["response_format"]["type"] == "json_schema"
        schema = guardrail.completion["response_format"]["json_schema"]["schema"]
        candidate_schema = schema["properties"]["references"]["items"]
        assert "$defs" not in schema
        max_chainage = candidate_schema["properties"]["chainageFrom"]["anyOf"][0]["maximum"]
        assert max_chainage == 1_000_000_000
        assert platform.created[0]["chainageFrom"] == 45_200
        assert platform.created[0]["confidence"] == 0.2
        assert result["replayed"] is False

    asyncio.run(exercise())


def test_tool_saves_ambiguous_thai_place_as_low_confidence_draft_without_location() -> None:
    async def exercise() -> None:
        source = "พบรอยรั่วใกล้ท่าน้ำ"
        model_output = json.dumps(
            {
                "references": [
                    {
                        "latitude": None,
                        "longitude": None,
                        "chainageFrom": None,
                        "chainageTo": None,
                        "assetCode": None,
                        "placeName": "ท่าน้ำ",
                        "sourceSnippet": source,
                        "confidence": 0.9,
                    }
                ]
            }
        )
        platform = FakePlatform(source)
        await extract_geo_references(
            "doc-1", "signed-token", platform, FakeGuardrail(model_output),
            allowed_folders=("Safety",), idempotency_key="geo-test-key-0002"
        )
        saved = platform.created[0]
        assert saved["confidence"] < LOW_CONFIDENCE_THRESHOLD
        assert saved["latitude"] is None and saved["chainageFrom"] is None
        assert "status" not in saved

    asyncio.run(exercise())


def test_tool_stops_when_guardrail_blocks_document_text() -> None:
    async def exercise() -> None:
        platform = FakePlatform("Valve at KP 45+200")
        guardrail = FakeGuardrail('{"references": []}', decision="reroute")
        with pytest.raises(GeoExtractionBlockedError):
            await extract_geo_references(
                "doc-1", "signed-token", platform, guardrail, allowed_folders=("Safety",)
            )
        assert platform.created == []

    asyncio.run(exercise())


def test_tool_does_not_send_out_of_scope_folder_to_guardrail() -> None:
    async def exercise() -> None:
        platform = FakePlatform("Valve at KP 45+200")
        guardrail = FakeGuardrail('{"references": []}')
        with pytest.raises(GeoExtractionValidationError, match="allowed knowledge folders"):
            await extract_geo_references(
                "doc-1", "signed-token", platform, guardrail, allowed_folders=("Emergency",)
            )
        assert guardrail.scanned == []
        assert platform.created == []

    asyncio.run(exercise())
