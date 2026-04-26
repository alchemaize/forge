/**
 * Forge diagram — generates professional AWS architecture diagrams.
 *
 * Follows AWS Architecture Diagram Guidelines:
 * - Official AWS icon set via mingrammer/diagrams library
 * - Proper boundary grouping: AWS Cloud → Region → VPC → Subnets
 * - Service scope awareness: S3/Cognito/CloudWatch are regional (outside VPC),
 *   Lambda/RDS/Proxy are VPC-scoped (inside VPC)
 * - Numbered callouts for data flow
 * - Consistent edge colors: purple=auth, red=API, orange=async, gray=observability
 * - Landscape and portrait orientation support
 * - Large readable fonts (12pt nodes, 16pt clusters, 20pt title)
 *
 * Prerequisites:
 *   pip3 install diagrams
 *   brew install graphviz
 */

import { writeFileSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import type { ForgeConfig } from './config.js';

export type DiagramOrientation = 'landscape' | 'portrait';

// ---------------------------------------------------------------------------
// Node and edge model
// ---------------------------------------------------------------------------

interface DiagramNode {
  id: string;
  importModule: string;
  className: string;
  label: string;
  /** Where this node lives in the AWS boundary hierarchy */
  scope: 'external' | 'regional' | 'vpc' | 'public-subnet' | 'private-subnet';
}

interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
  color: string;
  style: 'solid' | 'dashed' | 'dotted';
  penwidth?: string;
  fontsize?: string;
  /** Numbered callout (1, 2, 3...) */
  callout?: number;
}

// AWS-official edge color palette
const EDGE_COLORS = {
  auth: '#8E44AD',       // Purple — authentication flows
  api: '#E74C3C',        // Red — API/data traffic
  data: '#232F3E',       // AWS dark — primary data flow
  async: '#F39C12',      // Orange — async/scheduled
  deploy: '#27AE60',     // Green — deployment pipelines
  observe: '#95A5A6',    // Gray — logging/monitoring
  cdn: '#1ABC9C',        // Teal — CDN/static content
};

// ---------------------------------------------------------------------------
// Build nodes from config — scope-aware placement
// ---------------------------------------------------------------------------

