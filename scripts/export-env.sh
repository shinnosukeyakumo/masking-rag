#!/bin/bash
# CDK デプロイ後に実行して .env を自動生成するスクリプト
# 使い方: bash scripts/export-env.sh

STACK_NAME="RagMaskingStack"
REGION="us-west-2"

echo "[$STACK_NAME] の出力を取得中..."

# ExportName で取得（CDK が付与するランダムサフィックスに依存しない）
get_by_export() {
  aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --query "Stacks[0].Outputs[?ExportName=='$1'].OutputValue" \
    --output text
}

USER_POOL_ID=$(get_by_export "RagMaskingUserPoolId")
USER_POOL_CLIENT_ID=$(get_by_export "RagMaskingUserPoolClientId")
AGENT_ARN=$(get_by_export "RagMaskingAgentRuntimeArn")

cat > .env <<EOF
VITE_USER_POOL_ID=${USER_POOL_ID}
VITE_USER_POOL_CLIENT_ID=${USER_POOL_CLIENT_ID}
VITE_AGENT_RUNTIME_ARN=${AGENT_ARN}
EOF

echo ".env を生成しました:"
cat .env
