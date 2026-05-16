import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { AuthConstruct } from './constructs/auth';
import { DataPipelineConstruct } from './constructs/data-pipeline';
import { KnowledgeBaseConstruct } from './constructs/knowledge-base';
import { AgentRuntimeConstruct } from './constructs/agent-runtime';

export class RagMaskingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- 認証 ---
    const auth = new AuthConstruct(this, 'Auth');

    // --- データパイプライン (S3 x3 + PII Lambda) ---
    const dataPipeline = new DataPipelineConstruct(this, 'DataPipeline');

    // --- ナレッジベース (Bedrock KB x2 + S3 Vectors x2) ---
    const knowledgeBase = new KnowledgeBaseConstruct(this, 'KnowledgeBase', {
      maskedBucket: dataPipeline.maskedBucket,
      rawBucket: dataPipeline.rawBucket,
    });

    // --- AgentCore Runtime ---
    new AgentRuntimeConstruct(this, 'AgentRuntime', {
      userPool: auth.userPool,
      userPoolClient: auth.userPoolClient,
      maskedKbId: knowledgeBase.maskedKbId,
      rawKbId: knowledgeBase.rawKbId,
    });
  }
}
