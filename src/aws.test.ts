import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lambdaName,
  toLambdaArn,
  canonicalize,
  templatizeName,
  withContext,
  ForgeError,
  ForgeRefusedError,
  ForgeDriftError,
  ForgeAwsError,
} from './aws.js';
import { fromIni } from '@aws-sdk/credential-providers';

const ctx = {
  profile: 'test',
  region: 'us-east-1',
  accountId: '123456789012',
  credentials: fromIni({ profile: 'test' }),
};

test('lambdaName: bare function name passes through', () => {
  assert.equal(lambdaName('myFunc'), 'myFunc');
});

test('lambdaName: full unversioned ARN extracts the name', () => {
  assert.equal(
    lambdaName('arn:aws:lambda:us-east-1:123456789012:function:myFunc'),
    'myFunc'
  );
});

test('lambdaName: versioned ARN does NOT return the version (regression test for the truncation bug)', () => {
  // Earlier implementation used split(':').pop() which returned "42" instead
  // of "myFunc" for versioned ARNs. Cognito stores trigger ARNs in this
  // form sometimes, so the import path then fed bogus function names back
  // into apply and caused ResourceNotFoundException at runtime.
  assert.equal(
    lambdaName('arn:aws:lambda:us-east-1:123456789012:function:myFunc:42'),
    'myFunc'
  );
});

test('lambdaName: aliased ARN extracts function name, not alias', () => {
  assert.equal(
    lambdaName('arn:aws:lambda:us-east-1:123456789012:function:myFunc:prod'),
    'myFunc'
  );
});

test('lambdaName: $LATEST version qualifier returns function name', () => {
  assert.equal(
    lambdaName('arn:aws:lambda:us-east-1:123456789012:function:myFunc:$LATEST'),
    'myFunc'
  );
});

test('lambdaName: empty / null / undefined return empty string', () => {
  assert.equal(lambdaName(''), '');
  assert.equal(lambdaName(undefined), '');
  assert.equal(lambdaName(null), '');
});

test('toLambdaArn: bare name becomes full ARN', () => {
  assert.equal(
    toLambdaArn('myFunc', 'us-east-1', '123456789012'),
    'arn:aws:lambda:us-east-1:123456789012:function:myFunc'
  );
});

test('toLambdaArn: existing ARN is idempotent (passes through)', () => {
  const arn = 'arn:aws:lambda:us-east-1:123456789012:function:myFunc';
  assert.equal(toLambdaArn(arn, 'us-east-1', '123456789012'), arn);
});

test('toLambdaArn: a versioned ARN passes through unchanged', () => {
  const versioned = 'arn:aws:lambda:us-east-1:123456789012:function:myFunc:42';
  assert.equal(
    toLambdaArn(versioned, 'us-east-1', '123456789012'),
    versioned
  );
});

test('lambdaName + toLambdaArn round-trip', () => {
  // Common usage: extract function name to compare config-vs-AWS, then
  // build full ARN to send to AWS in updates.
  const original = 'arn:aws:lambda:us-east-1:123456789012:function:myFunc';
  const name = lambdaName(original);
  const rebuilt = toLambdaArn(name, 'us-east-1', '123456789012');
  assert.equal(rebuilt, original);
});

// ---------------------------------------------------------------------------
// canonicalize
// ---------------------------------------------------------------------------

test('canonicalize: object key order does not affect output', () => {
  assert.equal(
    canonicalize({ b: 1, a: 2 }),
    canonicalize({ a: 2, b: 1 })
  );
});

test('canonicalize: deeply nested objects are sorted at every level', () => {
  const a = { z: { c: 1, a: 2 }, a: [3, 1, 2] };
  const b = { a: [3, 1, 2], z: { a: 2, c: 1 } };
  assert.equal(canonicalize(a), canonicalize(b));
});

test('canonicalize: array order IS preserved (lists are ordered)', () => {
  // We don't sort arrays — only object keys. A policy statement order
  // matters semantically, e.g., explicit Deny followed by Allow.
  assert.notEqual(canonicalize([1, 2, 3]), canonicalize([3, 2, 1]));
});

test('canonicalize: null and undefined collapse to "null"', () => {
  assert.equal(canonicalize(null), 'null');
  assert.equal(canonicalize(undefined), 'null');
});

test('canonicalize: primitives serialize as JSON', () => {
  assert.equal(canonicalize('hello'), '"hello"');
  assert.equal(canonicalize(42), '42');
  assert.equal(canonicalize(true), 'true');
  assert.equal(canonicalize(false), 'false');
});

