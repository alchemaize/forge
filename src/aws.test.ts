import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lambdaName, toLambdaArn, canonicalize } from './aws.js';

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
