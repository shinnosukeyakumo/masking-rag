# ロールベースマスキング RAG アプリ - 実装計画

## 1. 全体アーキテクチャ

```
┌──────────────────────────────────────────────────────────────────┐
│                  Frontend (Amplify Gen2 / React)                 │
│   - Amplify Authenticator で Cognito ログイン                     │
│   - チャット画面で RAG クエリを送信                                │
└──────────────────────┬───────────────────────────────────────────┘
                       │ HTTPS + JWT (cognito:groups を含む)
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│           AgentCore Runtime (Cognito JWT Authorizer)             │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Strands Agent (Claude Haiku 4.5)                          │  │
│  │  ┌─────────────────────────────────────────────────────┐   │  │
│  │  │ 1) JWT クレームから cognito:groups を抽出           │   │  │
│  │  │ 2) general / manager に応じて使う KB ID を切替      │   │  │
│  │  │ 3) Tool: query_knowledge_base(query, kb_id)         │   │  │
│  │  │    → bedrock-agent-runtime:Retrieve を呼び出し       │   │  │
│  │  │ 4) Haiku 4.5 が引用付きで回答生成                   │   │  │
│  │  └─────────────────────────────────────────────────────┘   │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────┬─────────────────────────┬──────────────────────┘
                  │ general                 │ manager
                  ▼                         ▼
        ┌──────────────────┐       ┌──────────────────┐
        │ Bedrock KB       │       │ Bedrock KB       │
        │ (masked)         │       │ (raw)            │
        │   ↓ Vector Store │       │   ↓ Vector Store │
        │ S3 Vectors #1    │       │ S3 Vectors #2    │
        └────────┬─────────┘       └────────┬─────────┘
                 │ Ingestion Job             │ Ingestion Job
                 ▼                           ▼
        ┌──────────────────┐       ┌──────────────────┐
        │ 子S3 (masked)    │       │ 子S3 (raw)       │
        └────────▲─────────┘       └────────▲─────────┘
                 │                          │
                 └──────────┬───────────────┘
                            │ (Lambda が両方に出力)
                ┌───────────┴─────────────┐
                │ Lambda: PII処理         │
                │  - Comprehend で検出     │
                │  - マスキング版を作成   │
                │  - 原本を raw 側へコピー │
                │  - 完了後に KB ingestion │
                │    を非同期で起動        │
                └───────────▲─────────────┘
                            │ S3:ObjectCreated EventBridge
                ┌───────────┴─────────────┐
                │ 親S3 (Source Data)      │
                └─────────────────────────┘
```

---

## 2. AWS リソース構成 (CDK スタック構成)

### 2.1 Stack 分割案
シンプル第一の方針で **1 スタック** にまとめる(規模が小さく依存関係も単純なため)。
構成が育ったら以下に分割可能:
- `AuthStack` (Cognito)
- `DataStack` (S3 群 + Lambda + Comprehend IAM)
- `RagStack` (Bedrock KB x2 + S3 Vectors x2)
- `AgentStack` (AgentCore Runtime + IAM)

### 2.2 主要リソース一覧
| カテゴリ | リソース | 補足 |
|---|---|---|
| Auth | Cognito User Pool | グループ `general`, `manager` を作成 |
| Auth | Cognito User Pool Client | Amplify 用、SRP 認証 |
| Auth | Cognito Identity Pool | 不要(Runtime は JWT のみで十分) |
| Storage | S3 親バケット | バージョニング + SSE-KMS + パブリックアクセスブロック |
| Storage | S3 子バケット (masked) | 同上 |
| Storage | S3 子バケット (raw) | 同上 |
| Process | Lambda `pii-processor` | Python 3.13, ARM64, 1024MB, 5min |
| Process | Lambda Layer | boto3 最新 + 共通ユーティリティ |
| Event | EventBridge Rule (or S3 Notification) | 親S3 → Lambda |
| AI | Bedrock Knowledge Base (masked) | S3 Vectors バックエンド |
| AI | Bedrock Knowledge Base (raw) | 同上 |
| AI | S3 Vectors Bucket (masked) | `s3vectors create-vector-bucket` |
| AI | S3 Vectors Bucket (raw) | 同上 |
| AI | S3 Vectors Index (masked) | Titan Embeddings v2 想定(1024次元) |
| AI | S3 Vectors Index (raw) | 同上 |
| Agent | AgentCore Runtime | Cognito JWT Authorizer, Haiku 4.5 |
| Agent | ECR Repository | Runtime コンテナイメージ用 |
| Agent | IAM Role (Runtime 実行ロール) | bedrock-agent-runtime:Retrieve, bedrock:InvokeModel |

