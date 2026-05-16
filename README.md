# RAG Masking App

ロールベースのレスポンスマスキングを実現した RAG アプリケーション。
- 一般職: マスキング済みデータを参照（PII は `[REDACTED:TYPE]` で置換）
- 管理職: 非マスキングデータを参照（完全なデータ）

## アーキテクチャ

```
親S3 (ソース) → Lambda (Comprehend PII検出) → 子S3 (masked) ┐
                                          └→ 子S3 (raw)    ├→ Bedrock KB ×2 (S3 Vectors)
                                                            ↓
                            AgentCore Runtime (Strands + Haiku 4.5)
                            └ JWT の cognito:groups でロール判定
                                                            ↓
                                    Amplify Hosting (React + Authenticator)
                                                            ↓
                                Cognito User Pool (general / manager)
```

## 技術スタック

- **インフラ**: AWS CDK (TypeScript)
- **認証**: Amazon Cognito User Pool + Groups
- **ストレージ**: S3 × 3、S3 Vectors × 2
- **データ処理**: Lambda (Python) + Amazon Comprehend
- **ナレッジベース**: Bedrock Knowledge Base + S3 Vectors
- **エージェント**: AgentCore Runtime + Strands Agents (Claude Haiku 4.5)
- **フロントエンド**: React + Vite + AWS Amplify UI

## ディレクトリ構成

```
RAG-masking/
├── infra/            # AWS CDK (バックエンド全体)
├── agent/            # AgentCore Runtime のソース
├── src/              # React フロントエンド
├── amplify/          # Amplify 設定（最小限）
├── scripts/          # ユーティリティスクリプト
└── tasks/            # 計画書・学び
```

## デプロイ手順

### 1. 前提条件
- AWS CLI 認証済み (`aws login`)
- Node.js 20+, npm
- リージョン: `us-west-2`
- Bedrock モデルアクセスを有効化:
  - `amazon.titan-embed-text-v2:0`
  - `us.anthropic.claude-haiku-4-5-20251001-v1:0`

### 2. CDK デプロイ（バックエンド一式）

```bash
cd infra
npx cdk bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/us-west-2
npx cdk deploy
cd ..
```

### 3. 環境変数を生成

```bash
bash scripts/export-env.sh
```

`.env` ファイルが生成されます。**このファイルは Git にコミットしないでください**（`.gitignore` 済み）。

### 4. ローカル動作確認（任意）

```bash
npm install
npm run dev
```

http://localhost:5173 を開いてサインアップ → ログイン。

### 5. Amplify Hosting にデプロイ

GitHub にプッシュ後、AWS Amplify Console で：
1. 「New app」→「Host web app」
2. GitHub 連携してリポジトリ選択
3. ビルド設定は `amplify.yml` を自動検出
4. **環境変数を設定**（重要）:
   - `VITE_USER_POOL_ID`
   - `VITE_USER_POOL_CLIENT_ID`
   - `VITE_AGENT_RUNTIME_ARN`
5. 「Save and deploy」

数分後、`https://main.dXXXXX.amplifyapp.com` でアクセス可能になります。

## ユーザー作成

セルフサインアップが有効です。

- UI からサインアップしたユーザーは自動的に **一般職** 扱い
- **管理職** にしたい場合は CLI でグループ追加:

```bash
USER_POOL_ID=$(aws cloudformation describe-stacks \
  --stack-name RagMaskingStack --region us-west-2 \
  --query "Stacks[0].Outputs[?contains(OutputKey,'UserPoolId')]|[?!contains(OutputKey,'Client')].OutputValue" \
  --output text)

aws cognito-idp admin-add-user-to-group \
  --user-pool-id $USER_POOL_ID \
  --username your@email.com \
  --group-name manager \
  --region us-west-2
```

グループ変更後は **ログアウト→再ログイン** が必要（トークンに反映されるため）。

## データ投入

親S3にファイルを置くだけで自動的にマスキング → 子S3 → KB同期が走ります。

```bash
SOURCE_BUCKET=rag-masking-source-$(aws sts get-caller-identity --query Account --output text)
aws s3 cp ./mydata.csv s3://${SOURCE_BUCKET}/ --region us-west-2
```

対応形式: `.txt`, `.md`, `.csv`, `.json`

## クリーンアップ

```bash
cd infra
npx cdk destroy
```

S3 バケットと S3 Vector Bucket は `RETAIN` 設定なので、コンソールで手動削除が必要です（誤削除防止のため）。
