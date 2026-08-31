import { z } from "zod";

import { uuidV4Schema } from "../contracts.js";

export const projectNameSchema = z.string().max(100).transform((value) => value.trim()).pipe(
  z.string().min(1).max(100),
);
export const projectDescriptionSchema = z.string().max(500).transform((value) => value.trim()).nullable();

export const createProjectBodySchema = z.object({
  name: projectNameSchema,
  description: projectDescriptionSchema.default(null),
}).strict();

export const deleteProjectBodySchema = z.object({
  confirm_name: z.string().min(1).max(100),
}).strict();

export const projectPathSchema = z.object({
  projectId: uuidV4Schema,
}).strict();

export const projectIdempotencyKeySchema = uuidV4Schema;

export const projectListQuerySchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
}).strict();

export type CreateProjectBody = z.output<typeof createProjectBodySchema>;
export type DeleteProjectBody = z.output<typeof deleteProjectBodySchema>;
export type ProjectListQuery = z.output<typeof projectListQuerySchema>;
