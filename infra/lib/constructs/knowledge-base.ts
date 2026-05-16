import { Construct } from 'constructs';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cdk from 'aws-cdk-lib';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as path from 'path';

// Titan Embeddings v2 は 1024 次元
const EMBEDDING_MODEL_ID = 'amazon.titan-embed-text-v2:0';
const EMBEDDING_DIMENSIONS = 1024;

export interface KnowledgeBaseConstructProps {
  maskedBucket: s3.IBucket;
  rawBucket: s3.IBucket;
}

export interface KnowledgeBaseResult {
  maskedKbId: string;
  rawKbId: string;
}

export class KnowledgeBaseConstruct extends Construct {
  readonly maskedKbId: string;
  readonly rawKbId: string;

  constructor(scope: Construct, id: string, props: KnowledgeBaseConstructProps) {
    super(scope, id);

    // S3 Vector Bucket x2
    const maskedVectorBucket = new s3vectors.CfnVectorBucket(this, 'MaskedVectorBucket', {
      vectorBucketName: `rag-masking-vectors-masked-${cdk.Aws.ACCOUNT_ID}`,
    });

    const rawVectorBucket = new s3vectors.CfnVectorBucket(this, 'RawVectorBucket', {
      vectorBucketName: `rag-masking-vectors-raw-${cdk.Aws.ACCOUNT_ID}`,
    });

    // S3 Vector Index x2 (Titan Embeddings v2 は 1024 次元 / cosine 類似度)
    const maskedVectorIndex = new s3vectors.CfnIndex(this, 'MaskedVectorIndex', {
      vectorBucketName: maskedVectorBucket.vectorBucketName,
      indexName: 'masked-index',
      dataType: 'float32',
      dimension: EMBEDDING_DIMENSIONS,
      distanceMetric: 'cosine',
    });
    maskedVectorIndex.addDependency(maskedVectorBucket);

    const rawVectorIndex = new s3vectors.CfnIndex(this, 'RawVectorIndex', {
      vectorBucketName: rawVectorBucket.vectorBucketName,
      indexName: 'raw-index',
      dataType: 'float32',
      dimension: EMBEDDING_DIMENSIONS,
      distanceMetric: 'cosine',
    });
    rawVectorIndex.addDependency(rawVectorBucket);

    // KB 実行ロール (Bedrock サービスが使うロール)
    const kbRole = new iam.Role(this, 'KbRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      inlinePolicies: {
        EmbeddingModelAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['bedrock:InvokeModel'],
              resources: [
                `arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/${EMBEDDING_MODEL_ID}`,
              ],
            }),
          ],
        }),
        DataSourceAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['s3:GetObject', 's3:ListBucket'],
              resources: [
                props.maskedBucket.bucketArn,
                props.maskedBucket.arnForObjects('*'),
                props.rawBucket.bucketArn,
                props.rawBucket.arnForObjects('*'),
              ],
            }),
          ],
        }),
        S3VectorsAccess: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                's3vectors:PutVectors',
                's3vectors:GetVectors',
                's3vectors:DeleteVectors',
                's3vectors:ListVectors',
                's3vectors:GetIndex',
                's3vectors:QueryVectors',
              ],
              resources: ['*'],
            }),
          ],
        }),
      },
    });

    // Bedrock Knowledge Base x2 (S3 Vector Index ARN を直接指定)
    const maskedKb = new bedrock.CfnKnowledgeBase(this, 'MaskedKb', {
      name: 'rag-masking-masked-kb',
      roleArn: kbRole.roleArn,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: `arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/${EMBEDDING_MODEL_ID}`,
        },
      },
      storageConfiguration: {
        type: 'S3_VECTORS',
        s3VectorsConfiguration: {
          indexArn: maskedVectorIndex.attrIndexArn,
        },
      },
    });
    maskedKb.addDependency(maskedVectorIndex);
    maskedKb.node.addDependency(kbRole);

    const rawKb = new bedrock.CfnKnowledgeBase(this, 'RawKb', {
      name: 'rag-masking-raw-kb',
      roleArn: kbRole.roleArn,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: `arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/${EMBEDDING_MODEL_ID}`,
        },
      },
      storageConfiguration: {
        type: 'S3_VECTORS',
        s3VectorsConfiguration: {
          indexArn: rawVectorIndex.attrIndexArn,
        },
      },
    });
    rawKb.addDependency(rawVectorIndex);
    rawKb.node.addDependency(kbRole);

    // DataSource x2 (各子S3をKBのデータソースとして登録)
    const maskedDs = new bedrock.CfnDataSource(this, 'MaskedDataSource', {
      knowledgeBaseId: maskedKb.attrKnowledgeBaseId,
      name: 'masked-s3-source',
      dataSourceConfiguration: {
        type: 'S3',
        s3Configuration: {
          bucketArn: props.maskedBucket.bucketArn,
        },
      },
      vectorIngestionConfiguration: {
        chunkingConfiguration: {
          chunkingStrategy: 'FIXED_SIZE',
          fixedSizeChunkingConfiguration: {
            maxTokens: 300,
            overlapPercentage: 10,
          },
        },
      },
    });

    const rawDs = new bedrock.CfnDataSource(this, 'RawDataSource', {
      knowledgeBaseId: rawKb.attrKnowledgeBaseId,
      name: 'raw-s3-source',
      dataSourceConfiguration: {
        type: 'S3',
        s3Configuration: {
          bucketArn: props.rawBucket.bucketArn,
        },
      },
      vectorIngestionConfiguration: {
        chunkingConfiguration: {
          chunkingStrategy: 'FIXED_SIZE',
          fixedSizeChunkingConfiguration: {
            maxTokens: 300,
            overlapPercentage: 10,
          },
        },
      },
    });

    this.maskedKbId = maskedKb.attrKnowledgeBaseId;
    this.rawKbId = rawKb.attrKnowledgeBaseId;

    // --- KB 同期 Lambda ---
    const kbSyncRole = new iam.Role(this, 'KbSyncRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    kbSyncRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:StartIngestionJob', 'bedrock:GetIngestionJob'],
      resources: [
        maskedKb.attrKnowledgeBaseArn,
        rawKb.attrKnowledgeBaseArn,
      ],
    }));

    const kbSyncFn = new lambda.Function(this, 'KbSync', {
      functionName: 'rag-masking-kb-sync',
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/kb-sync')),
      role: kbSyncRole,
      timeout: cdk.Duration.minutes(1),
      memorySize: 256,
      environment: {
        MASKED_KB_ID: maskedKb.attrKnowledgeBaseId,
        MASKED_DS_ID: maskedDs.attrDataSourceId,
        RAW_KB_ID: rawKb.attrKnowledgeBaseId,
        RAW_DS_ID: rawDs.attrDataSourceId,
        MASKED_BUCKET: props.maskedBucket.bucketName,
        RAW_BUCKET: props.rawBucket.bucketName,
      },
    });

    // 子S3 ObjectCreated → KB Sync Lambda
    props.maskedBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(kbSyncFn),
    );
    props.rawBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(kbSyncFn),
    );

    new cdk.CfnOutput(this, 'MaskedKbId', {
      value: maskedKb.attrKnowledgeBaseId,
      exportName: 'RagMaskingMaskedKbId',
    });
    new cdk.CfnOutput(this, 'RawKbId', {
      value: rawKb.attrKnowledgeBaseId,
      exportName: 'RagMaskingRawKbId',
    });
  }
}