test('canonicalize: handles IAM-policy-shaped documents', () => {
  // IAM policies are the main use case — drift detection on inline
  // and managed policies. Different field order shouldn't trigger
  // a spurious "policy changed" diff.
  const docA = {
    Version: '2012-10-17',
    Statement: [
      { Action: 'lambda:InvokeFunction', Effect: 'Allow', Resource: '*' },
    ],
  };
  const docB = {
    Statement: [
      { Effect: 'Allow', Resource: '*', Action: 'lambda:InvokeFunction' },
    ],
    Version: '2012-10-17',
  };
  assert.equal(canonicalize(docA), canonicalize(docB));
});

test('canonicalize: differing values produce different output', () => {
  assert.notEqual(canonicalize({ a: 1 }), canonicalize({ a: 2 }));
});

test('canonicalize: empty object and empty array are distinct', () => {
  assert.notEqual(canonicalize({}), canonicalize([]));
});

// ---------------------------------------------------------------------------
// templatizeName
// ---------------------------------------------------------------------------

test('templatizeName: replaces standalone account ID', () => {
  assert.equal(
    templatizeName('myapp-data-123456789012-us-east-1', ctx),
    'myapp-data-{account}-{region}'
  );
});

test('templatizeName: leaves coincidentally-matching digit substrings alone', () => {
  // The 12 digits of the account ID could theoretically appear inside a
  // longer numeric run (e.g. CFN-generated UUID suffixes). The regex
  // anchors on non-digit boundaries to avoid corrupting those.
  assert.equal(
    templatizeName('myapp-1234567890123', ctx),  // 13 digits, account is the first 12
    'myapp-1234567890123'
  );
});

test('templatizeName: account ID at start works', () => {
  assert.equal(
    templatizeName('123456789012-bucket', ctx),
    '{account}-bucket'
  );
});

test('templatizeName: replaces region when standalone', () => {
  assert.equal(
    templatizeName('lambda-us-east-1-foo', ctx),
    'lambda-{region}-foo'
  );
});

test('templatizeName: leaves region untouched inside compound names', () => {
  // 'us-east-1a' is an availability zone suffix; we don't want to
  // chop the trailing 'a'.
  assert.equal(
    templatizeName('lambda-us-east-1a-foo', ctx),
    'lambda-us-east-1a-foo'
  );
});

test('templatizeName: handles multiple account IDs in one string', () => {
  assert.equal(
    templatizeName('arn:aws:iam::123456789012:role/foo-123456789012', ctx),
    'arn:aws:iam::{account}:role/foo-{account}'
  );
});

// ---------------------------------------------------------------------------
// withContext
// ---------------------------------------------------------------------------

test('withContext: adds prefix and AccessDenied hint', () => {
  const err = new Error('User is not authorized');
  (err as { name?: string }).name = 'AccessDeniedException';
  const wrapped = withContext('[lambda] creating myFunc', err);
  assert.match(wrapped.message, /\[lambda\] creating myFunc/);
  assert.match(wrapped.message, /Hint:.*permissions/);
});

test('withContext: ExpiredToken hint mentions sso login', () => {
  const err = new Error('Token has expired');
  (err as { name?: string }).name = 'ExpiredTokenException';
  const wrapped = withContext('[apply] phase', err);
  assert.match(wrapped.message, /sso login/);
});

test('withContext: passes through unhinted errors with prefix only', () => {
  const err = new Error('Some weird internal error');
  (err as { name?: string }).name = 'WeirdInternalError';
  const wrapped = withContext('[apply] foo', err);
  assert.equal(wrapped.message, '[apply] foo: Some weird internal error');
});

test('withContext: handles non-Error values', () => {
  const wrapped = withContext('[apply] foo', 'a string thrown directly');
  assert.equal(wrapped.message, '[apply] foo: a string thrown directly');
});

// ---------------------------------------------------------------------------
// Error class hierarchy
// ---------------------------------------------------------------------------

test('ForgeError hierarchy: all subclasses are instanceof ForgeError', () => {
  const refused = new ForgeRefusedError('refused');
  const drift = new ForgeDriftError('drift');
  const aws = new ForgeAwsError('aws', 'AccessDeniedException');
  assert.ok(refused instanceof ForgeError);
  assert.ok(drift instanceof ForgeError);
  assert.ok(aws instanceof ForgeError);
});

