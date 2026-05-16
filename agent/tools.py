"""
AgentCore ツール定義
query_knowledge_base: 指定KBにクエリを送り、関連チャンクを返す
"""
import logging
import boto3
from strands import tool

logger = logging.getLogger(__name__)


def make_query_tool(kb_id: str, region: str):
    """ロールごとに異なる KB ID を閉じ込めた query_knowledge_base ツールを返すファクトリ"""
    bedrock_runtime = boto3.client("bedrock-agent-runtime", region_name=region)

    @tool
    def query_knowledge_base(query: str) -> str:
        """
        社内ナレッジベースを検索して関連情報を取得します。

        Args:
            query: 検索クエリ（日本語可）

        Returns:
            ナレッジベースから取得した関連テキスト
        """
        try:
            response = bedrock_runtime.retrieve(
                knowledgeBaseId=kb_id,
                retrievalQuery={"text": query},
                retrievalConfiguration={
                    "vectorSearchConfiguration": {
                        "numberOfResults": 5,
                        "overrideSearchType": "SEMANTIC",
                    }
                },
            )
            results = response.get("retrievalResults", [])
            if not results:
                return "関連する情報が見つかりませんでした。"

            return "\n\n".join(
                f"[参照{i}] (関連度: {r.get('score', 0):.2f})\n{r.get('content', {}).get('text', '')}"
                for i, r in enumerate(results, 1)
            )
        except Exception as e:
            logger.error(f"KB retrieve failed: {e}")
            return f"ナレッジベースの検索中にエラーが発生しました: {e}"

    return query_knowledge_base
