const { z } = require("zod");
const { createApiError, ERROR_CODES } = require("../lib/errors");

const listQuerySchema = z
  .object({
    status: z.enum(["queued", "running", "done", "failed", "canceled"]).optional()
  })
  .passthrough();

function registerTaskRoutes(app, deps = {}) {
  const taskModeEnabled = Boolean(deps.taskModeEnabled);
  if (!taskModeEnabled) {
    return;
  }

  const taskService = deps.taskService;
  const asyncRoute = deps.asyncRoute;
  const validateBody = deps.validateBody;
  const validateParams = deps.validateParams;
  const validateQuery = deps.validateQuery;
  const schemas = deps.schemas;
  const v2Enabled = Boolean(deps.v2Enabled);

  app.post(
    "/api/tasks/usage-all",
    validateBody(schemas.taskSubmitBodySchema, deps.schemaValidationEnabled),
    asyncRoute(
      async (req) => {
        const files = Array.isArray(req.body?.files)
          ? req.body.files.map((item) => String(item || "").trim()).filter(Boolean)
          : undefined;
        const task = taskService.submitTask("usage-all", { files });
        return {
          taskId: task.id,
          task
        };
      },
      { status: 202, v2Enabled }
    )
  );

  app.post(
    "/api/tasks/verify-all",
    validateBody(schemas.taskSubmitBodySchema, deps.schemaValidationEnabled),
    asyncRoute(
      async (req) => {
        const files = Array.isArray(req.body?.files)
          ? req.body.files.map((item) => String(item || "").trim()).filter(Boolean)
          : undefined;
        const task = taskService.submitTask("verify-all", { files });
        return {
          taskId: task.id,
          task
        };
      },
      { status: 202, v2Enabled }
    )
  );

  app.get(
    "/api/tasks/:id",
    validateParams(schemas.taskIdParamsSchema, deps.schemaValidationEnabled),
    asyncRoute(async (req) => {
      const task = taskService.getTask(String(req.params.id || ""));
      if (!task) {
        throw createApiError(ERROR_CODES.INVALID_INPUT, "task not found", {
          status: 404,
          details: {
            taskId: req.params.id
          }
        });
      }
      return task;
    }, { v2Enabled })
  );

  app.get(
    "/api/tasks",
    validateQuery(listQuerySchema, deps.schemaValidationEnabled),
    asyncRoute(async (req) => {
      const status = String(req.query?.status || "").trim();
      const items = taskService.listTasks(status);
      return {
        count: items.length,
        tasks: items
      };
    }, { v2Enabled })
  );
}

module.exports = {
  registerTaskRoutes
};
