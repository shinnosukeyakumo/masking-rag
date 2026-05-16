"""
AgentCore ツール定義
query_knowledge_base: 指定KBにクエリを送り、関連チャンクを返す
"""
import boto3
from strands import tool


def make_query_tool(kb_id: str, region: str):
    """
    KB ID を閉じ込めた query_knowledge_base ツールを返す。
    ロールに応じて異なる KB ID を注入するためファクトリ関数を使う。
    """
    bedrock_runtime = boto3.client("bedrock-agent-runtime", region_name=region)

    @tool
    def query_knowledge_base(query: str) -> str:
        """
        社内ナレッジベースを検索して関連情報を取得します。
        ユーザーの質問に答えるために使用してください。

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

            passages = []
            for i, result in enumerate(results, 1):
                content = result.get("content", {}).get("text", "")
                score = result.get("score", 0)
                passages.append(f"[参照{i}] (関連度: {score:.2f})\n{content}")

            return "\n\n".join(passages)

        except Exception as e:
            print(f"[ERROR] KB retrieve failed: {e}")
            return f"ナレッジベースの検索中にエラーが発生しました: {str(e)}"

    return query_knowledge_base