function buildNodes(config: ForgeConfig): DiagramNode[] {
  const nodes: DiagramNode[] = [];
  const app = config.app;
  const hasVpc = !!config.vpc;

  // --- External ---
  // Users node is handled separately in the script

  // --- Regional services (outside VPC) ---

  if (config.cognito) {
    const cognitoConfigs = Array.isArray(config.cognito) ? config.cognito : [config.cognito];
    const poolCount = cognitoConfigs.length;
    const methods: string[] = [];
    // Collect auth methods from all pools
    for (const pool of cognitoConfigs) {
      if (pool.emailSignup && !methods.includes('Email/Password')) methods.push('Email/Password');
      if (pool.appleSignIn && !methods.includes('Apple Sign In')) methods.push('Apple Sign In');
      if (pool.googleSignIn && !methods.includes('Google')) methods.push('Google');
    }
    nodes.push({
      id: 'cognito',
      importModule: 'diagrams.aws.security',
      className: 'Cognito',
      label: `Cognito\\n${poolCount} User Pool${poolCount > 1 ? 's' : ''}\\n${methods.join(', ') || 'Email/Password'}`,
      scope: 'regional',
    });
  }

  if (config.apiGateway) {
    const routeCount = (config.apiGateway.publicRoutes?.length ?? 0) + (config.apiGateway.catchAll !== false ? 5 : 0);
    nodes.push({
      id: 'apigw',
      importModule: 'diagrams.aws.network',
      className: 'APIGateway',
      label: `API Gateway HTTP\\n${routeCount} Routes\\nJWT Authorizer`,
      scope: 'regional',
    });
  }

  // S3 is regional, not VPC-scoped
  for (const bucket of config.s3 ?? []) {
    const shortName = bucket.name
      .replace(`${app}-`, '')
      .replace(/\{account\}-?\{region\}/, '')
      .replace(/-$/, '')
      .replace(/^-/, '') || 'data';
    const idSafe = shortName.replace(/[^a-zA-Z0-9]/g, '_');
    nodes.push({
      id: `s3_${idSafe}`,
      importModule: 'diagrams.aws.storage',
      className: 'S3',
      label: `S3\\n${shortName}`,
      scope: 'regional',
    });
  }

  // ECR is regional
  for (const ecr of config.ecr ?? []) {
    const idSafe = ecr.name.replace(/[^a-zA-Z0-9]/g, '_');
    nodes.push({
      id: `ecr_${idSafe}`,
      importModule: 'diagrams.aws.compute',
      className: 'ECR',
      label: `ECR\\n${ecr.name}`,
      scope: 'regional',
    });
  }

  // CloudWatch is regional
  nodes.push({
    id: 'cloudwatch',
    importModule: 'diagrams.aws.management',
    className: 'Cloudwatch',
    label: 'CloudWatch\\nLogs & Metrics',
    scope: 'regional',
  });

  // Secrets Manager is regional
  if (config.rds) {
    nodes.push({
      id: 'secrets',
      importModule: 'diagrams.aws.security',
      className: 'SecretsManager',
      label: 'Secrets Manager\\nDB Credentials',
      scope: 'regional',
    });
  }

  // EventBridge is regional
  if (config.eventbridge?.length) {
    nodes.push({
      id: 'eventbridge',
      importModule: 'diagrams.aws.integration',
      className: 'Eventbridge',
      label: `EventBridge\\n${config.eventbridge.length} Rule${config.eventbridge.length > 1 ? 's' : ''}`,
      scope: 'regional',
    });
  }

  // CloudFront is regional (edge service)
  for (const cf of config.cloudfront ?? []) {
    const idSafe = cf.name.replace(/[^a-zA-Z0-9]/g, '_');
    nodes.push({
      id: `cloudfront_${idSafe}`,
      importModule: 'diagrams.aws.network',
      className: 'CloudFront',
      label: `CloudFront\\n${cf.name}`,
      scope: 'regional',
    });
  }

  // Step Functions is regional
  for (const sf of config.stepFunctions ?? []) {
    const idSafe = sf.name.replace(/[^a-zA-Z0-9]/g, '_');
    nodes.push({
      id: `sfn_${idSafe}`,
      importModule: 'diagrams.aws.integration',
      className: 'StepFunctions',
      label: `Step Functions\\n${sf.name.replace(`${app}-`, '')}\\n${sf.type ?? 'STANDARD'}`,
      scope: 'regional',
    });
  }

  // SQS is regional
  for (const q of config.sqs ?? []) {
    const idSafe = q.name.replace(/[^a-zA-Z0-9]/g, '_');
    nodes.push({
      id: `sqs_${idSafe}`,
      importModule: 'diagrams.aws.integration',
      className: 'SQS',
      label: `SQS\\n${q.name.replace(`${app}-`, '')}`,
      scope: 'regional',
    });
  }

  // SNS is regional
  for (const topic of config.sns ?? []) {
    const idSafe = topic.name.replace(/[^a-zA-Z0-9]/g, '_');
    nodes.push({
      id: `sns_${idSafe}`,
      importModule: 'diagrams.aws.integration',
      className: 'SNS',
      label: `SNS\\n${topic.displayName ?? topic.name.replace(`${app}-`, '')}`,
      scope: 'regional',
    });
  }

  // --- VPC-scoped services ---

  // Lambda functions go in private subnets if VPC-enabled
  for (const fn of config.lambda ?? []) {
    const shortName = fn.name
      .replace(`${app}-`, '')
      .replace(new RegExp(`^${app}`, 'i'), '')
      .replace(/^-/, '') || fn.name;
    const idSafe = fn.name.replace(/[^a-zA-Z0-9]/g, '_');

    // Determine label details
    const details: string[] = [];
    if (fn.handler && fn.handler !== 'index.handler') details.push(fn.handler);
    if (fn.memory && fn.memory !== 512) details.push(`${fn.memory} MB`);

    const labelParts = [shortName, `Lambda (${fn.runtime ?? 'nodejs20.x'})`];
    if (details.length) labelParts.push(details.join(' / '));

    nodes.push({
      id: `lambda_${idSafe}`,
      importModule: 'diagrams.aws.compute',
      className: 'Lambda',
      label: labelParts.join('\\n'),
      scope: fn.vpc && hasVpc ? 'private-subnet' : 'regional',
    });
  }

  // ECS Express goes in public subnets
  for (const ecs of config.ecsExpress ?? []) {
    const idSafe = ecs.name.replace(/[^a-zA-Z0-9]/g, '_');
    nodes.push({
      id: `ecs_${idSafe}`,
      importModule: 'diagrams.aws.compute',
      className: 'ECS',
      label: `ECS Express Mode\\n${ecs.name}\\n${ecs.cpu ?? 512} CPU / ${ecs.memory ?? 1024} MB`,
      scope: hasVpc ? 'public-subnet' : 'regional',
    });
  }

  // RDS Proxy in private subnets
  if (config.rds?.proxy !== false && config.rds?.mode === 'aurora-serverless-v2') {
    nodes.push({
      id: 'rds_proxy',
      importModule: 'diagrams.aws.database',
      className: 'RDS',
      label: 'RDS Proxy\\nConnection Pooling\\nTLS Required',
      scope: hasVpc ? 'private-subnet' : 'regional',
    });
  }

  // Aurora / RDS in isolated subnets
  if (config.rds) {
    if (config.rds.mode === 'aurora-serverless-v2') {
      nodes.push({
        id: 'aurora',
        importModule: 'diagrams.aws.database',
        className: 'Aurora',
        label: `Aurora Serverless v2\\nPostgreSQL ${config.rds.engineVersion ?? '16.4'}\\n${config.rds.dbName}${config.rds.pgvector ? ' + pgvector' : ''}`,
        scope: hasVpc ? 'private-subnet' : 'regional',
      });
    } else {
      nodes.push({
        id: 'rds_instance',
        importModule: 'diagrams.aws.database',
        className: 'RDS',
        label: `RDS PostgreSQL ${config.rds.engineVersion ?? '15'}\\n${config.rds.dbName}\\n${config.rds.instanceClass ?? 'db.t4g.micro'}`,
        scope: hasVpc ? 'private-subnet' : 'regional',
      });
    }
  }

  // ElastiCache Redis in isolated subnets
  if (config.elasticache) {
    nodes.push({
      id: 'elasticache',
      importModule: 'diagrams.aws.database',
      className: 'ElastiCache',
      label: `ElastiCache\\n${(config.elasticache.engine ?? 'Redis').charAt(0).toUpperCase() + (config.elasticache.engine ?? 'redis').slice(1)}\\n${config.elasticache.nodeType ?? 'cache.t3.micro'}${config.elasticache.transitEncryption !== false ? '\\nTLS + AUTH' : ''}`,
      scope: hasVpc && config.elasticache.vpc !== false ? 'private-subnet' : 'regional',
    });
  }

  // DynamoDB is regional (serverless, no VPC)
  if (config.dynamodb?.length) {
    const tableNames = config.dynamodb
      .map(t => t.name.replace(`${app}-`, ''))
      .slice(0, 5)  // Cap at 5 to keep label readable
      .join(', ');
    const extra = config.dynamodb.length > 5 ? ` +${config.dynamodb.length - 5} more` : '';
    nodes.push({
      id: 'dynamodb',
      importModule: 'diagrams.aws.database',
      className: 'Dynamodb',
      label: `DynamoDB\\n${config.dynamodb.length} Table${config.dynamodb.length > 1 ? 's' : ''}\\n${tableNames}${extra}`,
      scope: 'regional',
    });
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// Build edges with numbered callouts
// ---------------------------------------------------------------------------

function buildEdges(config: ForgeConfig, nodes: DiagramNode[]): DiagramEdge[] {
  const edges: DiagramEdge[] = [];
  const nodeIds = new Set(nodes.map(n => n.id));
  const has = (id: string) => nodeIds.has(id);
  let callout = 1;

  // 1. Users → Cognito (authentication)
  if (has('cognito')) {
    edges.push({
      from: 'users', to: 'cognito',
      label: `${callout}. Authenticate`,
      color: EDGE_COLORS.auth, style: 'dashed', callout: callout++,
    });
  }

  // 2. Users → API Gateway (API requests)
  if (has('apigw')) {
    edges.push({
      from: 'users', to: 'apigw',
      label: `${callout}. API Request (JWT)`,
      color: EDGE_COLORS.api, style: 'solid', callout: callout++,
    });
  }

  // 2b. Users → ECS Express (HTTPS)
  for (const ecs of config.ecsExpress ?? []) {
    const ecsId = `ecs_${ecs.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
    if (has(ecsId)) {
      edges.push({
        from: 'users', to: ecsId,
        label: `${callout}. HTTPS`,
        color: EDGE_COLORS.cdn, style: 'solid', callout: callout++,
      });
    }
  }

  // 3. API Gateway → Lambda functions
  for (const fn of config.lambda ?? []) {
    const lambdaId = `lambda_${fn.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
    if (has('apigw') && has(lambdaId)) {
      edges.push({
        from: 'apigw', to: lambdaId,
        color: EDGE_COLORS.data, style: 'solid',
      });
    }
  }

  // 4. Lambda → RDS Proxy → Aurora (data path)
  const primaryLambda = config.lambda?.[0];
  if (primaryLambda) {
    const primaryId = `lambda_${primaryLambda.name.replace(/[^a-zA-Z0-9]/g, '_')}`;

    if (has('rds_proxy') && has('aurora')) {
      edges.push({ from: primaryId, to: 'rds_proxy', color: EDGE_COLORS.data, style: 'solid' });
      edges.push({ from: 'rds_proxy', to: 'aurora', color: EDGE_COLORS.data, style: 'solid' });
    } else if (has('aurora')) {
      edges.push({ from: primaryId, to: 'aurora', color: EDGE_COLORS.data, style: 'solid' });
    } else if (has('rds_instance')) {
      edges.push({ from: primaryId, to: 'rds_instance', color: EDGE_COLORS.data, style: 'solid' });
    }

    // Lambda → DynamoDB
    if (has('dynamodb')) {
      edges.push({ from: primaryId, to: 'dynamodb', color: EDGE_COLORS.data, style: 'solid' });
    }

    // Lambda → S3
    for (const bucket of config.s3 ?? []) {
      const shortName = bucket.name.replace(`${config.app}-`, '').replace(/\{account\}-?\{region\}/, '').replace(/-$/, '').replace(/^-/, '') || 'data';
      const s3Id = `s3_${shortName.replace(/[^a-zA-Z0-9]/g, '_')}`;
      if (has(s3Id)) {
        edges.push({ from: primaryId, to: s3Id, color: EDGE_COLORS.data, style: 'solid' });
      }
    }
  }

  // ECS Express → data stores
  for (const ecs of config.ecsExpress ?? []) {
    const ecsId = `ecs_${ecs.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
    if (!has(ecsId)) continue;

    if (has('dynamodb')) {
      edges.push({ from: ecsId, to: 'dynamodb', color: EDGE_COLORS.data, style: 'solid' });
    }
    if (has('rds_proxy')) {
      edges.push({ from: ecsId, to: 'rds_proxy', color: EDGE_COLORS.data, style: 'solid' });
    } else if (has('aurora')) {
      edges.push({ from: ecsId, to: 'aurora', color: EDGE_COLORS.data, style: 'solid' });
    }
    for (const bucket of config.s3 ?? []) {
      const shortName = bucket.name.replace(`${config.app}-`, '').replace(/\{account\}-?\{region\}/, '').replace(/-$/, '').replace(/^-/, '') || 'data';
      const s3Id = `s3_${shortName.replace(/[^a-zA-Z0-9]/g, '_')}`;
      if (has(s3Id)) {
        edges.push({ from: ecsId, to: s3Id, color: EDGE_COLORS.data, style: 'solid' });
      }
    }
  }

  // ECR → ECS Express (deploy pipeline)
  for (const ecr of config.ecr ?? []) {
    const ecrId = `ecr_${ecr.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
    for (const ecs of config.ecsExpress ?? []) {
      const ecsId = `ecs_${ecs.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
      if (has(ecrId) && has(ecsId)) {
        edges.push({ from: ecrId, to: ecsId, label: 'Deploy', color: EDGE_COLORS.deploy, style: 'dashed' });
      }
    }
  }

  // EventBridge → Lambda (async/scheduled)
  if (has('eventbridge')) {
    for (const rule of config.eventbridge ?? []) {
      const targetId = `lambda_${rule.targetLambda.replace(/[^a-zA-Z0-9]/g, '_')}`;
      if (has(targetId)) {
        edges.push({ from: 'eventbridge', to: targetId, label: rule.schedule ?? 'Event', color: EDGE_COLORS.async, style: 'dashed' });
      }
    }
  }

  // Cognito triggers → Lambda (multi-pool aware)
  if (config.cognito) {
    const cognitoConfigs = Array.isArray(config.cognito) ? config.cognito : [config.cognito];
    for (const pool of cognitoConfigs) {
      if (pool.triggers) {
        for (const fnName of [pool.triggers.preTokenGeneration, pool.triggers.postConfirmation, pool.triggers.preSignUp].filter(Boolean) as string[]) {
          const targetId = `lambda_${fnName.replace(/[^a-zA-Z0-9]/g, '_')}`;
          if (has('cognito') && has(targetId)) {
            edges.push({ from: 'cognito', to: targetId, label: 'Trigger', color: EDGE_COLORS.async, style: 'dashed' });
          }
        }
      }
    }
  }

  // CloudFront → S3 (CDN serving static content)
  for (const cf of config.cloudfront ?? []) {
    const cfId = `cloudfront_${cf.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
    if (!has(cfId)) continue;

    // Users → CloudFront
    edges.push({ from: 'users', to: cfId, label: 'HTTPS', color: EDGE_COLORS.cdn, style: 'solid' });

    // CloudFront → S3 origin
    if (cf.s3Origin) {
      const originShort = cf.s3Origin
        .replace(`${config.app}-`, '')
        .replace(/\{account\}-?\{region\}/, '')
        .replace(/-\d+$/, '')  // strip account ID suffix
        .replace(/-$/, '')
        .replace(/^-/, '') || 'data';
      const s3Id = `s3_${originShort.replace(/[^a-zA-Z0-9]/g, '_')}`;
      if (has(s3Id)) {
        edges.push({ from: cfId, to: s3Id, label: 'OAC', color: EDGE_COLORS.cdn, style: 'solid' });
      }
    }
  }

  // Step Functions → Lambda (invocations)
  for (const sf of config.stepFunctions ?? []) {
    const sfId = `sfn_${sf.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
    if (!has(sfId)) continue;

    // Find target Lambda by name match or DLQ reference
    for (const fn of config.lambda ?? []) {
      const lambdaId = `lambda_${fn.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
      // Connect to Lambdas that share the app prefix (likely invoked by the state machine)
      if (has(lambdaId) && fn.name.includes('title')) {
        edges.push({ from: sfId, to: lambdaId, label: 'Invoke', color: EDGE_COLORS.async, style: 'solid' });
      }
    }

    // Step Functions → SQS DLQ
    if (sf.dlqName) {
      const dlqId = `sqs_${sf.dlqName.replace(/[^a-zA-Z0-9]/g, '_')}`;
      if (has(dlqId)) {
        edges.push({ from: sfId, to: dlqId, label: 'Failed', color: EDGE_COLORS.api, style: 'dashed' });
      }
    }
  }

  // Lambda → ElastiCache (data path)
  if (has('elasticache') && primaryLambda) {
    const primaryId = `lambda_${primaryLambda.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
    edges.push({ from: primaryId, to: 'elasticache', color: EDGE_COLORS.data, style: 'solid' });
  }

  // SNS ← CloudWatch (alarm actions)
  for (const topic of config.sns ?? []) {
    const snsId = `sns_${topic.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
    if (has(snsId) && has('cloudwatch')) {
      edges.push({ from: 'cloudwatch', to: snsId, label: 'Alarm', color: EDGE_COLORS.observe, style: 'dashed' });
    }
  }

  // Observability edges (dotted gray — secondary, don't clutter)
  const computeNodes = nodes.filter(n =>
    n.id.startsWith('lambda_') || n.id.startsWith('ecs_')
  );
  // Only connect the primary compute node to observability to avoid clutter
  if (computeNodes.length > 0 && has('cloudwatch')) {
    edges.push({ from: computeNodes[0].id, to: 'cloudwatch', color: EDGE_COLORS.observe, style: 'dotted' });
  }
  if (computeNodes.length > 0 && has('secrets')) {
    edges.push({ from: computeNodes[0].id, to: 'secrets', color: EDGE_COLORS.observe, style: 'dotted' });
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Python script generation — AWS-standard boundary grouping
// ---------------------------------------------------------------------------

function generatePythonScript(
  config: ForgeConfig,
  outputFile: string,
  orientation: DiagramOrientation
): string {
  const nodes = buildNodes(config);
  const edges = buildEdges(config, nodes);
  const hasVpc = !!config.vpc;
  const isLandscape = orientation === 'landscape';

  // Collect imports
  const imports = new Map<string, Set<string>>();
  imports.set('diagrams', new Set(['Diagram', 'Cluster', 'Edge']));
  imports.set('diagrams.aws.general', new Set(['Users']));
  for (const node of nodes) {
    if (!imports.has(node.importModule)) imports.set(node.importModule, new Set());
    imports.get(node.importModule)!.add(node.className);
  }

  const L: string[] = [];  // lines
  L.push('#!/usr/bin/env python3');
  L.push('"""');
  L.push(`${config.app} — AWS Architecture Diagram`);
  L.push('Auto-generated by forge diagram. Follows AWS Architecture Diagram Guidelines.');
  L.push('"""');
  L.push('');

  for (const [mod, classes] of imports) {
    L.push(`from ${mod} import ${[...classes].join(', ')}`);
  }
  L.push('');

  // ── Style constants ──
  // AWS uses #232F3E (Squid Ink) as the primary dark color
  // Boundary boxes follow the AWS icon set color conventions
  L.push('# AWS Architecture Diagram style constants');
  L.push('# Colors from the official AWS Architecture Icon set');
  L.push('CLOUD_BOX = {');
  L.push('    "bgcolor": "#FAFAFA",');
  L.push('    "style": "rounded",');
  L.push('    "pencolor": "#232F3E",');
  L.push('    "penwidth": "2.5",');
  L.push('    "fontsize": "18",');
  L.push('    "fontname": "Helvetica Neue,Helvetica,Arial,sans-serif",');
  L.push('    "fontcolor": "#232F3E",');
  L.push('}');
  L.push('');
  L.push('REGION_BOX = {');
  L.push('    "bgcolor": "#F2F8FD",');
  L.push('    "style": "rounded",');
  L.push('    "pencolor": "#147EBA",');
  L.push('    "penwidth": "2",');
  L.push('    "fontsize": "16",');
  L.push('    "fontname": "Helvetica Neue,Helvetica,Arial,sans-serif",');
  L.push('    "fontcolor": "#147EBA",');
  L.push('}');
  L.push('');
  L.push('VPC_BOX = {');
  L.push('    "bgcolor": "#E8F5E9",');
  L.push('    "style": "rounded",');
  L.push('    "pencolor": "#1B660F",');
  L.push('    "penwidth": "2",');
  L.push('    "fontsize": "15",');
  L.push('    "fontname": "Helvetica Neue,Helvetica,Arial,sans-serif",');
  L.push('    "fontcolor": "#1B660F",');
  L.push('}');
  L.push('');
  L.push('PUBLIC_SUBNET = {');
  L.push('    "bgcolor": "#E8F8F5",');
  L.push('    "style": "rounded",');
  L.push('    "pencolor": "#1ABC9C",');
  L.push('    "penwidth": "1.5",');
  L.push('    "fontsize": "13",');
  L.push('    "fontname": "Helvetica Neue,Helvetica,Arial,sans-serif",');
  L.push('    "fontcolor": "#117A65",');
  L.push('}');
  L.push('');
  L.push('PRIVATE_SUBNET = {');
  L.push('    "bgcolor": "#EBF5FB",');
  L.push('    "style": "rounded",');
  L.push('    "pencolor": "#2E86C1",');
  L.push('    "penwidth": "1.5",');
  L.push('    "fontsize": "13",');
  L.push('    "fontname": "Helvetica Neue,Helvetica,Arial,sans-serif",');
  L.push('    "fontcolor": "#1A5276",');
  L.push('}');
  L.push('');

  // ── Diagram setup ──
  const outBase = outputFile.replace(/\.png$/, '');
  const direction = isLandscape ? 'LR' : 'TB';
  const size = isLandscape ? '28,16!' : '18,28!';
  const ratio = isLandscape ? '0.56' : '0.65';
  const title = `${config.app}  \\u2014  AWS Architecture  |  Alchemaize, Inc.`;

  L.push(`with Diagram(`);
  L.push(`    "",`);
  L.push(`    filename="${outBase}",`);
  L.push(`    show=False,`);
  L.push(`    direction="${direction}",`);
  L.push(`    outformat="png",`);
  L.push(`    graph_attr={`);
  L.push(`        "fontsize": "24",`);
  L.push(`        "fontname": "Helvetica Neue,Helvetica,Arial,sans-serif",`);
  L.push(`        "bgcolor": "white",`);
  L.push(`        "pad": "0.8",`);
  L.push(`        "nodesep": "0.8",`);
  L.push(`        "ranksep": "1.0",`);
  L.push(`        "dpi": "200",`);
  L.push(`        "labelloc": "t",`);
  L.push(`        "labeljust": "c",`);
  L.push(`        "ratio": "${ratio}",`);
  L.push(`        "size": "${size}",`);
  L.push(`        "label": "${title}",`);
  L.push(`        "fontcolor": "#232F3E",`);
  L.push(`    },`);
  L.push(`    edge_attr={`);
  L.push(`        "color": "#545B64",`);
  L.push(`        "penwidth": "1.5",`);
  L.push(`        "fontname": "Helvetica Neue,Helvetica,Arial,sans-serif",`);
  L.push(`        "fontsize": "11",`);
  L.push(`        "fontcolor": "#545B64",`);
  L.push(`    },`);
  L.push(`    node_attr={`);
  L.push(`        "fontsize": "12",`);
  L.push(`        "fontname": "Helvetica Neue,Helvetica,Arial,sans-serif",`);
  L.push(`        "fontcolor": "#232F3E",`);
  L.push(`        "width": "2.0",`);
  L.push(`        "height": "2.0",`);
  L.push(`    },`);
  L.push(`):`);
  L.push('');

  // ── Users (external) ──
  L.push('    users = Users("Users")');
  L.push('');

  // ── AWS Cloud boundary ──
  const region = config.region ?? 'us-east-1';
  L.push(`    with Cluster("AWS Cloud", graph_attr=CLOUD_BOX):`);
  L.push(`        with Cluster("Region: ${region}", graph_attr=REGION_BOX):`);
  L.push('');

  // Regional services (outside VPC)
  const regionalNodes = nodes.filter(n => n.scope === 'regional');
  if (regionalNodes.length > 0) {
    L.push('            # Regional services');
    for (const node of regionalNodes) {
      L.push(`            ${node.id} = ${node.className}("${node.label}")`);
    }
    L.push('');
  }

  // VPC boundary (if applicable)
  const vpcNodes = nodes.filter(n =>
    n.scope === 'vpc' || n.scope === 'public-subnet' || n.scope === 'private-subnet'
  );

  if (hasVpc && vpcNodes.length > 0) {
    const vpcCidr = config.vpc?.cidr ?? (config.vpc?.vpcId ?? '');
    const vpcLabel = config.vpc?.mode === 'lookup'
      ? `VPC (${config.vpc.vpcId})`
      : `VPC (${vpcCidr})`;

    L.push(`            with Cluster("${vpcLabel}", graph_attr=VPC_BOX):`);

    // Public subnet nodes
    const publicNodes = vpcNodes.filter(n => n.scope === 'public-subnet');
    if (publicNodes.length > 0) {
      L.push(`                with Cluster("Public Subnets", graph_attr=PUBLIC_SUBNET):`);
      for (const node of publicNodes) {
        L.push(`                    ${node.id} = ${node.className}("${node.label}")`);
      }
      L.push('');
    }

    // Private subnet nodes
    const privateNodes = vpcNodes.filter(n => n.scope === 'private-subnet');
    if (privateNodes.length > 0) {
      L.push(`                with Cluster("Private Subnets", graph_attr=PRIVATE_SUBNET):`);
      for (const node of privateNodes) {
        L.push(`                    ${node.id} = ${node.className}("${node.label}")`);
      }
      L.push('');
    }

    // Generic VPC nodes (no specific subnet)
    const genericVpcNodes = vpcNodes.filter(n => n.scope === 'vpc');
    for (const node of genericVpcNodes) {
      L.push(`                ${node.id} = ${node.className}("${node.label}")`);
    }
  } else if (vpcNodes.length > 0) {
    // No VPC config but some nodes are VPC-scoped — just place them in region
    for (const node of vpcNodes) {
      L.push(`            ${node.id} = ${node.className}("${node.label}")`);
    }
  }

  L.push('');

  // ── Edges ──
  L.push('    # Data flow');
  for (const edge of edges) {
    const args: string[] = [];
    if (edge.label) args.push(`label="${edge.label}"`);
    args.push(`color="${edge.color}"`);
    if (edge.style !== 'solid') args.push(`style="${edge.style}"`);
    args.push(`fontsize="10"`);

    L.push(`    ${edge.from} >> Edge(${args.join(', ')}) >> ${edge.to}`);
  }

  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function generateDiagram(
  config: ForgeConfig,
  outputPath?: string,
  orientation: DiagramOrientation = 'landscape'
): Promise<string> {
  const outFile = outputPath ?? `${config.app}-architecture.png`;
  const tmpScript = `/tmp/forge-diagram-${config.app}-${Date.now()}.py`;

  console.log(`\nForge: generating architecture diagram for '${config.app}'\n`);

  // Check prerequisites
  try {
    execSync('python3 -c "import diagrams"', { stdio: 'pipe' });
  } catch {
    throw new Error(
      'Python diagrams library not found.\n' +
      'Install: pip3 install diagrams\n' +
      'Also requires Graphviz: brew install graphviz'
    );
  }

  // Count resources
  const counts = {
    lambda: config.lambda?.length ?? 0,
    dynamodb: config.dynamodb?.length ?? 0,
    s3: config.s3?.length ?? 0,
    ecr: config.ecr?.length ?? 0,
    ecs: config.ecsExpress?.length ?? 0,
    eventbridge: config.eventbridge?.length ?? 0,
    cloudfront: config.cloudfront?.length ?? 0,
    stepFunctions: config.stepFunctions?.length ?? 0,
    sqs: config.sqs?.length ?? 0,
  };
  const cognitoConfigs = config.cognito
    ? (Array.isArray(config.cognito) ? config.cognito : [config.cognito])
    : [];
  const features = [
    cognitoConfigs.length ? `Cognito (${cognitoConfigs.length} pool${cognitoConfigs.length > 1 ? 's' : ''})` : '',
    config.rds ? (config.rds.mode === 'aurora-serverless-v2' ? 'Aurora' : 'RDS') : '',
    config.rds?.proxy !== false && config.rds?.mode === 'aurora-serverless-v2' ? 'Proxy' : '',
    config.elasticache ? 'ElastiCache' : '',
    config.apiGateway ? 'API GW' : '',
    config.vpc ? 'VPC' : '',
  ].filter(Boolean);

  console.log(`  Orientation: ${orientation}`);
  console.log(`  Resources:   ${counts.lambda} Lambda, ${counts.dynamodb} DynamoDB, ${counts.s3} S3, ${counts.ecr} ECR, ${counts.ecs} ECS, ${counts.eventbridge} EventBridge, ${counts.cloudfront} CloudFront, ${counts.stepFunctions} StepFunctions, ${counts.sqs} SQS`);
  console.log(`  Services:    ${features.join(', ')}`);
  console.log('');

  // Generate Python script
  const script = generatePythonScript(config, outFile, orientation);
  writeFileSync(tmpScript, script, 'utf-8');

  // Run it
  try {
    execSync(`python3 '${tmpScript}'`, { stdio: 'inherit', cwd: process.cwd() });
  } catch {
    console.error(`  Script saved at: ${tmpScript}`);
    throw new Error('Diagram generation failed. Check the Python script for errors.');
  }

  // Cleanup
  try { unlinkSync(tmpScript); } catch { /* ignore */ }

  console.log(`  Generated: ${outFile}`);
  console.log('');

  return outFile;
}
