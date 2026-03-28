const { createApiError, ERROR_CODES, normalizeUnknownError } = require("../lib/errors");

function nowIso() {
  return new Date().toISOString();
}

function computePercent(done, total) {
  const safeTotal = Number(total || 0);
  if (!safeTotal || safeTotal <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round((Number(done || 0) / safeTotal) * 100)));
}

function createTaskService(options = {}) {
  const store = options.store;
  const handlers = options.handlers || {};
  const concurrency = Math.max(1, Math.min(Number(options.concurrency || 1), 2));
  const queue = [];
  let running = 0;

  if (!store) {
    throw new Error("task service requires a store");
  }

  function buildTask(type, input) {
    const id = `task_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
    const task = {
      id,
      type,
      status: "queued",
      progress: {
        total: 0,
        done: 0,
        percent: 0
      },
      startedAt: "",
      endedAt: "",
      result: null,
      error: null,
      input: input || {}
    };
    return store.put(task);
  }

  function getTask(id) {
    return store.get(id);
  }

  function listTasks(status) {
    return store.list(status);
  }

  function setProgress(taskId, done, total) {
    const nextTotal = Math.max(0, Number(total || 0));
    const nextDone = Math.max(0, Math.min(Number(done || 0), nextTotal || Number(done || 0)));
    const current = store.get(taskId);
    if (!current) {
      return;
    }
    store.update(taskId, {
      progress: {
        total: nextTotal,
        done: nextDone,
        percent: computePercent(nextDone, nextTotal)
      }
    });
  }

  async function runTask(taskId) {
    const task = store.get(taskId);
    if (!task) {
      return;
    }

    const handler = handlers[task.type];
    if (typeof handler !== "function") {
      store.update(taskId, {
        status: "failed",
        startedAt: nowIso(),
        endedAt: nowIso(),
        error: {
          code: ERROR_CODES.INVALID_INPUT,
          message: `unknown task type: ${task.type}`,
          details: null
        }
      });
      return;
    }

    store.update(taskId, {
      status: "running",
      startedAt: nowIso(),
      endedAt: "",
      error: null
    });

    try {
      const context = {
        taskId,
        setProgress: (done, total) => setProgress(taskId, done, total)
      };

      const result = await handler(context, task.input || {});
      const lastTask = store.get(taskId);
      const total = Number(lastTask?.progress?.total || 0);
      const done = Number(lastTask?.progress?.done || 0);
      const finalizedDone = total > 0 ? Math.max(done, total) : done;
      setProgress(taskId, finalizedDone, total || finalizedDone);

      store.update(taskId, {
        status: "done",
        endedAt: nowIso(),
        result: result || {}
      });
    } catch (error) {
      const mapped = normalizeUnknownError(error);
      store.update(taskId, {
        status: "failed",
        endedAt: nowIso(),
        error: {
          code: mapped.code,
          message: mapped.message,
          details: mapped.details || null
        }
      });
    }
  }

  function schedule() {
    while (running < concurrency && queue.length > 0) {
      const taskId = queue.shift();
      running += 1;
      runTask(taskId)
        .catch(() => {})
        .finally(() => {
          running = Math.max(0, running - 1);
          schedule();
        });
    }
  }

  function submitTask(type, input) {
    const normalizedType = String(type || "").trim();
    if (!normalizedType) {
      throw createApiError(ERROR_CODES.INVALID_INPUT, "task type is required", { status: 400 });
    }
    const task = buildTask(normalizedType, input || {});
    queue.push(task.id);
    schedule();
    return task;
  }

  return {
    submitTask,
    getTask,
    listTasks
  };
}

module.exports = {
  createTaskService
};
