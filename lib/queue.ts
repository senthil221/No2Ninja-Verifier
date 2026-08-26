import { Queue } from "bullmq";
import IORedis from "ioredis";
import { config } from "./config";

const globalForRedis = globalThis as unknown as { redisConnection?: IORedis };

export const redisConnection =
  globalForRedis.redisConnection ??
  new IORedis(config.redisUrl, { maxRetriesPerRequest: null });

if (process.env.NODE_ENV !== "production") {
  globalForRedis.redisConnection = redisConnection;
}

export interface MtnVerifyJobData {
  listRowId: string;
  listId: string;
  email: string;
}

export interface N2bPollJobData {
  batchId: string;
}

export const mtnQueue = new Queue<MtnVerifyJobData>("mtn-verify", {
  connection: redisConnection,
});

export const n2bPollQueue = new Queue<N2bPollJobData>("n2b-poll", {
  connection: redisConnection,
});
