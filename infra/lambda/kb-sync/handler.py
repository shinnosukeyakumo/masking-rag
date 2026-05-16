"""
KB Sync Lambda
子S3にファイルが書き込まれたとき、対応する Bedrock Knowledge Base の
IngestionJob を起動してベクトルインデックスを更新する。
"""
import os
import uuid
import boto3

MASKED_KB_ID = os.environ["MASKED_KB_ID"]
MASKED_DS_ID = os.environ["MASKED_DS_ID"]
RAW_KB_ID = os.environ["RAW_KB_ID"]
RAW_DS_ID = os.environ["RAW_DS_ID"]
MASKED_BUCKET = os.environ["MASKED_BUCKET"]
RAW_BUCKET = os.environ["RAW_BUCKET"]

bedrock_agent = boto3.client("bedrock-agent", region_name=os.environ.get("AWS_DEFAULT_REGION", "us-west-2"))


def lambda_handler(event, _context):
    for record in event["Records"]:
        bucket = record["s3"]["bucket"]["name"]
        if bucket == MASKED_BUCKET:
            _start_ingestion(MASKED_KB_ID, MASKED_DS_ID)
        elif bucket == RAW_BUCKET:
            _start_ingestion(RAW_KB_ID, RAW_DS_ID)


def _start_ingestion(kb_id: str, ds_id: str):
    try:
        resp = bedrock_agent.start_ingestion_job(
            knowledgeBaseId=kb_id,
            dataSourceId=ds_id,
            clientToken=str(uuid.uuid4()),
        )
        job_id = resp["ingestionJob"]["ingestionJobId"]
        print(f"[INFO] Started ingestion job {job_id} for KB {kb_id}")
    except bedrock_agent.exceptions.ConflictException:
        # すでに実行中の場合は何もしない
        print(f"[INFO] Ingestion already running for KB {kb_id}")
    except Exception as e:
        print(f"[ERROR] Failed to start ingestion for KB {kb_id}: {e}")
        raise