### 2.3 Well-Architected の観点
- **セキュリティ**: 全 S3 SSE-KMS、パブリックアクセスブロック、IAM 最小権限、Cognito JWT による多段認証
- **信頼性**: Lambda リトライ + DLQ (SQS)、KB Ingestion Job の失敗監視 (CloudWatch Alarm)
- **コスト**: S3 Vectors (OpenSearch Serverless より大幅に安価)、Haiku 4.5 (Sonnet より安価)、Lambda ARM64
- **運用**: 全リソースに `Project: rag-masking` タグ、CloudWatch Logs に統一出力
- **持続可能性**: ARM64 採用、S3 ライフサイクル(古い親データのアーカイブ化)

---

## 3. ディレクトリ構成

```
RAG-masking/
├── tasks/
│   ├── todo.md             ← 本ファイル
│   └── lessons.md          ← 学び蓄積用
├── infra/                  ← CDK プロジェクト (TypeScript)
│   ├── bin/app.ts
│   ├── lib/
│   │   ├── rag-masking-stack.ts
│   │   └── constructs/
│   │       ├── auth.ts          ← Cognito
│   │       ├── data-pipeline.ts ← S3 x3 + Lambda
│   │       ├── knowledge-base.ts← Bedrock KB x2 + S3 Vectors x2
│   │       └── agent-runtime.ts ← AgentCore Runtime
│   ├── lambda/
│   │   └── pii-processor/
│   │       ├── handler.py
│   │       └── requirements.txt
│   ├── package.json
│   └── cdk.json
├── agent/                  ← AgentCore Runtime のソース
│   ├── agent.py            ← Strands Agent (Haiku 4.5)
│   ├── tools.py            ← query_knowledge_base ツール
│   ├── Dockerfile
│   └── requirements.txt
├── frontend/               ← Amplify Gen2
│   ├── amplify/
│   │   ├── auth/resource.ts
│   │   └── backend.ts
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── Login.tsx       ← Amplify Authenticator
│   │   │   └── ChatView.tsx
│   │   └── lib/agent-client.ts ← AgentCore Runtime 呼び出し
│   ├── package.json
│   └── vite.config.ts
└── README.md
```

---

## 4. 実装フェーズ

### Phase 0: 準備 (1h 想定)
- [ ] `npm install` 系の前提確認 (Node.js 20+, AWS CDK 2.x, Python 3.13)
- [ ] AWS 認証 (`aws login`) と検証リージョンの確定 (`us-east-1` 推奨)
- [ ] Bedrock の Haiku 4.5 / Titan Embeddings v2 のモデルアクセス有効化を確認

### Phase 1: CDK インフラ構築 (順序が重要)
- [ ] 1-1. CDK プロジェクト初期化 (`cdk init app --language typescript`)
- [ ] 1-2. Auth Construct (Cognito User Pool + Group `general`/`manager`)
- [ ] 1-3. Data Pipeline Construct (S3 x3 + Lambda + 通知)
  - [ ] PII 処理 Lambda の実装 (Comprehend `DetectPiiEntities`)
  - [ ] テキスト/Markdown/CSV/JSON 別のマスキング戦略を実装
  - [ ] 完了後に 2 つの KB の `StartIngestionJob` を呼び出す
- [ ] 1-4. KnowledgeBase Construct
  - [ ] S3 Vectors bucket + index x2 (CustomResource で API 呼び出し)
  - [ ] Bedrock KB x2 + DataSource x2
- [ ] 1-5. Agent Runtime Construct
  - [ ] ECR repository
  - [ ] AgentCore Runtime (Cognito JWT Authorizer 紐付け)
  - [ ] 実行ロール (KB Retrieve 権限のみ)
- [ ] 1-6. `cdk synth` → `cdk deploy` で初回デプロイ

### Phase 2: AgentCore Runtime 実装
- [ ] 2-1. Strands Agent 雛形 (`agent.py`)
- [ ] 2-2. JWT クレーム取得 (Runtime のコンテキストから `cognito:groups` を読む)
- [ ] 2-3. KB クエリツール (`bedrock-agent-runtime.Retrieve` をラップ)
- [ ] 2-4. ロールに応じて使う KB ID を切替 + 「答えられません」のフォールバック
- [ ] 2-5. Dockerfile 作成 + ECR への push + Runtime 更新

