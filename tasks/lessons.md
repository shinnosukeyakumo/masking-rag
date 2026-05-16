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

