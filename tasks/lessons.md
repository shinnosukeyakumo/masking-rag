# Lessons Learned

このプロジェクトを通じて八雲から受けた修正・指摘や、得られたパターンを記録するファイルです。

セッション開始時にこのファイルを必ずレビューし、同じミスを繰り返さないようにします。

---

## 1. `cdk.Fn.sub()` にテンプレートリテラルで CDK トークンを混ぜない (2026-05-16)

### 失敗パターン
```typescript
// NG: ValidationError: Fn::Sub intrinsic functions don't specify expected arguments
vectorBucketArn: cdk.Fn.sub(
  `arn:aws:s3vectors:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:bucket/foo`,
),
```

TypeScript のテンプレートリテラルが `${cdk.Aws.REGION}` を CDK トークン `${Token[AWS.Region.4]}` に展開してから `Fn::Sub` に渡るため、CFn 側では「`${Token[...]}` というプレースホルダの値が指定されていない」エラーになる。

### 正しい使い方
1. **`Fn::Sub` が不要なケース**: そのままテンプレートリテラルで CFn 組み込み関数なしで使う
2. **属性が用意されているケース**: `attrXxxArn` のような Cfn 属性を使う

```typescript
// OK: 属性アクセスで ARN を取得
vectorBucketArn: vectorBucket.attrVectorBucketArn,
indexArn: vectorIndex.attrIndexArn,

// OK: 単純なテンプレートリテラル（Fn::Sub なし）
const arn = `arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/${MODEL_ID}`;
```

`cdk.Fn.sub()` を使うのは、CFn テンプレートに `${VarName}` プレースホルダを残して CFn 実行時に値を入れさせたい時のみ。CDK トークンは TypeScript レベルで先に解決されるので `Fn::Sub` の出番はほぼない。

**How to apply**: ARN を組み立てる時は `attrXxxArn` プロパティを最優先で探す。なければ単純なテンプレートリテラル。`Fn.sub` は使わない。

---

## 2. AgentCore Runtime で JWT クレームを取得する方法 (2026-05-16)

### 罠
- `context.workload_access_token` → **存在しない属性**
- `context.request_headers` → デフォルトでは **`None`**（ヘッダーがコンテナに渡されない）

### 正しい設定

**CDK側 (RequestHeaderConfiguration)**:
```typescript
new agentcore.Runtime(this, 'AgentRuntime', {
  // ...
  requestHeaderConfiguration: {
    allowlistedHeaders: ['Authorization'],  // 個別ヘッダーをホワイトリスト指定
  },
});
```
- `allowlistedHeaders` で明示的に許可しないと `request_headers` は `None`
- ワイルドカード `*` は使えない（`Request header must contain only letters, numbers, and hyphens` エラー）
- ヘッダー名はハイフン区切りの正確な名前を指定する

**Agent側 (Python)**:
```python
def _extract_role(context) -> str:
    headers = context.request_headers  # CDK で allowlist 設定済み前提
    auth = headers.get("authorization") or headers.get("Authorization") or ""
    if not auth.startswith("Bearer "):
        return "general"
    token = auth[len("Bearer "):]
    
    # JWT は AgentCore が検証済みなので signature 検証なしで payload デコードでOK
    parts = token.split(".")
    payload = parts[1] + "=" * (4 - len(parts[1]) % 4)
    claims = json.loads(base64.urlsafe_b64decode(payload))
    
    groups = claims.get("cognito:groups", [])
    return "manager" if "manager" in groups else "general"
```

### なぜ Cognito **アクセストークン** か
- ID トークン: クライアントIDが `aud` クレームに入る
- アクセストークン: クライアントIDが `client_id` クレームに入る
- AgentCore の `usingCognito` は `client_id` クレームを検証するため、**アクセストークンが必須**
- フロントは `session.tokens?.accessToken?.toString()` を使う

### ログ系の注意点
- `print()` は CloudWatch に出ないことがある
- Python の `logging` モジュール経由で `logger.info()` を使うのが確実

**How to apply**: AgentCore Runtime で JWT クレームを使いたいなら、CDK で `allowlistedHeaders: ['Authorization']` を必ず設定する。Agent コードは `context.request_headers` から手動で Bearer トークンを抽出する。

---

## 3. AgentCore コンテナのキャッシュとセッション (2026-05-16)

- AgentCore Runtime は `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` ヘッダーごとにコンテナをキャッシュ
- 同じセッションIDで呼ぶと**古いコンテナ（古いコード）が再利用される**
- `cdk deploy` でコード更新しても、既存セッションはそのまま動き続ける

### 反映させる方法
1. ブラウザのタブを完全に閉じる → 新セッションIDで新コンテナ起動（推奨）
2. もしくは `aws bedrock-agentcore stop-runtime-session` で強制停止

**How to apply**: Agent コードを更新したら、デプロイ後にフロントエンドのセッションを必ず切り直す。ブラウザリロード（F5）ではなく**タブを閉じて再度開く**のが確実。