### Phase 3: Frontend (Amplify Gen2)
- [ ] 3-1. Amplify Gen2 プロジェクト初期化 (`npm create amplify@latest`)
- [ ] 3-2. `amplify/auth/resource.ts` で User Pool を CDK 側と連携
   - **重要**: Amplify が User Pool を作るのではなく、CDK で作った User Pool を import する形にする(役職管理を CDK 側に寄せるため)
- [ ] 3-3. Authenticator + チャット UI
- [ ] 3-4. AgentCore Runtime 呼び出し (SigV4 不要、JWT を Authorization ヘッダで渡す)
- [ ] 3-5. ローカル動作確認 (`npm run dev`)
- [ ] 3-6. Amplify Hosting にデプロイ

### Phase 4: E2E 検証
- [ ] 4-1. 親 S3 に氏名・電話番号を含むサンプル CSV を投入
- [ ] 4-2. 両方の子 S3 に正しくマスキング/原本がコピーされていることを確認
- [ ] 4-3. KB ingestion が成功し、Vectors にデータが入っていることを確認
- [ ] 4-4. 一般職アカウントで質問 → センシティブ情報がマスキングされて返ることを確認
- [ ] 4-5. 管理職アカウントで同じ質問 → 完全なデータが返ることを確認
- [ ] 4-6. ロール詐称テスト (一般職の JWT で manager KB にアクセスできないこと)

---

## 5. 重要な技術判断と理由

### 5.1 なぜ Bedrock KB + S3 Vectors か
- **理由**: マネージドサービスでチャンク化・埋め込み・同期を自動化できる。S3 Vectors は OpenSearch Serverless より大幅に安価で、検証用途に最適。
- **代替**: OpenSearch Serverless (高機能だが固定費が高い)、自前 Lambda + s3vectors API (柔軟だが運用負荷大)
- **トレードオフ**: KB はチャンク戦略のカスタマイズが限定的。要件が高度になったら自前実装に切り替える。

### 5.2 なぜ Gateway を使わないか (ユーザー要件)
- AgentCore Runtime 内で直接 `bedrock-agent-runtime.Retrieve` を呼ぶ。
- Gateway は外部 API/MCP サーバー接続用途で、今回は AWS 内ツールのみなので不要。
- メリット: 構成がシンプル、レイテンシが低い。
- デメリット: ツールの追加・差し替えが Runtime 再デプロイになる。

### 5.3 なぜ 2 つの KB に分けるか
- **権限境界の明確化**: 一般職用 Runtime ロールは raw KB に対する Retrieve 権限を持たない。コードバグでも raw データに到達不可能。
- **代替**: 1 つの KB + メタデータフィルタ → コードバグやプロンプトインジェクションで漏洩リスクあり。
- **コスト影響**: ベクトル保存料が 2 倍になるが、S3 Vectors なので絶対額は小さい。

### 5.4 マスキング戦略 (Comprehend)
- `DetectPiiEntities` で検出した PII エンティティを `[REDACTED:TYPE]` 形式に置換 (例: `[REDACTED:NAME]`, `[REDACTED:PHONE]`)
- 検出対象: NAME, ADDRESS, PHONE, EMAIL, SSN相当, CREDIT_CARD, DATE_TIME(誕生日), AGE
- CSV/JSON は値部分のみ走査(キー名はマスクしない)

---

## 6. リスクと対策

| リスク | 影響 | 対策 |
|---|---|---|
| Comprehend の日本語 PII 検出精度 | マスキング漏れ → 漏洩 | テストデータで精度測定し、必要なら正規表現で補強。あるいは Bedrock LLM 検出をハイブリッド化 |
| AgentCore Runtime の JWT クレーム取得方法 | 実装ブロッカー | デプロイ前に kb-agentcore-cdk スキルを確認、サンプルで疎通確認 |
| S3 Vectors のリージョン制限 | デプロイ不可 | us-east-1 で実施。GA 状況を最新ドキュメントで確認 |
| Bedrock KB の ingestion 遅延 | UX 悪化 | ingestion 進捗を UI で表示するか、明示的なボタン化 |
| Cognito Groups が JWT に乗らない | 認可失敗 | App Client で `cognito:groups` クレームを有効化、access token ではなく id token を使う |

---

## 7. デプロイ & E2E 検証手順 (実装完了)

### Step 1: AWS 認証
```bash
aws login   # ブラウザで認証
```

### Step 2: CDK Bootstrap & Deploy
```bash
cd infra
npx cdk bootstrap aws://ACCOUNT_ID/us-west-2
npx cdk deploy --require-approval never
```

