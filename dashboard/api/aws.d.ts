// The AWS SDK comes with the Lambda runtime, so it is not a dependency here. These declare only what handler.ts calls.
declare module '@aws-sdk/client-dynamodb' {
  export class DynamoDBClient { constructor(c: Record<string, unknown>); }
}
declare module '@aws-sdk/lib-dynamodb' {
  import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
  export class DynamoDBDocumentClient { static from(c: DynamoDBClient, o?: Record<string, unknown>): DynamoDBDocumentClient; send(cmd: unknown): Promise<{ Item?: unknown }>; }
  export class GetCommand { constructor(i: { TableName: string; Key: Record<string, string> }); }
  export class PutCommand { constructor(i: { TableName: string; Item: Record<string, unknown> }); }
}
