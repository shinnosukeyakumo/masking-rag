#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { RagMaskingStack } from '../lib/rag-masking-stack';

const app = new cdk.App();

new RagMaskingStack(app, 'RagMaskingStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-west-2',
  },
  tags: {
    Project: 'rag-masking',
  },
});
