/**
 * Forge diagram — generates an AWS architecture diagram from a forge config.
 *
 * Uses the Python `diagrams` library (mingrammer/diagrams) which renders
 * via Graphviz. Forge generates a temporary Python script from the config,
 * runs it, and produces a PNG.
 *
 * Prerequisites:
 *   pip3 install diagrams
 *   brew install graphviz  (or apt-get install graphviz)
 *
 * Usage:
 *   forge diagram --config myapp.forge.config.ts
 *   forge diagram --config myapp.forge.config.ts --output myapp-architecture.png
 */

import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname, basename } from 'path';
import type { ForgeConfig } from './config.js';

// ---------------------------------------------------------------------------
// Map forge resource types to diagrams library node types
// ---------------------------------------------------------------------------

interface DiagramNode {
  id: string;
  importPath: string;
  className: string;
  label: string;
  cluster: 'app' | 'control' | 'data';
}

function buildNodes(config: ForgeConfig): DiagramNode[] {
  const nodes: DiagramNode[] = [];
  const app = config.app;

  // API Gateway
  if (config.apiGateway) {
    nodes.push({
      id: 'apigw',
      importPath: 'diagrams.aws.network',
      className: 'APIGateway',
      label: `API Gateway v2\\nHTTP API\\n(JWT Authorizer)`,
      cluster: 'app',
    });
  }

  // Lambda functions
  for (const fn of config.lambda ?? []) {
    const shortName = fn.name.replace(`${app}-`, '').replace(app, '');
    const cleanName = shortName || fn.name;
    const idSafe = fn.name.replace(/[^a-zA-Z0-9]/g, '_');
    nodes.push({
      id: `lambda_${idSafe}`,
      importPath: 'diagrams.aws.compute',
      className: 'Lambda',
      label: `${cleanName}\\nLambda\\n(${fn.runtime ?? 'nodejs20.x'})`,
      cluster: 'app',
    });
  }

  // RDS / Aurora
  if (config.rds) {
    if (config.rds.mode === 'aurora-serverless-v2') {
      nodes.push({
        id: 'aurora',
        importPath: 'diagrams.aws.database',
        className: 'Aurora',
        label: `Aurora Serverless v2\\nPostgreSQL ${config.rds.engineVersion ?? '16.4'}\\n${config.rds.dbName}`,
        cluster: 'data',
      });
      if (config.rds.proxy !== false) {
        nodes.push({
          id: 'rds_proxy',
          importPath: 'diagrams.aws.database',
          className: 'RDS',
          label: 'RDS Proxy\\n(TLS)',
          cluster: 'data',
        });
      }
    } else {
      nodes.push({
        id: 'rds_instance',
        importPath: 'diagrams.aws.database',
        className: 'RDS',
        label: `RDS PostgreSQL\\n${config.rds.engineVersion ?? '15'}\\n${config.rds.dbName}`,
        cluster: 'data',
      });
    }
  }

  // DynamoDB tables
  if (config.dynamodb?.length) {
    const tableNames = config.dynamodb.map(t => t.name.replace(`${app}-`, '')).join('\\n');
    nodes.push({
      id: 'dynamodb',
      importPath: 'diagrams.aws.database',
      className: 'Dynamodb',
      label: `DynamoDB\\n(${config.dynamodb.length} Tables)\\n${tableNames}`,
      cluster: 'data',
    });
  }

  // S3 buckets
  for (const bucket of config.s3 ?? []) {
    const shortName = bucket.name
      .replace(`${app}-`, '')
      .replace('{account}-{region}', '')
      .replace(/-$/, '') || 'data';
    const idSafe = shortName.replace(/[^a-zA-Z0-9]/g, '_');
    nodes.push({
      id: `s3_${idSafe}`,
      importPath: 'diagrams.aws.storage',
      className: 'S3',
      label: `S3\\n(${shortName})`,
      cluster: 'data',
    });
  }

  // Cognito
  if (config.cognito) {
    const authMethods: string[] = [];
    if (config.cognito.emailSignup) authMethods.push('Email/Password');
    if (config.cognito.appleSignIn) authMethods.push('Apple');
    if (config.cognito.googleSignIn) authMethods.push('Google');
    nodes.push({
      id: 'cognito',
      importPath: 'diagrams.aws.security',
      className: 'Cognito',
      label: `Cognito User Pool\\n(${authMethods.join(' + ') || 'Email/Password'})`,
      cluster: 'control',
    });
  }

  // ECR + ECS Express
  for (const ecs of config.ecsExpress ?? []) {
    nodes.push({
      id: `ecs_${ecs.name.replace(/[^a-zA-Z0-9]/g, '_')}`,
      importPath: 'diagrams.aws.compute',
      className: 'ECS',
      label: `ECS Express Mode\\n${ecs.name}\\n(${ecs.cpu ?? 512} CPU / ${ecs.memory ?? 1024} MB)`,
      cluster: 'app',
    });
  }

  for (const ecr of config.ecr ?? []) {
    nodes.push({
      id: `ecr_${ecr.name.replace(/[^a-zA-Z0-9]/g, '_')}`,
      importPath: 'diagrams.aws.compute',
      className: 'ECS',
      label: `ECR\\n${ecr.name}`,
      cluster: 'control',
    });
  }

  // EventBridge
  if (config.eventbridge?.length) {
    nodes.push({
      id: 'eventbridge',
      importPath: 'diagrams.aws.integration',
      className: 'Eventbridge',
      label: `EventBridge\\n(${config.eventbridge.length} Rules)`,
      cluster: 'control',
    });
  }

  // Always add CloudWatch and Secrets Manager
  nodes.push({
    id: 'cloudwatch',
    importPath: 'diagrams.aws.management',
    className: 'Cloudwatch',
    label: 'CloudWatch Logs',
    cluster: 'control',
  });

  if (config.rds) {
    nodes.push({
      id: 'secrets',
      importPath: 'diagrams.aws.security',
      className: 'SecretsManager',
      label: 'Secrets Manager',
      cluster: 'control',
    });
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// Build edges (connections between resources)
// ---------------------------------------------------------------------------

interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
  color?: string;
  style?: string;
}

function buildEdges(config: ForgeConfig, nodes: DiagramNode[]): DiagramEdge[] {
  const edges: DiagramEdge[] = [];
  const nodeIds = new Set(nodes.map(n => n.id));
  const has = (id: string) => nodeIds.has(id);

  // Users → Cognito (auth)
  if (has('cognito')) {
    edges.push({ from: 'users', to: 'cognito', label: 'Auth', color: '#8E44AD', style: 'dashed' });
  }

  // Users → API Gateway or ECS Express
  if (has('apigw')) {
    edges.push({ from: 'users', to: 'apigw', label: 'API (JWT)', color: '#E74C3C' });
  }
  for (const ecs of config.ecsExpress ?? []) {
    const ecsId = `ecs_${ecs.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
    if (has(ecsId)) {
      edges.push({ from: 'users', to: ecsId, label: 'HTTPS', color: '#1ABC9C' });
    }
  }

  // API Gateway → Lambda functions
  for (const fn of config.lambda ?? []) {
    const lambdaId = `lambda_${fn.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
    if (has('apigw') && has(lambdaId)) {
      edges.push({ from: 'apigw', to: lambdaId });
    }
  }

  // Lambda → RDS Proxy → Aurora (or Lambda → RDS directly)
  const firstLambda = config.lambda?.[0];
  if (firstLambda) {
    const firstLambdaId = `lambda_${firstLambda.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
    if (has('rds_proxy') && has('aurora')) {
      edges.push({ from: firstLambdaId, to: 'rds_proxy' });
      edges.push({ from: 'rds_proxy', to: 'aurora' });
    } else if (has('aurora')) {
      edges.push({ from: firstLambdaId, to: 'aurora' });
    } else if (has('rds_instance')) {
      edges.push({ from: firstLambdaId, to: 'rds_instance' });
    }

    // Lambda → DynamoDB
    if (has('dynamodb')) {
      edges.push({ from: firstLambdaId, to: 'dynamodb' });
    }

    // Lambda → CloudWatch (dotted)
    if (has('cloudwatch')) {
      edges.push({ from: firstLambdaId, to: 'cloudwatch', color: '#95A5A6', style: 'dotted' });
    }

    // Lambda → Secrets Manager (dotted)
    if (has('secrets')) {
      edges.push({ from: firstLambdaId, to: 'secrets', color: '#95A5A6', style: 'dotted' });
    }
  }

  // ECS Express → DynamoDB / S3
  for (const ecs of config.ecsExpress ?? []) {
    const ecsId = `ecs_${ecs.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
    if (has('dynamodb')) {
      edges.push({ from: ecsId, to: 'dynamodb' });
    }
    for (const s3 of config.s3 ?? []) {
      const s3Id = `s3_${(s3.name.replace(`${config.app}-`, '').replace('{account}-{region}', '').replace(/-$/, '') || 'data').replace(/[^a-zA-Z0-9]/g, '_')}`;
      if (has(s3Id)) {
        edges.push({ from: ecsId, to: s3Id });
      }
    }
    if (has('cloudwatch')) {
      edges.push({ from: ecsId, to: 'cloudwatch', color: '#95A5A6', style: 'dotted' });
    }
  }

  // ECR → ECS Express (deploy)
  for (const ecr of config.ecr ?? []) {
    const ecrId = `ecr_${ecr.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
    for (const ecs of config.ecsExpress ?? []) {
      const ecsId = `ecs_${ecs.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
      if (has(ecrId) && has(ecsId)) {
        edges.push({ from: ecrId, to: ecsId, label: 'Deploy', color: '#F39C12', style: 'dashed' });
      }
    }
  }

  // EventBridge → Lambda (scheduler)
  if (has('eventbridge')) {
    for (const rule of config.eventbridge ?? []) {
      const targetId = `lambda_${rule.targetLambda.replace(/[^a-zA-Z0-9]/g, '_')}`;
      if (has(targetId)) {
        edges.push({ from: 'eventbridge', to: targetId, label: 'Schedule', color: '#F39C12', style: 'dashed' });
      }
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Generate Python script
// ---------------------------------------------------------------------------

function generatePythonScript(config: ForgeConfig, outputFile: string): string {
  const nodes = buildNodes(config);
  const edges = buildEdges(config, nodes);

  // Collect unique imports
  const imports = new Map<string, Set<string>>();
  imports.set('diagrams', new Set(['Diagram', 'Cluster', 'Edge']));
  imports.set('diagrams.aws.general', new Set(['Users']));
  for (const node of nodes) {
    if (!imports.has(node.importPath)) imports.set(node.importPath, new Set());
    imports.get(node.importPath)!.add(node.className);
  }

  const lines: string[] = [];
  lines.push('#!/usr/bin/env python3');
  lines.push('"""Auto-generated by forge diagram. Do not edit."""');
  lines.push('');

  // Imports
  for (const [path, classes] of imports) {
    lines.push(`from ${path} import ${[...classes].join(', ')}`);
  }
  lines.push('');

  // Style constants (matching Alchemaize Catalyst style)
  lines.push('ACCOUNT_BOX = {');
  lines.push('    "bgcolor": "#F7F9FA", "style": "rounded", "pencolor": "#232F3E",');
  lines.push('    "penwidth": "2.5", "fontsize": "13", "fontname": "Helvetica-Bold", "fontcolor": "#232F3E",');
  lines.push('}');
  lines.push('APP_PLANE = {');
  lines.push('    "bgcolor": "#E8F8F5", "style": "rounded", "pencolor": "#1ABC9C",');
  lines.push('    "penwidth": "2", "fontsize": "14", "fontname": "Helvetica-Bold", "fontcolor": "#117A65",');
  lines.push('}');
  lines.push('DATA_PLANE = {');
  lines.push('    "bgcolor": "#FEF9E7", "style": "rounded", "pencolor": "#F39C12",');
  lines.push('    "penwidth": "2", "fontsize": "14", "fontname": "Helvetica-Bold", "fontcolor": "#7D6608",');
  lines.push('}');
  lines.push('CTRL_PLANE = {');
  lines.push('    "bgcolor": "#EBF5FB", "style": "rounded", "pencolor": "#2E86C1",');
  lines.push('    "penwidth": "2", "fontsize": "14", "fontname": "Helvetica-Bold", "fontcolor": "#1A5276",');
  lines.push('}');
  lines.push('');

  // Remove .png extension from output for diagrams library (it adds it)
  const outBase = outputFile.replace(/\.png$/, '');
  const title = `${config.app} — Architecture Diagram  |  Alchemaize, Inc.  |  AWS Account (${config.region ?? 'us-east-1'})`;

  lines.push(`with Diagram(`);
  lines.push(`    "",`);
  lines.push(`    filename="${outBase}",`);
  lines.push(`    show=False,`);
  lines.push(`    direction="TB",`);
  lines.push(`    outformat="png",`);
  lines.push(`    graph_attr={`);
  lines.push(`        "fontsize": "22", "fontname": "Helvetica-Bold", "bgcolor": "white",`);
  lines.push(`        "pad": "0.6", "nodesep": "1.0", "ranksep": "0.9", "dpi": "150",`);
  lines.push(`        "labelloc": "t", "labeljust": "c", "ratio": "0.6", "size": "24,14!",`);
  lines.push(`        "label": "${title}",`);
  lines.push(`    },`);
  lines.push(`    edge_attr={"color": "#545B64", "penwidth": "1.3"},`);
  lines.push(`    node_attr={"fontsize": "10", "fontname": "Helvetica", "width": "1.8", "height": "1.8"},`);
  lines.push(`):`);

  // Users node
  lines.push(`    users = Users("Users")`);
  lines.push('');

  // Account cluster
  lines.push(`    with Cluster("AWS Account (${config.region ?? 'us-east-1'})  —  Profile: ${config.profile}", graph_attr=ACCOUNT_BOX):`);

  // Application Plane
  const appNodes = nodes.filter(n => n.cluster === 'app');
  if (appNodes.length > 0) {
    lines.push(`        with Cluster("APPLICATION PLANE", graph_attr=APP_PLANE):`);
    for (const node of appNodes) {
      lines.push(`            ${node.id} = ${node.className}("${node.label}")`);
    }
  }

  // Data Plane
  const dataNodes = nodes.filter(n => n.cluster === 'data');
  if (dataNodes.length > 0) {
    lines.push(`        with Cluster("DATA PLANE", graph_attr=DATA_PLANE):`);
    for (const node of dataNodes) {
      lines.push(`            ${node.id} = ${node.className}("${node.label}")`);
    }
  }

  // Control Plane
  const controlNodes = nodes.filter(n => n.cluster === 'control');
  if (controlNodes.length > 0) {
    lines.push(`        with Cluster("CONTROL PLANE", graph_attr=CTRL_PLANE):`);
    for (const node of controlNodes) {
      lines.push(`            ${node.id} = ${node.className}("${node.label}")`);
    }
  }

  lines.push('');

  // Edges
  for (const edge of edges) {
    const edgeArgs: string[] = [];
    if (edge.label) edgeArgs.push(`label="${edge.label}"`);
    if (edge.color) edgeArgs.push(`color="${edge.color}"`);
    if (edge.style) edgeArgs.push(`style="${edge.style}"`);
    edgeArgs.push('fontsize="9"');

    if (edgeArgs.length > 1) {
      lines.push(`    ${edge.from} >> Edge(${edgeArgs.join(', ')}) >> ${edge.to}`);
    } else {
      lines.push(`    ${edge.from} >> ${edge.to}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function generateDiagram(
  config: ForgeConfig,
  outputPath?: string
): Promise<string> {
  const outFile = outputPath ?? `${config.app}-architecture.png`;
  const tmpScript = `/tmp/forge-diagram-${config.app}.py`;

  console.log(`\nForge: generating architecture diagram for '${config.app}'\n`);

  // Check prerequisites
  try {
    execSync('python3 -c "import diagrams"', { stdio: 'pipe' });
  } catch {
    throw new Error(
      'Python diagrams library not found.\n' +
      'Install it: pip3 install diagrams\n' +
      'Also requires Graphviz: brew install graphviz'
    );
  }

  // Generate and write Python script
  const script = generatePythonScript(config, outFile);
  writeFileSync(tmpScript, script, 'utf-8');

  console.log(`  Resources: ${(config.lambda?.length ?? 0)} Lambda, ${(config.dynamodb?.length ?? 0)} DynamoDB, ${(config.s3?.length ?? 0)} S3, ${(config.ecr?.length ?? 0)} ECR, ${(config.ecsExpress?.length ?? 0)} ECS`);
  console.log(`  Config: ${config.cognito ? 'Cognito' : ''}${config.rds ? ' + RDS' : ''}${config.apiGateway ? ' + API GW' : ''}${config.vpc ? ' + VPC' : ''}`);
  console.log('');

  // Run the script
  try {
    execSync(`python3 '${tmpScript}'`, {
      stdio: 'inherit',
      cwd: process.cwd(),
    });
  } catch (err: any) {
    throw new Error(`Diagram generation failed. Check the Python script at ${tmpScript}`);
  }

  // Cleanup
  try { unlinkSync(tmpScript); } catch { /* ignore */ }

  console.log(`  Generated: ${outFile}`);
  console.log('');

  return outFile;
}
