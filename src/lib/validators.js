const { z } = require("zod");
const { createApiError, ERROR_CODES } = require("./errors");

const authFileNameSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[^/\\]+\.json$/i, "file must end with .json");

const importAccountBodySchema = z
  .object({
    raw: z.any().optional(),
    token: z.any().optional(),
    payload: z.any().optional(),
    mode: z.enum(["append", "replace-latest"]).optional(),
    targetFile: authFileNameSchema.optional()
  })
  .passthrough()
  .refine(
    (value) => [value.raw, value.token, value.payload].some((item) => String(item || "").trim().length > 0),
    {
      message: "raw/token/payload is required",
      path: ["raw"]
    }
  );

const verifyFileParamsSchema = z.object({
  file: authFileNameSchema
});

const emptyBodySchema = z.object({}).passthrough();

const taskSubmitBodySchema = z
  .object({
    files: z.array(authFileNameSchema).max(500).optional()
  })
  .passthrough();

const taskIdParamsSchema = z.object({
  id: z.string().trim().min(1)
});

const cleanupInvalidBodySchema = z
  .object({
    mode: z.enum(["dry-run", "apply"]).optional()
  })
  .passthrough();

function toIssueList(issues = []) {
  return issues.map((issue) => ({
    path: Array.isArray(issue.path) ? issue.path.join(".") : String(issue.path || ""),
    message: String(issue.message || "invalid value"),
    code: String(issue.code || "invalid")
  }));
}

function validateBySchema(schema, source, enabled) {
  return (req, _res, next) => {
    if (!enabled) {
      next();
      return;
    }

    const input = source === "params" ? req.params : source === "query" ? req.query : req.body;
    const result = schema.safeParse(input || {});
    if (result.success) {
      if (source === "params") {
        req.params = result.data;
      } else if (source === "query") {
        req.query = result.data;
      } else {
        req.body = result.data;
      }
      next();
      return;
    }

    next(
      createApiError(ERROR_CODES.INVALID_INPUT, "request validation failed", {
        status: 400,
        details: {
          source,
          issues: toIssueList(result.error.issues)
        }
      })
    );
  };
}

module.exports = {
  schemas: {
    importAccountBodySchema,
    verifyFileParamsSchema,
    verifyAllBodySchema: emptyBodySchema,
    cleanupInvalidBodySchema,
    taskSubmitBodySchema,
    taskIdParamsSchema
  },
  validateBody: (schema, enabled) => validateBySchema(schema, "body", enabled),
  validateParams: (schema, enabled) => validateBySchema(schema, "params", enabled),
  validateQuery: (schema, enabled) => validateBySchema(schema, "query", enabled),
  authFileNameSchema
};
