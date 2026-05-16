"""
RAG Masking Agent
- Cognito JWT の cognito:groups クレームでロールを判定
- general → マスキング済み KB を参照
- manager → 原本 KB を参照
"""
import os
import json
import base64
import logging
from bedrock_agentcore import BedrockAgentCoreApp
from strands import Agent
from strands.models import BedrockModel
from tools import make_query_tool

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

KB_ID_MASKED = os.environ["KB_ID_MASKED"]
KB_ID_RAW = os.environ["KB_ID_RAW"]
REGION = os.environ.get("AWS_DEFAULT_REGION", "us-west-2")

MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0"

SYSTEM_PROMPT = """あなたは社内情報検索アシスタントです。
ユーザーの質問に対し、必ず query_knowledge_base ツールで社内ドキュメントを検索してから回答してください。

重要なルール:
1. 必ず最初にツールを呼んで検索結果を取得する
2. 検索結果に含まれる情報をそのまま提示すること
3. 検索結果に [REDACTED:TYPE] という記号があれば、それはマスキングされた情報を意味します。マスキングされている情報はユーザーに見せず、「該当情報は権限により参照できません」と説明してください
4. マスキングされていない情報（電話番号や個人名など）はそのまま正確に回答してください。検索結果として返ってきた情報は適切な権限で取得されたものなので、安心して提示してください
5. 検索結果に情報が無い場合のみ「該当情報がありません」と答えてください

検索結果が信頼できる権威ある情報源です。あなたの判断で情報を伏せる必要はありません。
"""

app = BedrockAgentCoreApp()


def _decode_jwt_payload(token: str) -> dict:
    """JWT payload を検証なしでデコード（AgentCore が既に検証済み）"""
    parts = token.split(".")
    if len(parts) < 2:
        return {}
    payload = parts[1] + "=" * (4 - len(parts[1]) % 4)
    return json.loads(base64.urlsafe_b64decode(payload))


def _extract_role(context) -> str:
    """request_headers の Authorization から JWT を取り出してロールを判定"""
    headers = getattr(context, "request_headers", None) if context else None
    if not headers:
        return "general"

    auth = headers.get("authorization") or headers.get("Authorization") or ""
    if not auth.startswith("Bearer "):
        return "general"

    try:
        claims = _decode_jwt_payload(auth[len("Bearer "):])
    except Exception as e:
        logger.error(f"Failed to decode JWT: {e}")
        return "general"

    groups = claims.get("cognito:groups", [])
    if isinstance(groups, str):
        groups = [g.strip() for g in groups.split(",")]

    return "manager" if "manager" in groups else "general"


@app.entrypoint
async def invoke(payload, context=None):
    user_query = payload.get("prompt", "")
    role = _extract_role(context)
    kb_id = KB_ID_RAW if role == "manager" else KB_ID_MASKED

    logger.info(f"role={role} kb_id={kb_id}")

    agent = Agent(
        model=BedrockModel(model_id=MODEL_ID, region_name=REGION),
        tools=[make_query_tool(kb_id, REGION)],
        system_prompt=SYSTEM_PROMPT,
    )

    async for event in agent.stream_async(user_query):
        if "data" in event:
            yield {"type": "text", "data": event["data"]}
        elif "current_tool_use" in event:
            yield {"type": "tool_use", "data": event["current_tool_use"].get("name", "")}


if __name__ == "__main__":
    app.run()
