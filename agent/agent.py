"""
RAG Masking Agent
- Cognito JWT の cognito:groups クレームでロールを判定
- general → マスキング済み KB を参照
- manager → 原本 KB を参照
"""
import os
import json
import boto3
from bedrock_agentcore import BedrockAgentCoreApp
from strands import Agent
from strands.models import BedrockModel
from tools import make_query_tool

KB_ID_MASKED = os.environ["KB_ID_MASKED"]
KB_ID_RAW = os.environ["KB_ID_RAW"]
REGION = os.environ.get("AWS_DEFAULT_REGION", "us-west-2")

MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0"

SYSTEM_PROMPT = """あなたは社内情報を検索して回答するアシスタントです。
ユーザーの質問に対して、提供された社内ドキュメントをもとに正確に回答してください。
ドキュメントに情報がない場合は「ドキュメントに該当情報がありませんでした。」と答えてください。
センシティブな情報について質問された場合は、参照できる情報のみをそのまま回答してください。
"""

app = BedrockAgentCoreApp()


def _extract_role(context) -> str:
    """
    AgentCore Runtime のコンテキストから cognito:groups を読み取り
    'manager' グループなら 'manager'、それ以外は 'general' を返す
    """
    try:
        # context は dict-like または属性アクセス可
        if hasattr(context, "identity"):
            identity = context.identity
        elif isinstance(context, dict):
            identity = context.get("identity", {})
        else:
            return "general"

        # JWT クレームは identity.claims または identity.jwt_claims に格納
        claims = {}
        if hasattr(identity, "claims"):
            claims = identity.claims or {}
        elif isinstance(identity, dict):
            claims = identity.get("claims", identity.get("jwt_claims", {}))

        groups = claims.get("cognito:groups", "")
        if isinstance(groups, str):
            groups = groups.split(",")
        if "manager" in groups:
            return "manager"
    except Exception as e:
        print(f"[WARN] Failed to extract role from context: {e}")
    return "general"


@app.entrypoint
async def invoke(payload, context=None):
    user_query = payload.get("prompt", "")
    role = _extract_role(context)
    kb_id = KB_ID_RAW if role == "manager" else KB_ID_MASKED

    print(f"[INFO] role={role} kb_id={kb_id} query={user_query[:80]}")

    query_tool = make_query_tool(kb_id, REGION)

    model = BedrockModel(
        model_id=MODEL_ID,
        region_name=REGION,
    )

    agent = Agent(
        model=model,
        tools=[query_tool],
        system_prompt=SYSTEM_PROMPT,
    )

    async for event in agent.stream_async(user_query):
        if "data" in event:
            yield {"type": "text", "data": event["data"]}
        elif "current_tool_use" in event:
            tool_name = event["current_tool_use"].get("name", "")
            yield {"type": "tool_use", "data": tool_name}


if __name__ == "__main__":
    app.run()
