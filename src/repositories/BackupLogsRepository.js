// repositories/BackupLogsRepository.js
const knex = require("../database/knex");

class BackupLogsRepository {
  async createLog({ action_type, trigger_type, status, file_name, file_size, message }) {
    await knex('backup_logs').insert({
      action_type,
      trigger_type,
      status,
      file_name,
      file_size,
      message
    });
  }

  async getBackupLogs() {
    return await knex('backup_logs').orderBy("created_at", "desc");
  }
}

module.exports = BackupLogsRepository;
