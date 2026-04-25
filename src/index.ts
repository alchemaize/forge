/**
 * Forge — Direct AWS infrastructure management.
 * No stacks. No state files. No surprises.
 *
 * Programmatic API for use from deploy scripts or other tools.
 */

export { defineConfig } from './config.js';
export type { ForgeConfig } from './config.js';
export { initAwsContext } from './aws.js';
export type { AwsContext } from './aws.js';
export { plan, apply, status } from './engine.js';
export { importStack } from './import.js';
export { discoverApp } from './discover.js';
export { generateDiagram } from './diagram.js';

// Resource modules (for direct use in custom scripts)
export * as vpc from './resources/vpc.js';
export * as rds from './resources/rds.js';
export * as cognito from './resources/cognito.js';
export * as lambda from './resources/lambda.js';
export * as apiGateway from './resources/api-gateway.js';
export * as dynamodb from './resources/dynamodb.js';
export * as s3 from './resources/s3.js';
export * as ecsExpress from './resources/ecs-express.js';