### Step 3: .env を自動生成
```bash
cd ..
bash scripts/export-env.sh   # .env が生成される
```

### Step 4: Bedrock モデルアクセス有効化
AWS コンソール → Bedrock → Model access で以下を有効化:
- `amazon.titan-embed-text-v2:0` (埋め込みモデル)
- `us.anthropic.claude-haiku-4-5-20251001-v1:0` (エージェントモデル)

### Step 5: Cognito ユーザー作成
```bash
# 一般職ユーザー
aws cognito-idp admin-create-user --user-pool-id POOL_ID \
  --username general@example.com --temporary-password Temp1234!

aws cognito-idp admin-add-user-to-group --user-pool-id POOL_ID \
  --username general@example.com --group-name general

# 管理職ユーザー
aws cognito-idp admin-create-user --user-pool-id POOL_ID \
  --username manager@example.com --temporary-password Temp1234!

aws cognito-idp admin-add-user-to-group --user-pool-id POOL_ID \
  --username manager@example.com --group-name manager
```

### Step 6: テストデータ投入
```bash
# 氏名・電話番号を含む CSV を親S3にアップロード
cat > /tmp/test.csv << 'EOF'
社員ID,氏名,部署,電話番号,メール
001,山田太郎,営業部,090-1234-5678,yamada@example.com
002,鈴木花子,人事部,080-9876-5432,suzuki@example.com
EOF

SOURCE_BUCKET=$(aws cloudformation describe-stacks --stack-name RagMaskingStack \
  --query "Stacks[0].Outputs[?OutputKey=='DataPipelineSourceBucketName'].OutputValue" \
  --output text)

aws s3 cp /tmp/test.csv s3://${SOURCE_BUCKET}/employees.csv
```

### Step 7: マスキング確認
```bash
MASKED_BUCKET=$(aws cloudformation describe-stacks --stack-name RagMaskingStack \
  --query "Stacks[0].Outputs[?OutputKey=='DataPipelineMaskedBucketName'].OutputValue" \
  --output text)

aws s3 cp s3://${MASKED_BUCKET}/employees.csv - | cat
# 期待: 氏名・電話番号が [REDACTED:NAME] [REDACTED:PHONE_NUMBER] に置換されている
```

### Step 8: フロントエンド起動
```bash
npm run dev   # http://localhost:5173 で起動
```

### Step 9: E2E テスト
1. 一般職アカウントでログイン → 「山田太郎の電話番号を教えて」と質問
   - 期待: `[REDACTED:PHONE_NUMBER]` が返るか「情報がない」
2. 管理職アカウントでログイン → 同じ質問
   - 期待: `090-1234-5678` が返る

### チェックリスト
- [ ] PII Lambda が親S3 → 子S3 双方向コピーを実行
- [ ] masked-bucket の CSV が正しくマスキングされている
- [ ] KB ingestion が自動起動 (CloudWatch Logs で確認)
- [ ] 一般職: センシティブデータが応答に含まれない
- [ ] 管理職: 完全なデータが応答に含まれる
- [ ] AgentCore ロール詐称テスト (JWT を改ざんしても拒否される)

---

## 確定事項 (2026-05-16 ユーザー承認)

| 項目 | 決定 | 理由 |
|---|---|---|
| マスキング検出 | Amazon Comprehend `DetectPiiEntities` | 日本語 PII を高精度で検出。サーバーレスでシンプル |
| 対応データ形式 | テキスト/Markdown + CSV/JSON | 構造化と非構造化の両方をサポート |
| ロール識別 | Cognito User Pool Groups (`general` / `manager`) | JWT の `cognito:groups` クレームで判定。標準的 |
| KB 同期方法 | Bedrock Knowledge Base + S3 Vectors | マネージドで運用負荷小。S3 Vectors は OpenSearch より大幅に安価 |
| CDK 言語 | TypeScript | Amplify Gen2 と統一でき、型サポートが手厚い |
| Stack 分割 | 1スタック統合 (Construct で関心分離) | 検証フェーズはシンプル第一。`cdk deploy` 一発 |
| マスク表記 | `[REDACTED:TYPE]` 形式 | タイプ情報を残すことで LLM の誤推論を防げる |
| リージョン | `us-west-2` (オレゴン) | AgentCore / Bedrock KB / S3 Vectors / Haiku 4.5 全対応 |
| フロント管理 | `frontend/` を分離、`npx ampx sandbox` で開発 | CDK と Amplify を疎結合。CDK の Cognito を Amplify に import |
