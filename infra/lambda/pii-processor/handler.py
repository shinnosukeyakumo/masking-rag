"""
PII Processor Lambda
親S3にファイルが置かれたとき起動し:
1. Comprehend で PII エンティティを検出
2. マスキング版を masked-bucket へ
3. 原本を raw-bucket へ
対応形式: .txt .md .csv .json
"""
import json
import os
import csv
import io
import urllib.parse
import boto3

MASKED_BUCKET = os.environ["MASKED_BUCKET"]
RAW_BUCKET = os.environ["RAW_BUCKET"]
REGION = os.environ.get("REGION", "us-west-2")

s3 = boto3.client("s3", region_name=REGION)
comprehend = boto3.client("comprehend", region_name=REGION)


def lambda_handler(event, _context):
    for record in event["Records"]:
        bucket = record["s3"]["bucket"]["name"]
        key = urllib.parse.unquote_plus(record["s3"]["object"]["key"])
        _process_file(bucket, key)


def _process_file(bucket: str, key: str):
    resp = s3.get_object(Bucket=bucket, Key=key)
    body = resp["Body"].read()
    ext = key.rsplit(".", 1)[-1].lower() if "." in key else ""

    if ext in ("txt", "md"):
        text = body.decode("utf-8")
        masked_text = _mask_text(text)
        _upload(MASKED_BUCKET, key, masked_text.encode("utf-8"), "text/plain")
        _upload(RAW_BUCKET, key, body, "text/plain")

    elif ext == "csv":
        text = body.decode("utf-8")
        masked_text = _mask_csv(text)
        _upload(MASKED_BUCKET, key, masked_text.encode("utf-8"), "text/csv")
        _upload(RAW_BUCKET, key, body, "text/csv")

    elif ext == "json":
        data = json.loads(body.decode("utf-8"))
        masked_data = _mask_json(data)
        _upload(MASKED_BUCKET, key, json.dumps(masked_data, ensure_ascii=False).encode("utf-8"), "application/json")
        _upload(RAW_BUCKET, key, body, "application/json")

    else:
        # 未対応形式はそのまま両方にコピー
        _upload(MASKED_BUCKET, key, body, "application/octet-stream")
        _upload(RAW_BUCKET, key, body, "application/octet-stream")


def _mask_text(text: str) -> str:
    """テキスト全体を Comprehend に渡してPIIをマスキング"""
    chunks = _split_text(text, max_bytes=4900)
    masked_parts = []
    for chunk in chunks:
        masked_parts.append(_apply_pii_masking(chunk))
    return "".join(masked_parts)


def _mask_csv(text: str) -> str:
    """CSV の各セルを個別にマスキング"""
    reader = csv.reader(io.StringIO(text))
    rows = list(reader)
    masked_rows = []
    for row in rows:
        masked_row = [_mask_text(cell) if cell.strip() else cell for cell in row]
        masked_rows.append(masked_row)
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerows(masked_rows)
    return out.getvalue()


def _mask_json(data) -> object:
    """JSON の文字列値を再帰的にマスキング"""
    if isinstance(data, dict):
        return {k: _mask_json(v) for k, v in data.items()}
    elif isinstance(data, list):
        return [_mask_json(item) for item in data]
    elif isinstance(data, str):
        return _mask_text(data) if data.strip() else data
    return data


def _apply_pii_masking(text: str) -> str:
    """Comprehend でPIIを検出し [REDACTED:TYPE] に置換"""
    if not text.strip():
        return text
    try:
        response = comprehend.detect_pii_entities(Text=text, LanguageCode="ja")
    except Exception:
        # 英語でフォールバック
        try:
            response = comprehend.detect_pii_entities(Text=text, LanguageCode="en")
        except Exception:
            return text

    entities = sorted(response.get("Entities", []), key=lambda e: e["BeginOffset"], reverse=True)
    result = list(text)
    for entity in entities:
        begin = entity["BeginOffset"]
        end = entity["EndOffset"]
        pii_type = entity["Type"]
        placeholder = f"[REDACTED:{pii_type}]"
        result[begin:end] = list(placeholder)
    return "".join(result)


def _split_text(text: str, max_bytes: int = 4900) -> list[str]:
    """Comprehend の 5000 バイト制限に合わせてテキストを分割"""
    encoded = text.encode("utf-8")
    if len(encoded) <= max_bytes:
        return [text]
    chunks = []
    start = 0
    while start < len(encoded):
        end = start + max_bytes
        chunk_bytes = encoded[start:end]
        # UTF-8 マルチバイト文字の境界で切る
        while end > start and chunk_bytes != chunk_bytes.decode("utf-8", errors="ignore").encode("utf-8"):
            end -= 1
            chunk_bytes = encoded[start:end]
        chunks.append(chunk_bytes.decode("utf-8", errors="ignore"))
        start = end
    return chunks


def _upload(bucket: str, key: str, body: bytes, content_type: str):
    s3.put_object(Bucket=bucket, Key=key, Body=body, ContentType=content_type)
