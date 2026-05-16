import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as cdk from 'aws-cdk-lib';

export interface AuthConstructProps {}

export class AuthConstruct extends Construct {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, _props: AuthConstructProps = {}) {
    super(scope, id);

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'rag-masking-users',
      selfSignUpEnabled: true, // 検証用: UI からサインアップ可能
      signInAliases: { email: true },
      autoVerify: { email: true }, // メール認証コードで自動検証
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Amplify / フロントエンド向けアプリクライアント
    this.userPoolClient = this.userPool.addClient('WebClient', {
      userPoolClientName: 'rag-masking-web',
      authFlows: {
        userSrp: true,
      },
      generateSecret: false,
      // access token に cognito:groups クレームが含まれるよう読み取り属性を設定
      readAttributes: new cognito.ClientAttributes().withStandardAttributes({
        email: true,
      }),
    });

    // 役職グループ: 一般職
    new cognito.CfnUserPoolGroup(this, 'GeneralGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'general',
      description: '一般職ユーザー: マスキング済みデータのみ参照可',
    });

    // 役職グループ: 管理職
    new cognito.CfnUserPoolGroup(this, 'ManagerGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'manager',
      description: '管理職ユーザー: 非マスキングデータを参照可',
    });

    // スタック出力
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      exportName: 'RagMaskingUserPoolId',
    });
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      exportName: 'RagMaskingUserPoolClientId',
    });
  }
}
