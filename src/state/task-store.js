function createTaskStore(maxItems = 500) {
  const tasks = new Map();
  const order = [];

  function put(task) {
    tasks.set(task.id, task);
    order.push(task.id);
    while (order.length > maxItems) {
      const oldestId = order.shift();
      if (oldestId) {
        tasks.delete(oldestId);
      }
    }
    return task;
  }

  function get(id) {
    return tasks.get(id) || null;
  }

  function list(status) {
    const normalized = String(status || "").trim().toLowerCase();
    const result = [];
    for (let i = order.length - 1; i >= 0; i -= 1) {
      const id = order[i];
      const task = tasks.get(id);
      if (!task) {
        continue;
      }
      if (normalized && String(task.status || "").toLowerCase() !== normalized) {
        continue;
      }
      result.push(task);
    }
    return result;
  }

  function update(id, patch) {
    const current = get(id);
    if (!current) {
      return null;
    }
    const next = {
      ...current,
      ...patch
    };
    tasks.set(id, next);
    return next;
  }

  return {
    put,
    get,
    list,
    update
  };
}

module.exports = {
  createTaskStore
};
