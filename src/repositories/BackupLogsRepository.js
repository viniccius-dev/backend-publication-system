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
}

module.exports = BackupLogsRepository;
