/**
 * CDK デプロイ後に aws cloudformation describe-stacks で取得した値を設定してください。
 * 例: npx ts-node scripts/export-config.ts で自動生成可能
 */
export const CONFIG = {
  region: 'us-west-2',
  userPoolId: import.meta.env.VITE_USER_POOL_ID || '',
  userPoolClientId: import.meta.env.VITE_USER_POOL_CLIENT_ID || '',
  agentRuntimeArn: import.meta.env.VITE_AGENT_RUNTIME_ARN || '',
};
