const { normalizeUnknownError } = require("../lib/errors");

function createVerifyAllRunner(deps) {
  const loadAuthAccounts = deps.loadAuthAccounts;
  const verifyAuthAccountFile = deps.verifyAuthAccountFile;

  return async (context, input = {}) => {
    const accounts = await loadAuthAccounts();
    const requestedFiles = Array.isArray(input.files)
      ? input.files.map((item) => String(item || "").trim()).filter(Boolean)
      : [];

    const availableFiles = accounts
      .filter((item) => item?.file && !item.error && !item.disabled)
      .map((item) => item.file);

    const targetFiles = requestedFiles.length
      ? availableFiles.filter((fileName) => requestedFiles.includes(fileName))
      : availableFiles;
    const missingFiles = requestedFiles.length
      ? requestedFiles.filter((fileName) => !availableFiles.includes(fileName))
      : [];

    const verifications = [];
    const total = targetFiles.length + missingFiles.length;
    let done = 0;
    context.setProgress(done, total);

    for (const fileName of missingFiles) {
      verifications.push({
        file: fileName,
        ok: false,
        status: "missing-file",
        label: "文件不存在或不可用",
        detail: "该账号文件不存在、不可读或已被禁用",
        error: {
          code: "INVALID_INPUT",
          message: "requested file is not available",
          details: {
            file: fileName
          }
        }
      });
      done += 1;
      context.setProgress(done, total);
    }

    for (let index = 0; index < targetFiles.length; index += 1) {
      const fileName = targetFiles[index];
      try {
        // eslint-disable-next-line no-await-in-loop
        verifications.push(await verifyAuthAccountFile(fileName));
      } catch (error) {
        const mapped = normalizeUnknownError(error);
        verifications.push({
          file: fileName,
          ok: false,
          status: "request-failed",
          label: "验证失败",
          detail: mapped.message,
          error: {
            code: mapped.code,
            message: mapped.message,
            details: mapped.details || null
          }
        });
      }
      done += 1;
      context.setProgress(done, total);
    }

    const failed = verifications.filter((item) => !item?.ok);
    return {
      count: verifications.length,
      verifications,
      failedCount: failed.length,
      failed
    };
  };
}

module.exports = {
  createVerifyAllRunner
};
