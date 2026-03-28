function createLogOffsetStore() {
  const map = new Map();

  function get(key) {
    if (!map.has(key)) {
      map.set(key, {
        initialized: false,
        inode: 0,
        offset: 0,
        partialLine: "",
        recentLines: [],
        recentAlertLines: []
      });
    }
    return map.get(key);
  }

  function reset(key) {
    map.set(key, {
      initialized: false,
      inode: 0,
      offset: 0,
      partialLine: "",
      recentLines: [],
      recentAlertLines: []
    });
    return map.get(key);
  }

  return {
    get,
    reset
  };
}

module.exports = {
  createLogOffsetStore
};
