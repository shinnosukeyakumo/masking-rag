import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cdk from 'aws-cdk-lib';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as path from 'path';

export interface DataPipelineConstructProps {}

export class DataPipelineConstruct extends Construct {
  readonly sourceBucket: s3.Bucket;
  readonly maskedBucket: s3.Bucket;
  readonly rawBucket: s3.Bucket;

  constructor(scope: Construct, id: string, _props: DataPipelineConstructProps = {}) {
    super(scope, id);

    // 親S3: ソースデータ投入用
    this.sourceBucket = new s3.Bucket(this, 'SourceBucket', {
      bucketName: `rag-masking-source-${cdk.Aws.ACCOUNT_ID}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'archive-old-versions',
          noncurrentVersionExpiration: cdk.Duration.days(90),
        },
      ],
    });

    // 子S3: マスキング済みデータ
    this.maskedBucket = new s3.Bucket(this, 'MaskedBucket', {
      bucketName: `rag-masking-masked-${cdk.Aws.ACCOUNT_ID}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // 子S3: 非マスキングデータ（原本コピー）
    this.rawBucket = new s3.Bucket(this, 'RawBucket', {
      bucketName: `rag-masking-raw-${cdk.Aws.ACCOUNT_ID}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // DLQ: PII処理失敗時のメッセージ保持
    const dlq = new sqs.Queue(this, 'PiiProcessorDlq', {
      queueName: 'rag-masking-pii-dlq',
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    // Lambda 実行ロール
    const piiRole = new iam.Role(this, 'PiiProcessorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    piiRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:GetObjectAttributes'],
      resources: [this.sourceBucket.arnForObjects('*')],
    }));
    piiRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [
        this.maskedBucket.arnForObjects('*'),
        this.rawBucket.arnForObjects('*'),
      ],
    }));
    piiRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'comprehend:DetectPiiEntities',
        'comprehend:ContainsPiiEntities',
      ],
      resources: ['*'],
    }));
    piiRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sqs:SendMessage'],
      resources: [dlq.queueArn],
    }));

    // PII 処理 Lambda
    const piiProcessor = new lambda.Function(this, 'PiiProcessor', {
      functionName: 'rag-masking-pii-processor',
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/pii-processor')),
      role: piiRole,
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: {
        MASKED_BUCKET: this.maskedBucket.bucketName,
        RAW_BUCKET: this.rawBucket.bucketName,
        REGION: cdk.Aws.REGION,
      },
      deadLetterQueue: dlq,
      retryAttempts: 2,
    });

    // 親S3 ObjectCreated → Lambda トリガー
    this.sourceBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(piiProcessor),
    );

    new cdk.CfnOutput(this, 'SourceBucketName', { value: this.sourceBucket.bucketName });
    new cdk.CfnOutput(this, 'MaskedBucketName', { value: this.maskedBucket.bucketName });
    new cdk.CfnOutput(this, 'RawBucketName', { value: this.rawBucket.bucketName });
  }
}
