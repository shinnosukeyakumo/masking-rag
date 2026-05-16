import { Construct } from 'constructs';
import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as cdk from 'aws-cdk-lib';
import * as path from 'path';

export interface AgentRuntimeConstructProps {
  userPool: cognito.IUserPool;
  userPoolClient: cognito.IUserPoolClient;
  maskedKbId: string;
  rawKbId: string;
}

export class AgentRuntimeConstruct extends Construct {
  readonly runtime: agentcore.Runtime;

  constructor(scope: Construct, id: string, props: AgentRuntimeConstructProps) {
    super(scope, id);

    // Agent 実行ロール
    const executionRole = new iam.Role(this, 'AgentExecutionRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
    });

    // Haiku 4.5 クロスリージョン推論プロファイル
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
      ],
      resources: [
        'arn:aws:bedrock:*::foundation-model/*',
        'arn:aws:bedrock:*:*:inference-profile/*',
      ],
    }));

    // 両 KB の Retrieve 権限（ロール判定はエージェントコード内で行う）
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'bedrock:Retrieve',
        'bedrock:RetrieveAndGenerate',
      ],
      resources: [
        `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:knowledge-base/${props.maskedKbId}`,
        `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:knowledge-base/${props.rawKbId}`,
      ],
    }));

    // CloudWatch Logs への書き込み
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'logs:DescribeLogGroups',
        'logs:DescribeLogStreams',
      ],
      resources: ['*'],
    }));

    // AgentCore Runtime (コンテナイメージは agent/ ディレクトリからビルド)
    this.runtime = new agentcore.Runtime(this, 'AgentRuntime', {
      runtimeName: 'RagMaskingAgent',
      agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromAsset(
        path.join(__dirname, '../../../agent'),
      ),
      executionRole,
      authorizerConfiguration: agentcore.RuntimeAuthorizerConfiguration.usingCognito(
        props.userPool,
        [props.userPoolClient],
        undefined, // allowedAudience: access token には audience チェック不要
        undefined, // allowedScopes
        undefined, // customClaims
      ),
      environmentVariables: {
        KB_ID_MASKED: props.maskedKbId,
        KB_ID_RAW: props.rawKbId,
        AWS_DEFAULT_REGION: cdk.Aws.REGION,
      },
      tracingEnabled: true,
    });

    new cdk.CfnOutput(this, 'AgentRuntimeArn', {
      value: this.runtime.agentRuntimeArn,
      exportName: 'RagMaskingAgentRuntimeArn',
    });
  }
}