test('ForgeError hierarchy: subclasses preserve their distinct name', () => {
  assert.equal(new ForgeError('x').name, 'ForgeError');
  assert.equal(new ForgeRefusedError('x').name, 'ForgeRefusedError');
  assert.equal(new ForgeDriftError('x').name, 'ForgeDriftError');
  assert.equal(new ForgeAwsError('x', 'AccessDeniedException').name, 'ForgeAwsError');
});

test('ForgeAwsError: preserves the AWS error name and original cause', () => {
  const original = new Error('AWS exploded');
  (original as { name?: string }).name = 'ThrottlingException';
  const wrapped = new ForgeAwsError('forge wrapped: AWS exploded', 'ThrottlingException', original);
  assert.equal(wrapped.awsErrorName, 'ThrottlingException');
  assert.strictEqual((wrapped as { cause?: unknown }).cause, original);
});

test('withContext returns a ForgeAwsError', () => {
  const original = new Error('access denied');
  (original as { name?: string }).name = 'AccessDeniedException';
  const wrapped = withContext('[lambda]', original);
  assert.ok(wrapped instanceof ForgeAwsError);
  assert.ok(wrapped instanceof ForgeError);
  assert.equal(wrapped.awsErrorName, 'AccessDeniedException');
});

// ---------------------------------------------------------------------------
// Cost estimator
// ---------------------------------------------------------------------------

import { estimatePlanCost } from './cost.js';
import { createPlan, addChange } from './diff.js';

test('cost estimator: empty plan produces $0 net', () => {
  const plan = createPlan();
  const estimate = estimatePlanCost(plan);
  assert.equal(estimate.createTotal, 0);
  assert.equal(estimate.destroyTotal, 0);
  assert.equal(estimate.netDelta, 0);
});

test('cost estimator: lambda create adds baseline cost', () => {
  const plan = createPlan();
  addChange(plan, {
    resourceType: 'lambda',
    resourceId: 'my-fn',
    changeType: 'create',
    tier: 'compute',
    fields: [],
  });
  const estimate = estimatePlanCost(plan);
  assert.ok(estimate.createTotal > 0);
  assert.equal(estimate.netDelta, estimate.createTotal);
  assert.equal(estimate.items.length, 1);
});

test('cost estimator: net delta = create - destroy', () => {
  const plan = createPlan();
  addChange(plan, {
    resourceType: 'rds',
    resourceId: 'new-db',
    changeType: 'create',
    tier: 'data',
    fields: [{ field: 'mode', current: undefined, desired: 'aurora-serverless-v2' }],
  });
  addChange(plan, {
    resourceType: 'rds',
    resourceId: 'old-db',
    changeType: 'destroy',
    tier: 'data',
    fields: [],
  });
  const estimate = estimatePlanCost(plan);
  assert.equal(estimate.netDelta, estimate.createTotal - estimate.destroyTotal);
  // Aurora Serverless v2 baseline ≈ $43, so delta should be ~0 when
  // creating + destroying one each.
  assert.ok(Math.abs(estimate.netDelta) < 5);
});

test('cost estimator: unknown resource types are reported, not silently dropped', () => {
  const plan = createPlan();
  addChange(plan, {
    resourceType: 'totally-made-up-resource',
    resourceId: 'foo',
    changeType: 'create',
    tier: 'compute',
    fields: [],
  });
  const estimate = estimatePlanCost(plan);
  assert.deepEqual(estimate.unknownTypes, ['totally-made-up-resource']);
  assert.equal(estimate.createTotal, 0);
});

test('cost estimator: provisioned bedrock throughput uses model unit count', () => {
  const plan = createPlan();
  addChange(plan, {
    resourceType: 'bedrock-throughput',
    resourceId: 'bedrock-1',
    changeType: 'create',
    tier: 'compute',
    fields: [{ field: 'modelUnits', current: undefined, desired: 2 }],
  });
  const estimate = estimatePlanCost(plan);
  // 2 units × $39.60/hr × 730hr ≈ $57,816/mo (this is the eye-watering AWS reality)
  assert.ok(estimate.createTotal > 50000);
});

test('cost estimator: unchanged changes are excluded from totals', () => {
  const plan = createPlan();
  addChange(plan, {
    resourceType: 'lambda',
    resourceId: 'my-fn',
    changeType: 'unchanged',
    tier: 'compute',
    fields: [],
  });
  addChange(plan, {
    resourceType: 'rds',
    resourceId: 'my-db',
    changeType: 'update',
    tier: 'data',
    fields: [],
  });
  const estimate = estimatePlanCost(plan);
  assert.equal(estimate.createTotal, 0);
  assert.equal(estimate.destroyTotal, 0);
  assert.equal(estimate.items.length, 0);
});
